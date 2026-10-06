// MCP tool definitions and dispatch for webhook-inbox-mcp-worker.

import { ToolError } from "./mcp.js";
import { LIMITS, storeMessage, listMessages, getMessage, deleteMessage, parseId } from "./store.js";

const idProp = { type: "string", description: "Message id." };

export const TOOLS = [
  {
    name: "ingest_webhook",
    description: "Store a JSON webhook payload into the inbox.",
    inputSchema: {
      type: "object",
      properties: {
        payload: { description: "Any JSON value to store." },
        source: { type: "string", description: "Label for the sender (default \"webhook\")." },
        message_id: {
          type: "string",
          description: "Optional idempotency key. If a message with this id exists it is returned unchanged.",
        },
      },
      required: ["payload"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  },
  {
    name: "list_messages",
    description: "List recent inbox messages.",
    inputSchema: {
      type: "object",
      properties: {
        limit: {
          type: "integer",
          default: LIMITS.listDefault,
          minimum: 1,
          maximum: LIMITS.listMax,
          description: `Maximum number of messages to return (1-${LIMITS.listMax}).`,
        },
        cursor: { type: "string", description: "Pagination cursor from a previous call's next_cursor." },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "get_message",
    description: "Read a single inbox message by id.",
    inputSchema: {
      type: "object",
      properties: { id: idProp },
      required: ["id"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "delete_message",
    description: "Delete a single inbox message by id.",
    inputSchema: {
      type: "object",
      properties: { id: idProp },
      required: ["id"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
  },
];

/** Parse MESSAGE_TTL_SECONDS; returns undefined when unset/invalid (no expiry). */
export function ttlFromEnv(env) {
  const n = Number.parseInt(String(env?.MESSAGE_TTL_SECONDS ?? ""), 10);
  return Number.isFinite(n) && n >= LIMITS.minTtlSeconds ? n : undefined;
}

export async function callTool(name, args, env) {
  const kv = env?.INBOX_KV;
  if (!kv) throw new ToolError("missing_kv_binding", "KV binding INBOX_KV is not configured");
  switch (name) {
    case "ingest_webhook": {
      const { message, duplicate } = await storeMessage(
        kv,
        { payload: args.payload, source: args.source, id: args.message_id },
        { ttlSeconds: ttlFromEnv(env) },
      );
      return { ...message, duplicate };
    }
    case "list_messages":
      return listMessages(kv, { limit: args.limit, cursor: args.cursor });
    case "get_message": {
      const id = parseId(args.id, { required: true });
      const message = await getMessage(kv, id);
      if (!message) throw new ToolError("not_found", "Message not found", { id });
      return message;
    }
    case "delete_message":
      return deleteMessage(kv, parseId(args.id, { required: true }));
    default:
      throw new ToolError("unknown_tool", `Unknown tool: ${name}`);
  }
}
