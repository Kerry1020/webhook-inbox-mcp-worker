# webhook-inbox-mcp-worker

基于 Cloudflare Worker 的 MCP 服务器，提供 webhook 接收和收件箱存储。通过 POST 接收 JSON 数据，AI 可列表、读取、删除消息。

## MCP 工具

| 工具 | 说明 |
|------|------|
| `ingest_webhook` | 存储 JSON webhook 到收件箱。 |
| `list_messages` | 列出最近的消息（id、时间戳、摘要）。 |
| `get_message` | 按 id 读取完整消息。 |
| `delete_message` | 按 id 删除消息。 |

## 工作原理

消息存在 Cloudflare KV namespace（`INBOX_KV`）。每条消息有唯一 id 和时间戳，收件箱按插入时间倒序（最新在前）。

MCP 端点遵循标准 JSON-RPC（`/mcp`）。worker 同时接受外部服务直接 POST `/webhook` 写入 webhook 数据——根路径 `/` 是 GET 健康检查，返回工具列表和各端点地址。

## 本地开发

```bash
npm install
npx wrangler dev --local --port 8791
```

## 部署

```bash
npx wrangler deploy
```

## 项目结构

```
webhook-inbox-mcp-worker/
├── src/index.js
├── wrangler.toml
├── package.json
└── README.md
```
