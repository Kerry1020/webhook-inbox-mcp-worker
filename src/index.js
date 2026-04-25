var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// src/index.js
var SERVER_NAME = "webhook-inbox-mcp-worker";
var SERVER_VERSION = "0.1.0";
var INDEX_KEY = "inbox:index";
var MAX_INDEX_SIZE = 200;
var TOOLS = [
  {
    name: "ingest_webhook",
    description: "Store a JSON webhook payload into the inbox.",
    inputSchema: {
      type: "object",
      properties: {
        payload: {},
        source: { type: "string" },
        message_id: { type: "string" }
      },
      required: ["payload"],
      additionalProperties: false
    }
  },
  {
    name: "list_messages",
    description: "List recent inbox messages.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "integer", default: 20 }
      },
      additionalProperties: false
    }
  },
  {
    name: "get_message",
    description: "Read a single inbox message by id.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" }
      },
      required: ["id"],
      additionalProperties: false
    }
  },
  {
    name: "delete_message",
    description: "Delete a single inbox message by id.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" }
      },
      required: ["id"],
      additionalProperties: false
    }
  }
];
function corsHeaders(extra = {}) {
  return {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
    "access-control-allow-headers": "content-type, mcp-session-id, x-webhook-source, x-idempotency-key",
    ...extra
  };
}
__name(corsHeaders, "corsHeaders");
function json(data, status = 200, extraHeaders = {}) {
  return Response.json(data, { status, headers: corsHeaders(extraHeaders) });
}
__name(json, "json");
function jsonRpc(id, result) {
  return Response.json({ jsonrpc: "2.0", id, result }, { headers: corsHeaders() });
}
__name(jsonRpc, "jsonRpc");
function jsonRpcError(id, code, message, data) {
  return Response.json({ jsonrpc: "2.0", id, error: { code, message, data } }, { headers: corsHeaders() });
}
__name(jsonRpcError, "jsonRpcError");
function toolTextResult(result) {
  return {
    content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    structuredContent: result
  };
}
__name(toolTextResult, "toolTextResult");
function clampInt(value, min, max, fallback) {
  const n = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}
__name(clampInt, "clampInt");
function makeId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}
__name(makeId, "makeId");
function messageKey(id) {
  return `inbox:msg:${id}`;
}
__name(messageKey, "messageKey");
async function getIndex(env) {
  const raw = await env.INBOX_KV.get(INDEX_KEY, "json");
  return Array.isArray(raw) ? raw : [];
}
__name(getIndex, "getIndex");
async function putIndex(env, index) {
  await env.INBOX_KV.put(INDEX_KEY, JSON.stringify(index.slice(0, MAX_INDEX_SIZE)));
}
__name(putIndex, "putIndex");
function messageSummary(message) {
  return {
    id: message.id,
    source: message.source,
    received_at: message.received_at,
    payload_preview: previewPayload(message.payload)
  };
}
__name(messageSummary, "messageSummary");
function previewPayload(payload) {
  try {
    const s = JSON.stringify(payload);
    return s.length > 240 ? `${s.slice(0, 240)}\u2026` : s;
  } catch {
    return "[unserializable-payload]";
  }
}
__name(previewPayload, "previewPayload");
async function storeMessage(env, payload, source, requestedId) {
  if (payload === void 0) throw new Error("missing_payload");
  const id = String(requestedId || makeId());
  const now = (/* @__PURE__ */ new Date()).toISOString();
  const message = {
    id,
    source: source ? String(source) : "webhook",
    received_at: now,
    payload
  };
  await env.INBOX_KV.put(messageKey(id), JSON.stringify(message));
  const prev = await getIndex(env);
  const next = [id, ...prev.filter((x) => x !== id)].slice(0, MAX_INDEX_SIZE);
  await putIndex(env, next);
  return message;
}
__name(storeMessage, "storeMessage");
async function getMessage(env, id) {
  const raw = await env.INBOX_KV.get(messageKey(id), "json");
  return raw && typeof raw === "object" ? raw : null;
}
__name(getMessage, "getMessage");
async function listMessages(env, limit) {
  const safeLimit = clampInt(limit, 1, 100, 20);
  const ids = (await getIndex(env)).slice(0, safeLimit);
  const messages = await Promise.all(ids.map((id) => getMessage(env, id)));
  const items = messages.filter(Boolean).map(messageSummary);
  return {
    total_returned: items.length,
    limit: safeLimit,
    items
  };
}
__name(listMessages, "listMessages");
async function deleteMessage(env, id) {
  const existing = await getMessage(env, id);
  if (!existing) return { ok: false, id, deleted: false, not_found: true };
  await env.INBOX_KV.delete(messageKey(id));
  const prev = await getIndex(env);
  await putIndex(env, prev.filter((x) => x !== id));
  return { ok: true, id, deleted: true };
}
__name(deleteMessage, "deleteMessage");
async function handleToolCall(name, args, env) {
  switch (name) {
    case "ingest_webhook":
      return await storeMessage(env, args?.payload, args?.source, args?.message_id);
    case "list_messages":
      return await listMessages(env, args?.limit);
    case "get_message": {
      const message = await getMessage(env, String(args?.id || ""));
      if (!message) throw new Error("not_found");
      return message;
    }
    case "delete_message":
      return await deleteMessage(env, String(args?.id || ""));
    default:
      throw new Error(`unknown_tool:${name}`);
  }
}
__name(handleToolCall, "handleToolCall");
async function handleWebhook(req, env) {
  let payload;
  try {
    payload = await req.json();
  } catch {
    return json({ ok: false, error: "invalid_json" }, 400);
  }
  const source = req.headers.get("x-webhook-source") || "webhook";
  const messageId = req.headers.get("x-idempotency-key") || void 0;
  const message = await storeMessage(env, payload, source, messageId);
  return json({ ok: true, message: messageSummary(message) }, 201);
}
__name(handleWebhook, "handleWebhook");
var index_default = {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (!env.INBOX_KV) {
      return json({ ok: false, error: "missing_kv_binding", binding: "INBOX_KV" }, 500);
    }
    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }
    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/healthz")) {
      return json({
        ok: true,
        name: SERVER_NAME,
        version: SERVER_VERSION,
        storage: "cloudflare-kv",
        mcp_endpoint: `${url.origin}/mcp`,
        webhook_endpoint: `${url.origin}/webhook`,
        tools: TOOLS.map((tool) => tool.name)
      });
    }
    if (req.method === "POST" && url.pathname === "/webhook") {
      return await handleWebhook(req, env);
    }
    if (req.method === "GET" && url.pathname === "/messages") {
      return json({ ok: true, ...await listMessages(env, url.searchParams.get("limit")) });
    }
    const messageMatch = url.pathname.match(/^\/messages\/([^/]+)$/);
    if (messageMatch && req.method === "GET") {
      const id2 = decodeURIComponent(messageMatch[1]);
      const message = await getMessage(env, id2);
      if (!message) return json({ ok: false, error: "not_found", id: id2 }, 404);
      return json({ ok: true, message });
    }
    if (messageMatch && req.method === "DELETE") {
      const id2 = decodeURIComponent(messageMatch[1]);
      const result = await deleteMessage(env, id2);
      return json(result, result.deleted ? 200 : 404);
    }
    if (req.method !== "POST" || url.pathname !== "/mcp") {
      return json({ ok: false, error: "not_found" }, 404);
    }
    let body;
    try {
      body = await req.json();
    } catch {
      return jsonRpcError(null, -32700, "Parse error");
    }
    const id = body?.id ?? null;
    const method = body?.method;
    const params = body?.params || {};
    try {
      if (method === "initialize") {
        return jsonRpc(id, {
          protocolVersion: "2025-03-26",
          capabilities: { tools: {} },
          serverInfo: { name: SERVER_NAME, version: SERVER_VERSION }
        });
      }
      if (method === "notifications/initialized") {
        return new Response(null, { status: 202, headers: corsHeaders() });
      }
      if (method === "tools/list") {
        return jsonRpc(id, { tools: TOOLS });
      }
      if (method === "tools/call") {
        const result = await handleToolCall(params?.name, params?.arguments || {}, env);
        return jsonRpc(id, toolTextResult(result));
      }
      return jsonRpcError(id, -32601, `Method not found: ${method}`);
    } catch (e) {
      const message = String(e?.message || e);
      if (message === "not_found") {
        return jsonRpcError(id, -32004, "Message not found");
      }
      return jsonRpcError(id, -32e3, "Tool execution failed", { message });
    }
  }
};
export {
  index_default as default
};
//# sourceMappingURL=index.js.map
