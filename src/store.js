// KV-backed webhook inbox.
//
// Layout
//   inbox:msg:<id>              JSON message { id, source, received_at, payload }
//   inbox:idx:<inv-ts>:<id>     empty value, metadata { id, source, received_at }
//
// `inv-ts` is (10^13 - received_at in ms), zero-padded, so a plain prefix
// `KV.list()` returns newest messages first. Every message has its own index
// key, so concurrent ingests can no longer overwrite each other's index entries
// (v0.1 kept a single read-modify-write `inbox:index` array, which lost entries
// under concurrency). An index entry is only trusted when the message it points
// to exists and has the same received_at, so stale/orphaned entries are skipped.

import { ToolError } from "./mcp.js";
import { byteLength } from "./http.js";

export const MSG_PREFIX = "inbox:msg:";
export const IDX_PREFIX = "inbox:idx:";
export const LEGACY_INDEX_KEY = "inbox:index";

export const LIMITS = Object.freeze({
  idBytes: 256,
  sourceChars: 200,
  messageBytes: 1024 * 1024,
  listDefault: 20,
  listMax: 100,
  minTtlSeconds: 60,
});

const MAX_TIME = 10 ** 13;
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
const MIGRATION_CONCURRENCY = 25;

export const messageKey = (id) => `${MSG_PREFIX}${id}`;

export function indexKey(id, receivedAt) {
  const ms = Date.parse(receivedAt);
  const inv = String(MAX_TIME - (Number.isFinite(ms) ? ms : 0)).padStart(13, "0");
  return `${IDX_PREFIX}${inv}:${id}`;
}

export function clampInt(value, min, max, fallback) {
  const n = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

export function makeId() {
  return crypto.randomUUID();
}

/** Validate a caller-supplied message id. Returns the trimmed id or "" when absent. */
export function parseId(value, { required = false, field = "id" } = {}) {
  if (value === undefined || value === null || value === "") {
    if (required) throw new ToolError("id_required", `'${field}' is required`);
    return "";
  }
  if (typeof value !== "string" && typeof value !== "number") {
    throw new ToolError("invalid_argument", `'${field}' must be a string`);
  }
  const id = String(value).trim();
  if (!id) {
    if (required) throw new ToolError("id_required", `'${field}' is required`);
    return "";
  }
  if (byteLength(id) > LIMITS.idBytes) {
    throw new ToolError("invalid_argument", `'${field}' exceeds ${LIMITS.idBytes} bytes`);
  }
  if (CONTROL_CHARS.test(id)) throw new ToolError("invalid_argument", `'${field}' contains control characters`);
  return id;
}

export function parseSource(value) {
  if (value === undefined || value === null || value === "") return "webhook";
  if (typeof value !== "string") throw new ToolError("invalid_argument", "'source' must be a string");
  const source = value.replace(/\s+/g, " ").trim();
  if (!source) return "webhook";
  if (source.length > LIMITS.sourceChars) {
    throw new ToolError("invalid_argument", `'source' exceeds ${LIMITS.sourceChars} characters`);
  }
  return source;
}

export function previewPayload(payload) {
  try {
    const s = JSON.stringify(payload);
    if (s === undefined) return "[unserializable-payload]";
    return s.length > 240 ? `${s.slice(0, 240)}…` : s;
  } catch {
    return "[unserializable-payload]";
  }
}

export function messageSummary(message) {
  return {
    id: message.id,
    source: message.source,
    received_at: message.received_at,
    payload_preview: previewPayload(message.payload),
  };
}

export async function getMessage(kv, id) {
  let raw;
  try {
    raw = await kv.get(messageKey(id), "json");
  } catch {
    return null; // corrupted value
  }
  return raw && typeof raw === "object" && !Array.isArray(raw) ? raw : null;
}

/**
 * Store a message. When `id` is given and a message with that id already
 * exists, the existing message is returned unchanged (idempotent retries).
 */
export async function storeMessage(kv, { payload, source, id: requestedId }, { ttlSeconds } = {}) {
  if (payload === undefined) throw new ToolError("missing_payload", "'payload' is required");
  const suppliedId = parseId(requestedId, { field: "message_id" });
  const src = parseSource(source);
  const id = suppliedId || makeId();

  if (suppliedId) {
    // Best-effort dedupe: KV has no compare-and-set, so two truly simultaneous
    // first deliveries may both write; the later one wins and list() skips the
    // stale index entry left by the other.
    const existing = await getMessage(kv, id);
    if (existing) return { message: existing, duplicate: true };
  }

  const message = { id, source: src, received_at: new Date().toISOString(), payload };
  const serialized = JSON.stringify(message);
  if (byteLength(serialized) > LIMITS.messageBytes) {
    throw new ToolError("payload_too_large", `message exceeds ${LIMITS.messageBytes} bytes`);
  }

  const putOptions = ttlSeconds ? { expirationTtl: ttlSeconds } : {};
  // Write the message before its index entry so the index never points at nothing.
  await kv.put(messageKey(id), serialized, putOptions);
  await kv.put(indexKey(id, message.received_at), "", {
    ...putOptions,
    metadata: { id, source: src, received_at: message.received_at },
  });
  return { message, duplicate: false };
}

// One-time, per-isolate migration of the v0.1 `inbox:index` array to per-message index keys.
const migrated = new WeakSet();

export async function migrateLegacyIndex(kv) {
  if (migrated.has(kv)) return;
  const legacy = await kv.get(LEGACY_INDEX_KEY, "json").catch(() => null);
  if (Array.isArray(legacy) && legacy.length) {
    const ids = [...new Set(legacy.map(String))];
    for (let i = 0; i < ids.length; i += MIGRATION_CONCURRENCY) {
      await Promise.all(
        ids.slice(i, i + MIGRATION_CONCURRENCY).map(async (id) => {
          const msg = await getMessage(kv, id);
          if (!msg) return;
          // Deterministic key: concurrent migrations write identical entries.
          await kv.put(indexKey(msg.id, msg.received_at), "", {
            metadata: { id: msg.id, source: msg.source, received_at: msg.received_at },
          });
        }),
      );
    }
  }
  if (legacy !== null) await kv.delete(LEGACY_INDEX_KEY);
  migrated.add(kv);
}

export async function listMessages(kv, { limit, cursor } = {}) {
  const safeLimit = clampInt(limit, 1, LIMITS.listMax, LIMITS.listDefault);
  if (cursor !== undefined && cursor !== null && typeof cursor !== "string") {
    throw new ToolError("invalid_argument", "'cursor' must be a string");
  }
  await migrateLegacyIndex(kv);

  const items = [];
  const seen = new Set();
  let next = cursor || undefined;
  let complete = false;
  // Keep paging while stale entries leave the page short (bounded to avoid runaway scans).
  for (let page = 0; page < 5 && items.length < safeLimit; page++) {
    let listed;
    try {
      listed = await kv.list({ prefix: IDX_PREFIX, limit: safeLimit - items.length, cursor: next });
    } catch (err) {
      if (next) throw new ToolError("invalid_cursor", "cursor is invalid or expired");
      throw err;
    }
    const keys = listed.keys || [];
    const messages = await Promise.all(
      keys.map((k) => {
        const id = k.metadata?.id ?? k.name.slice(IDX_PREFIX.length + 14);
        return seen.has(id) ? null : getMessage(kv, id);
      }),
    );
    keys.forEach((k, i) => {
      const msg = messages[i];
      if (!msg || seen.has(msg.id) || indexKey(msg.id, msg.received_at) !== k.name) return;
      seen.add(msg.id);
      items.push(messageSummary(msg));
    });
    if (listed.list_complete || !listed.cursor) {
      complete = true;
      break;
    }
    next = listed.cursor;
  }

  return {
    total_returned: items.length,
    limit: safeLimit,
    items,
    next_cursor: complete ? null : next,
  };
}

export async function deleteMessage(kv, id) {
  const existing = await getMessage(kv, id);
  if (!existing) {
    // Remove a corrupted value if one exists, but still report not_found.
    if ((await kv.get(messageKey(id))) !== null) await kv.delete(messageKey(id));
    return { ok: false, id, deleted: false, not_found: true };
  }
  await Promise.all([kv.delete(messageKey(id)), kv.delete(indexKey(existing.id, existing.received_at))]);
  return { ok: true, id, deleted: true };
}
