# webhook-inbox-mcp-worker

`webhook-inbox-mcp-worker` 是一个 Cloudflare Worker，同时提供：

- 最小可用 MCP 服务
- 简单的 HTTP inbox / webhook API

目标是做一个最小但能直接用的 webhook / inbox MCP。

## 功能

- 通过 HTTP 接收 JSON webhook
- 使用 Cloudflare KV 存储消息
- 列出最近消息
- 按 id 读取单条消息
- 按 id 删除单条消息
- 通过 MCP 工具访问同一份 inbox
- 无需上游服务

## MCP 工具

- `ingest_webhook`
- `list_messages`
- `get_message`
- `delete_message`

## HTTP 接口

### 健康检查

- `GET /`
- `GET /healthz`

### 接收 webhook

- `POST /webhook`

请求体：任意 JSON 对象或数组。

可选请求头：

- `x-webhook-source`：来源标记
- `x-idempotency-key`：调用方自定义消息 id

### 列出最近消息

- `GET /messages?limit=20`

### 读取单条消息

- `GET /messages/:id`

### 删除单条消息

- `DELETE /messages/:id`

## 项目结构

```text
webhook-inbox-mcp-worker/
├── src/index.js        # Worker 入口 + HTTP + MCP 处理
├── wrangler.toml       # Cloudflare Worker 配置
├── package.json        # 本地开发依赖
├── README.md
└── README.zh-CN.md
```

## KV 初始化

先创建 KV namespace：

```bash
npx wrangler kv namespace create INBOX_KV
npx wrangler kv namespace create INBOX_KV --preview
```

然后把返回的 `id` 和 `preview_id` 填入 `wrangler.toml`。

## 本地开发

```bash
npm install
npm run dev
```

健康检查：

```bash
curl http://127.0.0.1:8791/healthz
```

发送 webhook：

```bash
curl -X POST http://127.0.0.1:8791/webhook \
  -H 'content-type: application/json' \
  -H 'x-webhook-source: demo' \
  -d '{"event":"ping","text":"hello"}'
```

列出消息：

```bash
curl http://127.0.0.1:8791/messages?limit=10
```

## MCP 调用示例

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

## 部署

```bash
npm install
npx wrangler deploy
```

## 说明

- 这里选用 KV，是为了最快做出最小可用版本。
- 最近消息列表通过一个紧凑索引键维护。
- 为避免索引无限增长，最近列表会保留上限。
- 填好 KV namespace id 后即可部署。
