# webhook-inbox-mcp-worker

`webhook-inbox-mcp-worker` is a Cloudflare Worker that exposes both:

- a minimal MCP server
- a simple HTTP inbox API for webhook ingestion and message management

It is designed as a smallest-useful webhook / inbox MCP service.

## Features

- Accept JSON webhook payloads over HTTP
- Store incoming messages in Cloudflare KV
- List recent messages
- Read a single message by id
- Delete a single message by id
- Access the same inbox via MCP tools
- No upstream dependency

## MCP Tools

- `ingest_webhook`
- `list_messages`
- `get_message`
- `delete_message`

## HTTP API

### Health

- `GET /`
- `GET /healthz`

### Ingest webhook

- `POST /webhook`

Request body: any JSON object or array.

Optional headers:

- `x-webhook-source`: source label
- `x-idempotency-key`: caller-supplied message id

### List recent messages

- `GET /messages?limit=20`

### Read one message

- `GET /messages/:id`

### Delete one message

- `DELETE /messages/:id`

## Project Structure

```text
webhook-inbox-mcp-worker/
├── src/index.js        # Worker entry + HTTP + MCP handlers
├── wrangler.toml       # Cloudflare Worker config
├── package.json        # local dev dependency manifest
├── README.md
└── README.zh-CN.md
```

## KV Setup

Create a KV namespace first:

```bash
npx wrangler kv namespace create INBOX_KV
npx wrangler kv namespace create INBOX_KV --preview
```

Then replace the `id` and `preview_id` in `wrangler.toml`.

## Local Development

```bash
npm install
npm run dev
```

Health check:

```bash
curl http://127.0.0.1:8791/healthz
```

Ingest a webhook:

```bash
curl -X POST http://127.0.0.1:8791/webhook \
  -H 'content-type: application/json' \
  -H 'x-webhook-source: demo' \
  -d '{"event":"ping","text":"hello"}'
```

List messages:

```bash
curl http://127.0.0.1:8791/messages?limit=10
```

## Example MCP Call

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/call",
  "params": {
    "name": "list_messages",
    "arguments": {
      "limit": 10
    }
  }
}
```

## Deployment

```bash
npm install
npx wrangler deploy
```

## Notes

- KV is used for the fastest minimal implementation.
- Messages are stored with a compact recent-index key for listing.
- The recent list is bounded to avoid unbounded index growth.
- The project can be deployed after KV namespace ids are filled in.
