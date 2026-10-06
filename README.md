# webhook-inbox-mcp-worker

[![CI](https://github.com/Kerry1020/webhook-inbox-mcp-worker/actions/workflows/ci.yml/badge.svg)](https://github.com/Kerry1020/webhook-inbox-mcp-worker/actions/workflows/ci.yml)

English | [简体中文](README.zh-CN.md)

A Cloudflare Worker that receives webhooks into a Cloudflare KV **inbox** and exposes that inbox to AI agents as an [MCP](https://modelcontextprotocol.io) server, so an agent can list, read and delete incoming events.

## Features

- `POST /webhook` accepts any JSON body from external services (GitHub, Stripe, cron jobs, ...)
- MCP over Streamable HTTP (JSON responses) at `POST /mcp`, no SDK dependencies
- Protocol versions `2024-11-05`, `2025-03-26`, `2025-06-18`, `2025-11-25` (negotiated on `initialize`)
- `initialize`, `ping`, `tools/list`, `tools/call`, notifications, JSON-RPC batches
- Plain REST API (`/messages`) for scripts
- Newest-first listing with cursor pagination; safe under concurrent ingestion
- Idempotency keys (`X-Idempotency-Key`) de-duplicate webhook retries
- Optional auth: `MCP_AUTH_TOKEN` for reading, `WEBHOOK_TOKEN` for ingestion
- Optional automatic expiry (`MESSAGE_TTL_SECONDS`), size limits, configurable CORS

## MCP Tools

| Tool | Arguments | Description |
|------|-----------|-------------|
| `ingest_webhook` | `payload` (required, any JSON), `source`, `message_id` | Store a payload. With `message_id`, an existing message is returned unchanged (`duplicate: true`). |
| `list_messages` | `limit` (1-100, default 20), `cursor` | List recent messages, newest first (id, source, received_at, payload preview). Returns `next_cursor`. |
| `get_message` | `id` (required) | Read one message including the full payload. Not found is returned as a tool error (`isError: true`). |
| `delete_message` | `id` (required) | Delete one message. |

## HTTP Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/`, `/healthz` | public | Health / info (tools, endpoints, auth mode). |
| `POST` | `/webhook` | `WEBHOOK_TOKEN` | Ingest a JSON body. Headers: `X-Webhook-Source` (label), `X-Idempotency-Key` (message id). `201` created, `200` duplicate, `400` invalid JSON, `413` too large. |
| `GET` | `/messages?limit=&cursor=` | `MCP_AUTH_TOKEN` | List messages. |
| `GET` | `/messages/:id` | `MCP_AUTH_TOKEN` | Read one message (`404` if missing). |
| `DELETE` | `/messages/:id` | `MCP_AUTH_TOKEN` | Delete one message (`404` if missing). |
| `POST` | `/mcp` | `MCP_AUTH_TOKEN` | MCP JSON-RPC endpoint. |

### Limits

| Item | Limit |
|------|-------|
| stored message (payload + metadata) | 1 MiB |
| message id / idempotency key | 256 bytes, no control characters |
| source | 200 characters |
| list page | 100 messages |

## How It Works

Data lives in the KV namespace bound as `INBOX_KV`:

| Key | Value |
|-----|-------|
| `inbox:msg:<id>` | JSON `{ id, source, received_at, payload }` |
| `inbox:idx:<inverted-timestamp>:<id>` | empty; metadata `{ id, source, received_at }` |

Each message gets its own index key, sorted newest first by KV's lexicographic `list()`. There is no shared index document, so concurrent webhooks cannot overwrite each other. Index entries that point at a missing or mismatched message are skipped.

v0.1 kept a single `inbox:index` array (newest 200 ids). The first listing after upgrading migrates it to per-message index keys and deletes it. Messages that had already dropped out of that array are still readable by id but are not listed.

KV is eventually consistent: a new message can take up to about 60 s to show up in `list` from other locations. Without `MESSAGE_TTL_SECONDS`, messages are kept until deleted.

## Authentication

Auth is **off by default**, which suits local testing. Enable it before exposing the worker publicly.

```bash
npx wrangler secret put MCP_AUTH_TOKEN   # protects /mcp and /messages*
npx wrangler secret put WEBHOOK_TOKEN    # protects POST /webhook
```

- MCP / REST clients send `Authorization: Bearer <MCP_AUTH_TOKEN>`.
- Webhook senders send the token as `Authorization: Bearer <WEBHOOK_TOKEN>`, as an `X-Webhook-Token` header, or, for services that only let you configure a URL, as `?token=<WEBHOOK_TOKEN>`. Query strings can end up in logs, so use a header where possible.

| Variable | Type | Description |
|----------|------|-------------|
| `MCP_AUTH_TOKEN` | secret | Optional. Bearer token for `/mcp` and `/messages*`. |
| `WEBHOOK_TOKEN` | secret | Optional. Token for `POST /webhook`. |
| `MESSAGE_TTL_SECONDS` | var | Optional. Expire messages after N seconds (min 60). |
| `CORS_ALLOW_ORIGIN` | var | Optional. `Access-Control-Allow-Origin` value (default `*`). |

## MCP Client Configuration

Claude Code (native Streamable HTTP):

```bash
claude mcp add --transport http inbox https://<your-worker>/mcp \
  --header "Authorization: Bearer <MCP_AUTH_TOKEN>"   # omit if auth is disabled
```

JSON config (Cursor, Claude Desktop via `mcp-remote`, etc.):

```json
{
  "mcpServers": {
    "webhook-inbox": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "https://<your-worker>/mcp", "--header", "Authorization: Bearer ${INBOX_MCP_TOKEN}"],
      "env": { "INBOX_MCP_TOKEN": "<MCP_AUTH_TOKEN>" }
    }
  }
}
```

## curl Examples

```bash
BASE=http://localhost:8791          # or https://<your-worker>

# Ingest a webhook
curl -s $BASE/webhook -H 'content-type: application/json' \
  -H 'X-Webhook-Source: github' -H 'X-Idempotency-Key: delivery-123' \
  -H "X-Webhook-Token: $WEBHOOK_TOKEN" \
  -d '{"action":"opened","number":42}'

# REST: list / read / delete
curl -s "$BASE/messages?limit=10" -H "Authorization: Bearer $MCP_AUTH_TOKEN"
curl -s $BASE/messages/delivery-123 -H "Authorization: Bearer $MCP_AUTH_TOKEN"
curl -s -X DELETE $BASE/messages/delivery-123 -H "Authorization: Bearer $MCP_AUTH_TOKEN"

# MCP
curl -s $BASE/mcp -H 'content-type: application/json' -H "Authorization: Bearer $MCP_AUTH_TOKEN" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"curl","version":"1"}}}'
curl -s $BASE/mcp -H 'content-type: application/json' -H "Authorization: Bearer $MCP_AUTH_TOKEN" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"list_messages","arguments":{"limit":5}}}'
```

If auth is disabled, drop the token headers.

## Local Development

Requires Node.js 20+.

```bash
npm install
cp .dev.vars.example .dev.vars   # optional: local secrets
npm run dev                      # http://localhost:8791 (local KV simulation)
npm test                         # node:test suite with an in-memory KV mock
```

## Deploy

```bash
npx wrangler login
npx wrangler kv namespace create INBOX_KV            # copy the id into wrangler.toml
npx wrangler kv namespace create INBOX_KV --preview  # copy into preview_id
# edit or remove the [[routes]] block in wrangler.toml for your own domain
npx wrangler secret put MCP_AUTH_TOKEN               # recommended
npx wrangler secret put WEBHOOK_TOKEN                # recommended
npm run deploy
```

## Project Structure

```
webhook-inbox-mcp-worker/
├── src/
│   ├── index.js    # Worker entry: routing, webhook receiver, REST API, auth
│   ├── mcp.js      # JSON-RPC / MCP protocol handling
│   ├── http.js     # HTTP helpers (JSON, CORS, body limits, tokens)
│   ├── tools.js    # MCP tool definitions and dispatch
│   └── store.js    # KV inbox store + legacy index migration
├── test/           # node:test suites + in-memory KV mock
├── .github/workflows/ci.yml
├── wrangler.toml
└── package.json
```

## License

This project is licensed under the GNU General Public License v3.0. See the [LICENSE](LICENSE) file for details.
