// webhook-inbox-mcp-worker: receive webhooks into Cloudflare KV and expose the
// inbox to AI agents over MCP.
//
// Routes
//   GET    /, /healthz        public health / info
//   POST   /webhook           ingest a JSON payload        (optional WEBHOOK_TOKEN)
//   GET    /messages          list recent messages         (optional MCP_AUTH_TOKEN)
//   GET    /messages/:id      read one message             (optional MCP_AUTH_TOKEN)
//   DELETE /messages/:id      delete one message           (optional MCP_AUTH_TOKEN)
//   POST   /mcp               MCP JSON-RPC endpoint        (optional MCP_AUTH_TOKEN)
//   OPTIONS *                 CORS preflight
//
// Note: the entry module must only have a default export; workerd treats any
// named export as an additional entrypoint.

import { createMcpServer, ToolError } from "./mcp.js";
import {
  PayloadTooLargeError,
  bearerToken,
  corsHeaders,
  isAuthorized,
  json,
  readBodyText,
  safeEqual,
  unauthorized,
  withHeaders,
} from "./http.js";
import { TOOLS, callTool, ttlFromEnv } from "./tools.js";
import { LIMITS, deleteMessage, getMessage, listMessages, messageSummary, parseId, storeMessage } from "./store.js";

const SERVER_NAME = "webhook-inbox-mcp-worker";
const SERVER_VERSION = "0.2.0";

const CORS = {
  methods: ["GET", "POST", "DELETE", "OPTIONS"],
  allowHeaders: [
    "content-type",
    "authorization",
    "mcp-session-id",
    "mcp-protocol-version",
    "x-webhook-source",
    "x-idempotency-key",
    "x-webhook-token",
  ],
};

// Leave headroom over the stored-message limit for the JSON-RPC envelope.
const MAX_BODY_BYTES = LIMITS.messageBytes + 64 * 1024;

const mcp = createMcpServer({
  name: SERVER_NAME,
  version: SERVER_VERSION,
  instructions:
    "Webhook inbox. Use list_messages to see recent webhooks (newest first), get_message for the full payload, delete_message once handled.",
  tools: TOOLS,
  callTool,
  maxBodyBytes: MAX_BODY_BYTES,
});

/** WEBHOOK_TOKEN may be sent as a bearer token, an X-Webhook-Token header, or ?token=. */
async function isWebhookAuthorized(request, url, expected) {
  if (!expected) return true;
  const token = bearerToken(request) ?? request.headers.get("x-webhook-token") ?? url.searchParams.get("token");
  return token !== null && (await safeEqual(token, expected));
}

function toolErrorResponse(err) {
  const status = { not_found: 404, payload_too_large: 413 }[err.code] ?? 400;
  return json({ ok: false, error: err.code, message: err.message }, status);
}

async function handleWebhook(request, url, env) {
  if (!(await isWebhookAuthorized(request, url, env.WEBHOOK_TOKEN))) return unauthorized();
  let payload;
  try {
    payload = JSON.parse(await readBodyText(request, LIMITS.messageBytes));
  } catch (err) {
    if (err instanceof PayloadTooLargeError) return json({ ok: false, error: "payload_too_large" }, 413);
    return json({ ok: false, error: "invalid_json" }, 400);
  }
  const { message, duplicate } = await storeMessage(
    env.INBOX_KV,
    {
      payload,
      source: request.headers.get("x-webhook-source") || undefined,
      id: request.headers.get("x-idempotency-key") || undefined,
    },
    { ttlSeconds: ttlFromEnv(env) },
  );
  return json({ ok: true, duplicate, message: messageSummary(message) }, duplicate ? 200 : 201);
}

async function route(request, env) {
  const url = new URL(request.url);
  const { pathname } = url;
  const { method } = request;

  if (method === "OPTIONS") return new Response(null, { status: 204 });

  if (!env?.INBOX_KV) {
    return json({ ok: false, error: "missing_kv_binding", binding: "INBOX_KV" }, 500);
  }
  const kv = env.INBOX_KV;

  if (method === "GET" && (pathname === "/" || pathname === "/healthz")) {
    return json({
      ok: true,
      name: SERVER_NAME,
      version: SERVER_VERSION,
      storage: "cloudflare-kv",
      mcp_endpoint: `${url.origin}/mcp`,
      webhook_endpoint: `${url.origin}/webhook`,
      auth: {
        mcp: env.MCP_AUTH_TOKEN ? "bearer" : "none",
        webhook: env.WEBHOOK_TOKEN ? "token" : "none",
      },
      tools: TOOLS.map((tool) => tool.name),
    });
  }

  if (pathname === "/webhook") {
    if (method === "POST") return handleWebhook(request, url, env);
    return json({ ok: false, error: "method_not_allowed" }, 405, { allow: "POST, OPTIONS" });
  }

  if (pathname === "/mcp") {
    if (!(await isAuthorized(request, env.MCP_AUTH_TOKEN))) return unauthorized();
    if (method === "POST") return mcp.handleHttp(request, env);
    // No server-initiated SSE stream and no sessions: GET/DELETE are not supported.
    return json({ ok: false, error: "method_not_allowed" }, 405, { allow: "POST, OPTIONS" });
  }

  if (pathname === "/messages" && method === "GET") {
    if (!(await isAuthorized(request, env.MCP_AUTH_TOKEN))) return unauthorized();
    const result = await listMessages(kv, {
      limit: url.searchParams.get("limit") ?? undefined,
      cursor: url.searchParams.get("cursor") ?? undefined,
    });
    return json({ ok: true, ...result });
  }

  const match = pathname.match(/^\/messages\/([^/]+)$/);
  if (match && (method === "GET" || method === "DELETE")) {
    if (!(await isAuthorized(request, env.MCP_AUTH_TOKEN))) return unauthorized();
    let id;
    try {
      id = parseId(decodeURIComponent(match[1]), { required: true });
    } catch (err) {
      if (err instanceof ToolError) throw err;
      return json({ ok: false, error: "invalid_id" }, 400); // malformed percent-encoding
    }
    if (method === "GET") {
      const message = await getMessage(kv, id);
      if (!message) return json({ ok: false, error: "not_found", id }, 404);
      return json({ ok: true, message });
    }
    const result = await deleteMessage(kv, id);
    return json(result, result.deleted ? 200 : 404);
  }

  return json({ ok: false, error: "not_found" }, 404);
}

export default {
  async fetch(request, env) {
    let response;
    try {
      response = await route(request, env);
    } catch (err) {
      if (err instanceof ToolError) {
        response = toolErrorResponse(err);
      } else {
        console.error("unhandled error:", err);
        response = json({ ok: false, error: "internal_error" }, 500);
      }
    }
    return withHeaders(response, corsHeaders(env, CORS));
  },
};
