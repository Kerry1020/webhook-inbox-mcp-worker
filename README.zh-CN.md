# webhook-inbox-mcp-worker

基于 Cloudflare Worker 的 MCP 服务器，提供 webhook 接收和收件箱存储。通过 POST 接收 JSON 数据，AI 可列表、读取、删除消息。

## MCP 工具

| 工具 | 说明 |
|------|------|
| `ingest_webhook` | 存储 JSON webhook 到收件箱。 |
| `list_messages` | 列出最近的消息（id、时间戳、摘要）。 |
| `get_message` | 按 id 读取完整消息。 |
| `delete_message` | 按 id 删除消息。 |
| `health` | 健康检查。 |

## 本地开发

```bash
npm install
npx wrangler dev --local --port 8793
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
