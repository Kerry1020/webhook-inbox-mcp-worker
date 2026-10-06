# webhook-inbox-mcp-worker

[![CI](https://github.com/Kerry1020/webhook-inbox-mcp-worker/actions/workflows/ci.yml/badge.svg)](https://github.com/Kerry1020/webhook-inbox-mcp-worker/actions/workflows/ci.yml)
[![License: GPL v3](https://img.shields.io/badge/License-GPLv3-blue.svg)](LICENSE)
[![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-F38020?logo=cloudflare&logoColor=white)](https://workers.cloudflare.com/)
[![MCP](https://img.shields.io/badge/MCP-Streamable%20HTTP-6E56CF)](https://modelcontextprotocol.io)

[English](README.md) | 简体中文

基于 Cloudflare Worker 的 webhook **收件箱**：将收到的 webhook 存入 Cloudflare KV，并以 [MCP](https://modelcontextprotocol.io) 服务器的形式提供给 AI 代理，用于列出、读取和删除事件。

## 功能特性

- `POST /webhook` 接收外部服务（GitHub、Stripe、定时任务等）发来的任意 JSON
- 通过 `POST /mcp` 提供 Streamable HTTP（JSON 响应）MCP 服务，无 SDK 依赖
- 支持协议版本 `2024-11-05`、`2025-03-26`、`2025-06-18`、`2025-11-25`（在 `initialize` 时协商）
- 支持 `initialize`、`ping`、`tools/list`、`tools/call`、通知以及 JSON-RPC 批量请求
- 提供给脚本使用的 REST API（`/messages`）
- 按时间倒序列出，支持游标分页，并发写入时不会丢失
- 幂等键（`X-Idempotency-Key`）对 webhook 重试去重
- 可选鉴权：读取用 `MCP_AUTH_TOKEN`，写入用 `WEBHOOK_TOKEN`
- 可选自动过期（`MESSAGE_TTL_SECONDS`）、大小限制、可配置 CORS

## 快速开始

```bash
git clone https://github.com/Kerry1020/webhook-inbox-mcp-worker.git
cd webhook-inbox-mcp-worker
npm install
npm run dev        # http://localhost:8791，使用本地模拟 KV

curl -s localhost:8791/webhook -H 'content-type: application/json' -d '{"hello":"world"}'
curl -s localhost:8791/messages
```

部署到自己的 Cloudflare 账号见[部署](#部署)。

## 工具列表

| 工具 | 参数 | 说明 |
|------|------|------|
| `ingest_webhook` | `payload`（必填，任意 JSON）、`source`、`message_id` | 存储一条消息。传入 `message_id` 且已存在时原样返回已有消息（`duplicate: true`）。 |
| `list_messages` | `limit`（1-100，默认 20）、`cursor` | 按时间倒序列出消息（id、来源、接收时间、payload 预览），返回 `next_cursor`。 |
| `get_message` | `id`（必填） | 读取单条消息及完整 payload。不存在时以工具错误返回（`isError: true`）。 |
| `delete_message` | `id`（必填） | 删除单条消息。 |

## HTTP 端点

| 方法 | 路径 | 鉴权 | 说明 |
|------|------|------|------|
| `GET` | `/`、`/healthz` | 公开 | 健康检查/信息（工具、端点、鉴权模式）。 |
| `POST` | `/webhook` | `WEBHOOK_TOKEN` | 写入 JSON。请求头：`X-Webhook-Source`（来源标签）、`X-Idempotency-Key`（消息 id）。`201` 新建，`200` 重复，`400` JSON 无效，`413` 过大。 |
| `GET` | `/messages?limit=&cursor=` | `MCP_AUTH_TOKEN` | 列出消息。 |
| `GET` | `/messages/:id` | `MCP_AUTH_TOKEN` | 读取单条消息（不存在返回 `404`）。 |
| `DELETE` | `/messages/:id` | `MCP_AUTH_TOKEN` | 删除单条消息（不存在返回 `404`）。 |
| `POST` | `/mcp` | `MCP_AUTH_TOKEN` | MCP JSON-RPC 端点。 |

### 限制

| 项目 | 限制 |
|------|------|
| 单条存储消息（payload + 元数据） | 1 MiB |
| 消息 id / 幂等键 | 256 字节，不含控制字符 |
| source | 200 字符 |
| 每页数量 | 100 条 |

## 工作原理

数据存放在绑定为 `INBOX_KV` 的 KV namespace 中：

| Key | Value |
|-----|-------|
| `inbox:msg:<id>` | JSON `{ id, source, received_at, payload }` |
| `inbox:idx:<倒序时间戳>:<id>` | 空值；metadata 为 `{ id, source, received_at }` |

每条消息有自己的索引 key，KV `list()` 按字典序返回时即为最新在前。没有共享的索引文档，所以并发写入不会互相覆盖。指向不存在或时间戳不一致的消息的索引项会被跳过。

v0.1 使用单个 `inbox:index` 数组（最近 200 个 id）。升级后第一次列表时会自动迁移为逐条索引并删除旧数组。在旧版中已被挤出该数组的消息仍可按 id 读取，但不会出现在列表中。

KV 是最终一致的：新消息可能需要约 60 秒才会在其他节点的 `list` 中出现。未设置 `MESSAGE_TTL_SECONDS` 时，消息会一直保留直到被删除。

## 配置

| 名称 | 必填 | Secret | 默认值 | 说明 |
|------|------|--------|--------|------|
| `INBOX_KV` | 是 | 否 | - | 存放收件箱的 KV namespace 绑定（在 `wrangler.toml` 中配置）。 |
| `MCP_AUTH_TOKEN` | 否 | 是 | 未设置（不鉴权） | `/mcp` 与 `/messages*` 所需的 Bearer token。 |
| `WEBHOOK_TOKEN` | 否 | 是 | 未设置（不鉴权） | `POST /webhook` 所需的 token。 |
| `MESSAGE_TTL_SECONDS` | 否 | 否 | 未设置（永久保留） | 消息 N 秒后自动过期；小于 60 的值会被忽略。 |
| `CORS_ALLOW_ORIGIN` | 否 | 否 | `*` | `Access-Control-Allow-Origin` 的值。 |

Secret 用 `npx wrangler secret put <NAME>` 设置；普通变量写在 `wrangler.toml` 的 `[vars]` 中。本地开发时把 `.dev.vars.example` 复制为 `.dev.vars` 即可。

### 鉴权方式

- MCP / REST 客户端发送 `Authorization: Bearer <MCP_AUTH_TOKEN>`。
- webhook 发送方可以用 `Authorization: Bearer <WEBHOOK_TOKEN>`、`X-Webhook-Token` 请求头，或在只能配置 URL 的服务里用 `?token=<WEBHOOK_TOKEN>`。查询参数可能被记进日志，能用请求头时尽量用请求头。

## MCP 客户端配置

Claude Code（原生 Streamable HTTP）：

```bash
claude mcp add --transport http webhook-inbox https://<your-worker>.workers.dev/mcp

# 设置了 MCP_AUTH_TOKEN 时
claude mcp add --transport http webhook-inbox https://<your-worker>.workers.dev/mcp \
  --header "Authorization: Bearer <token>"
```

Claude Desktop 或其他 JSON 配置（通过 `mcp-remote`）：

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

未启用鉴权时，去掉 `--header` 两项参数和 `env` 即可。

## 安全说明

- 默认**不开启**鉴权，仅适合本地测试。没有 `MCP_AUTH_TOKEN` 时，任何知道 URL 的人都能通过 `/mcp` 和 `/messages*` 读取、删除全部消息；没有 `WEBHOOK_TOKEN` 时，任何人都能往收件箱里写数据。公开部署务必两个都设置：

  ```bash
  npx wrangler secret put MCP_AUTH_TOKEN   # 保护 /mcp 和 /messages*
  npx wrangler secret put WEBHOOK_TOKEN    # 保护 POST /webhook
  ```

- `GET /` 和 `/healthz` 始终公开，只返回工具列表和各项鉴权是否开启，不会泄露 token。
- token 比较采用常量时间（比较 SHA-256 摘要）。
- CORS 默认是 `*`；如果只允许特定来源的浏览器访问，请设置 `CORS_ALLOW_ORIGIN`。
- webhook payload 原样存入 KV。若包含敏感数据，可配合 `MESSAGE_TTL_SECONDS` 或 `delete_message` 及时清理。

## curl 示例

```bash
BASE=http://localhost:8791          # 或 https://<your-worker>.workers.dev

# 写入 webhook
curl -s $BASE/webhook -H 'content-type: application/json' \
  -H 'X-Webhook-Source: github' -H 'X-Idempotency-Key: delivery-123' \
  -H "X-Webhook-Token: $WEBHOOK_TOKEN" \
  -d '{"action":"opened","number":42}'

# REST：列出 / 读取 / 删除
curl -s "$BASE/messages?limit=10" -H "Authorization: Bearer $MCP_AUTH_TOKEN"
curl -s $BASE/messages/delivery-123 -H "Authorization: Bearer $MCP_AUTH_TOKEN"
curl -s -X DELETE $BASE/messages/delivery-123 -H "Authorization: Bearer $MCP_AUTH_TOKEN"

# MCP
curl -s $BASE/mcp -H 'content-type: application/json' -H "Authorization: Bearer $MCP_AUTH_TOKEN" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"curl","version":"1"}}}'
curl -s $BASE/mcp -H 'content-type: application/json' -H "Authorization: Bearer $MCP_AUTH_TOKEN" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"list_messages","arguments":{"limit":5}}}'
```

未启用鉴权时去掉 token 相关请求头即可。

## 开发

需要 Node.js 20+。

```bash
npm install
cp .dev.vars.example .dev.vars   # 可选：本地 secrets
npm run dev                      # http://localhost:8791（本地模拟 KV）
npm test                         # node:test 测试，使用内存 KV mock
npm run build                    # wrangler dry-run 打包到 dist/
```

## 部署

```bash
npx wrangler login
npx wrangler kv namespace create INBOX_KV            # 将 id 填入 wrangler.toml
npx wrangler kv namespace create INBOX_KV --preview  # 填入 preview_id
# 删除或修改 wrangler.toml 中的 [[routes]]（指向原作者的自定义域名）
npx wrangler secret put MCP_AUTH_TOKEN               # 建议
npx wrangler secret put WEBHOOK_TOKEN                # 建议
npm run deploy
```

去掉 `[[routes]]` 后，worker 的地址为 `https://webhook-inbox-mcp-worker.<your-subdomain>.workers.dev`。

## 项目结构

```
webhook-inbox-mcp-worker/
├── src/
│   ├── index.js    # Worker 入口：路由、webhook 接收、REST API、鉴权
│   ├── mcp.js      # JSON-RPC / MCP 协议处理
│   ├── http.js     # HTTP 工具函数（JSON、CORS、请求体限制、token）
│   ├── tools.js    # MCP 工具定义与分发
│   └── store.js    # KV 收件箱存储 + 旧索引迁移
├── test/           # node:test 测试 + 内存 KV mock
├── .github/workflows/ci.yml
├── wrangler.toml
└── package.json
```

## 相关项目

- [time-mcp-worker](https://github.com/Kerry1020/time-mcp-worker) — 时区查询、时间换算与时差计算
- [geo-mcp-worker](https://github.com/Kerry1020/geo-mcp-worker) — 基于 OpenStreetMap 服务的地理编码、POI 搜索和路线规划
- [memory-mcp-worker](https://github.com/Kerry1020/memory-mcp-worker) — 基于 KV 的智能体持久化记忆
- [summarize-mcp-worker](https://github.com/Kerry1020/summarize-mcp-worker) — 网页正文提取与抽取式摘要
- [image-mcp-worker](https://github.com/Kerry1020/image-mcp-worker) — 对接任意 OpenAI 兼容图像接口的图片生成
- [calc-mcp-worker](https://github.com/Kerry1020/calc-mcp-worker) — 数学计算：表达式、微积分、矩阵、统计
- [search-mcp-worker](https://github.com/Kerry1020/search-mcp-worker) — 多引擎网页搜索，排序逻辑公开可审计

## 许可证

本项目基于 GNU General Public License v3.0 发布，详见 [LICENSE](LICENSE)。
