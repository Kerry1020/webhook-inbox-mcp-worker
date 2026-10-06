# webhook-inbox-mcp-worker

[![CI](https://github.com/Kerry1020/webhook-inbox-mcp-worker/actions/workflows/ci.yml/badge.svg)](https://github.com/Kerry1020/webhook-inbox-mcp-worker/actions/workflows/ci.yml)
[![License: GPL v3](https://img.shields.io/badge/License-GPLv3-blue.svg)](LICENSE)
[![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-F38020?logo=cloudflare&logoColor=white)](https://workers.cloudflare.com/)
[![MCP](https://img.shields.io/badge/MCP-Streamable%20HTTP-6E56CF)](https://modelcontextprotocol.io)

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

## Quick Start

```bash
git clone https://github.com/Kerry1020/webhook-inbox-mcp-worker.git
cd webhook-inbox-mcp-worker
npm install
npm run dev        # http://localhost:8791 with a local KV simulation

curl -s localhost:8791/webhook -H 'content-type: application/json' -d '{"hello":"world"}'
curl -s localhost:8791/messages
```

See [Deploy](#deploy) to run it on your own Cloudflare account.

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

## Configuration

| Name | Required | Secret | Default | Description |
|------|----------|--------|---------|-------------|
| `INBOX_KV` | yes | no | - | KV namespace binding that stores the inbox (set in `wrangler.toml`). |
| `MCP_AUTH_TOKEN` | no | yes | unset (auth off) | Bearer token required on `/mcp` and `/messages*`. |
| `WEBHOOK_TOKEN` | no | yes | unset (auth off) | Token required on `POST /webhook`. |
| `MESSAGE_TTL_SECONDS` | no | no | unset (keep forever) | Expire messages after N seconds; values below 60 are ignored. |
| `CORS_ALLOW_ORIGIN` | no | no | `*` | `Access-Control-Allow-Origin` value. |

Secrets are set with `npx wrangler secret put <NAME>`; plain vars go in a `[vars]` block in `wrangler.toml`. For local development, copy `.dev.vars.example` to `.dev.vars`.

### Authentication

- MCP / REST clients send `Authorization: Bearer <MCP_AUTH_TOKEN>`.
- Webhook senders send the token as `Authorization: Bearer <WEBHOOK_TOKEN>`, as an `X-Webhook-Token` header, or, for services that only let you configure a URL, as `?token=<WEBHOOK_TOKEN>`. Query strings can end up in logs, so use a header where possible.

## MCP Client Configuration

Claude Code (native Streamable HTTP):

```bash
claude mcp add --transport http webhook-inbox https://<your-worker>.workers.dev/mcp

# with MCP_AUTH_TOKEN set
claude mcp add --transport http webhook-inbox https://<your-worker>.workers.dev/mcp \
  --header "Authorization: Bearer <token>"
```

Claude Desktop / other JSON configs via `mcp-remote`:

```json
{
  "mcpServers": {
    "webhook-inbox": {
      "command": "npx",
      "args": [
        "-y",
        "mcp-remote",
        "https://<your-worker>.workers.dev/mcp",
        "--header",
        "Authorization: Bearer ${AUTH_TOKEN}"
      ],
      "env": {
        "AUTH_TOKEN": "<token>"
      }
    }
  }
}
```

Drop the `--header` arguments and `env` if auth is disabled.

## Security Notes

- Auth is **off by default**, which suits local testing only. Without `MCP_AUTH_TOKEN`, anyone who knows the URL can read and delete every message via `/mcp` and `/messages*`; without `WEBHOOK_TOKEN`, anyone can write to the inbox. For any public deployment set both:

  ```bash
  npx wrangler secret put MCP_AUTH_TOKEN   # protects /mcp and /messages*
  npx wrangler secret put WEBHOOK_TOKEN    # protects POST /webhook
  ```

- `GET /` and `/healthz` are always public; they report the tool list and whether each auth mode is enabled, never the tokens.
- Tokens are compared in constant time (SHA-256 digests).
- CORS defaults to `*`; set `CORS_ALLOW_ORIGIN` if browsers should only reach the worker from a specific origin.
- Webhook payloads are stored as-is in KV. Use `MESSAGE_TTL_SECONDS` or `delete_message` if they contain sensitive data.

## curl Examples

```bash
BASE=http://localhost:8791          # or https://<your-worker>.workers.dev

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

## Development

Requires Node.js 20+.

```bash
npm install
cp .dev.vars.example .dev.vars   # optional: local secrets
npm run dev                      # http://localhost:8791 (local KV simulation)
npm test                         # node:test suite with an in-memory KV mock
npm run build                    # wrangler dry-run bundle into dist/
```

## Deploy

```bash
npx wrangler login
npx wrangler kv namespace create INBOX_KV            # copy the id into wrangler.toml
npx wrangler kv namespace create INBOX_KV --preview  # copy into preview_id
# remove or edit the [[routes]] block in wrangler.toml (it points at the original custom domain)
npx wrangler secret put MCP_AUTH_TOKEN               # recommended
npx wrangler secret put WEBHOOK_TOKEN                # recommended
npm run deploy
```

Without a `[[routes]]` block the worker is served at `https://webhook-inbox-mcp-worker.<your-subdomain>.workers.dev`.

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

## Related Projects

- [time-mcp-worker](https://github.com/Kerry1020/time-mcp-worker) — time zone lookup, conversion and time differences
- [geo-mcp-worker](https://github.com/Kerry1020/geo-mcp-worker) — geocoding, POI search and routing via OpenStreetMap services
- [memory-mcp-worker](https://github.com/Kerry1020/memory-mcp-worker) — persistent KV-backed memory for agents
- [summarize-mcp-worker](https://github.com/Kerry1020/summarize-mcp-worker) — web page extraction and extractive summarization
- [image-mcp-worker](https://github.com/Kerry1020/image-mcp-worker) — image generation via any OpenAI-compatible images API
- [calc-mcp-worker](https://github.com/Kerry1020/calc-mcp-worker) — math: expressions, calculus, matrices, statistics
- [search-mcp-worker](https://github.com/Kerry1020/search-mcp-worker) — multi-engine web search with open, auditable ranking

## License

This project is licensed under the GNU General Public License v3.0. See the [LICENSE](LICENSE) file for details.
