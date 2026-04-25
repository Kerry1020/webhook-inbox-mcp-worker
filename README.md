# webhook-inbox-mcp-worker

A Cloudflare Worker providing an MCP server for webhook ingestion and inbox storage. Receives JSON payloads via POST and lets an AI agent list, read, and delete them.

## MCP Tools

| Tool | Description |
|------|-------------|
| `ingest_webhook` | Store a JSON webhook payload into the inbox. Accepts any JSON body. |
| `list_messages` | List recent inbox messages (id, timestamp, summary). |
| `get_message` | Read a single message by id, including the full JSON payload. |
| `delete_message` | Delete a single message by id. |
| `health` | Worker health check. |

## How It Works

Messages are stored in a Cloudflare KV namespace (`INBOX_KV`). Each message gets a unique id and timestamp. The inbox is ordered by insertion time (newest first).

The MCP endpoint follows standard JSON-RPC (`/mcp`). The worker also accepts direct POST requests to `/` for webhook ingestion from external services.

## Local Development

```bash
npm install
npx wrangler dev --local --port 8793
```

## Deploy

```bash
npx wrangler deploy
```

## Configuration

Required KV namespace binding in `wrangler.toml`:

```toml
[[kv_namespaces]]
binding = "INBOX_KV"
id = "<your-kv-namespace-id>"
```

## Project Structure

```
webhook-inbox-mcp-worker/
├── src/index.js      # Worker entry + MCP handlers + webhook receiver
├── wrangler.toml
├── package.json
└── README.md
```
