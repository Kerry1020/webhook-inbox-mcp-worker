import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { makeEnv, request, rpc, rpcRaw } from "./helpers/client.js";
import { LATEST_PROTOCOL_VERSION } from "../src/mcp.js";

const TOOL_NAMES = ["ingest_webhook", "list_messages", "get_message", "delete_message"];

describe("HTTP routing", () => {
  test("health endpoints", async () => {
    for (const path of ["/", "/healthz"]) {
      const res = await request(makeEnv(), path);
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.ok, true);
      assert.equal(body.name, "webhook-inbox-mcp-worker");
      assert.equal(body.mcp_endpoint, "https://inbox.example.test/mcp");
      assert.equal(body.webhook_endpoint, "https://inbox.example.test/webhook");
      assert.deepEqual(body.auth, { mcp: "none", webhook: "none" });
      assert.deepEqual(body.tools, TOOL_NAMES);
    }
  });

  test("missing KV binding is a 500 (except preflight)", async () => {
    const res = await request({}, "/healthz");
    assert.equal(res.status, 500);
    assert.equal((await res.json()).binding, "INBOX_KV");
    assert.equal((await request({}, "/mcp", { method: "OPTIONS" })).status, 204);
  });

  test("CORS headers on every response", async () => {
    const pre = await request(makeEnv(), "/webhook", { method: "OPTIONS" });
    assert.equal(pre.status, 204);
    assert.match(pre.headers.get("access-control-allow-headers"), /x-idempotency-key/);
    assert.match(pre.headers.get("access-control-allow-headers"), /authorization/);
    assert.match(pre.headers.get("access-control-allow-methods"), /DELETE/);
    const notFound = await request(makeEnv(), "/nope");
    assert.equal(notFound.status, 404);
    assert.equal(notFound.headers.get("access-control-allow-origin"), "*");
  });

  test("GET /mcp and GET /webhook are 405", async () => {
    assert.equal((await request(makeEnv(), "/mcp")).status, 405);
    assert.equal((await request(makeEnv(), "/webhook")).status, 405);
  });
});

describe("JSON-RPC / MCP protocol", () => {
  test("initialize negotiates protocol version", async () => {
    assert.equal((await rpc(makeEnv(), "initialize", { protocolVersion: "2025-03-26" })).result.protocolVersion, "2025-03-26");
    assert.equal((await rpc(makeEnv(), "initialize", { protocolVersion: "2024-11-05" })).result.protocolVersion, "2024-11-05");
    const latest = await rpc(makeEnv(), "initialize", { protocolVersion: "nope" });
    assert.equal(latest.result.protocolVersion, LATEST_PROTOCOL_VERSION);
    assert.equal(latest.result.serverInfo.name, "webhook-inbox-mcp-worker");
    assert.ok(latest.result.capabilities.tools);
  });

  test("ping, tools/list", async () => {
    assert.deepEqual((await rpc(makeEnv(), "ping")).result, {});
    const tools = (await rpc(makeEnv(), "tools/list")).result.tools;
    assert.deepEqual(tools.map((t) => t.name), TOOL_NAMES);
    assert.deepEqual(tools[0].inputSchema.required, ["payload"]);
  });

  test("notifications return 202", async () => {
    const res = await rpcRaw(makeEnv(), { jsonrpc: "2.0", method: "notifications/initialized" });
    assert.equal(res.status, 202);
    assert.equal((await rpcRaw(makeEnv(), { jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 1 } })).status, 202);
  });

  test("error codes", async () => {
    assert.equal((await rpc(makeEnv(), "nope")).error.code, -32601);
    assert.equal((await (await rpcRaw(makeEnv(), "{")).json()).error.code, -32700);
    assert.equal((await (await rpcRaw(makeEnv(), { id: 1, method: "ping" })).json()).error.code, -32600);
    assert.equal((await rpc(makeEnv(), "tools/call", { name: "nope" })).error.code, -32602);
    assert.equal((await rpc(makeEnv(), "tools/call", { name: "list_messages", arguments: "x" })).error.code, -32602);
  });

  test("batch", async () => {
    const body = await (await rpcRaw(makeEnv(), [{ jsonrpc: "2.0", id: "a", method: "ping" }, { jsonrpc: "2.0", id: "b", method: "nope" }])).json();
    assert.equal(body.length, 2);
    assert.deepEqual(body[0], { jsonrpc: "2.0", id: "a", result: {} });
    assert.equal(body[1].error.code, -32601);
  });
});

describe("auth", () => {
  const MCP = "mcp-token";
  const HOOK = "hook-token";
  const env = () => makeEnv({ MCP_AUTH_TOKEN: MCP, WEBHOOK_TOKEN: HOOK });
  const ping = { jsonrpc: "2.0", id: 1, method: "ping" };

  test("no auth by default", async () => {
    assert.equal((await rpcRaw(makeEnv(), ping)).status, 200);
    assert.equal((await request(makeEnv(), "/messages")).status, 200);
  });

  test("MCP_AUTH_TOKEN guards /mcp and /messages", async () => {
    const e = env();
    assert.equal((await rpcRaw(e, ping)).status, 401);
    assert.equal((await rpcRaw(e, ping, { authorization: `Bearer ${HOOK}` })).status, 401);
    assert.equal((await rpcRaw(e, ping, { authorization: `Bearer ${MCP}` })).status, 200);
    assert.equal((await request(e, "/messages")).status, 401);
    assert.equal((await request(e, "/messages/x")).status, 401);
    assert.equal((await request(e, "/messages/x", { method: "DELETE" })).status, 401);
    assert.equal((await request(e, "/messages", { headers: { authorization: `Bearer ${MCP}` } })).status, 200);
    const health = await (await request(e, "/healthz")).json();
    assert.deepEqual(health.auth, { mcp: "bearer", webhook: "token" });
  });

  test("WEBHOOK_TOKEN guards /webhook via bearer, header or query", async () => {
    const e = env();
    const post = (headers, path = "/webhook") =>
      request(e, path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: "{}" });
    assert.equal((await post({})).status, 401);
    assert.equal((await post({ authorization: `Bearer ${MCP}` })).status, 401);
    assert.equal((await post({ authorization: `Bearer ${HOOK}` })).status, 201);
    assert.equal((await post({ "x-webhook-token": HOOK })).status, 201);
    assert.equal((await post({}, `/webhook?token=${HOOK}`)).status, 201);
    assert.equal((await post({}, "/webhook?token=wrong")).status, 401);
  });
});
