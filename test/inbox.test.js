import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { makeEnv, request, callTool, postWebhook } from "./helpers/client.js";
import { IDX_PREFIX, LEGACY_INDEX_KEY, LIMITS, indexKey, messageKey } from "../src/store.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

describe("POST /webhook", () => {
  test("stores JSON payloads", async () => {
    const env = makeEnv();
    const res = await postWebhook(env, { event: "push", n: 1 }, { "x-webhook-source": "github" });
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.duplicate, false);
    assert.equal(body.message.source, "github");
    assert.equal(body.message.payload_preview, '{"event":"push","n":1}');
    const stored = JSON.parse(env.INBOX_KV.store.get(messageKey(body.message.id)).value);
    assert.deepEqual(stored.payload, { event: "push", n: 1 });
    assert.ok(env.INBOX_KV.store.has(indexKey(stored.id, stored.received_at)));
  });

  test("default source and scalar/null payloads", async () => {
    const env = makeEnv();
    for (const payload of ["null", "42", '"str"', "[1,2]"]) {
      const res = await postWebhook(env, payload);
      assert.equal(res.status, 201, payload);
      assert.equal((await res.json()).message.source, "webhook");
    }
  });

  test("rejects invalid JSON and empty bodies", async () => {
    for (const body of ["{nope", ""]) {
      const res = await postWebhook(makeEnv(), body);
      assert.equal(res.status, 400);
      assert.equal((await res.json()).error, "invalid_json");
    }
  });

  test("rejects payloads over the size limit", async () => {
    const env = makeEnv();
    const res = await postWebhook(env, JSON.stringify({ big: "x".repeat(LIMITS.messageBytes) }));
    assert.equal(res.status, 413);
    assert.equal(env.INBOX_KV.store.size, 0);
  });

  test("validates headers", async () => {
    const env = makeEnv();
    const longSource = await postWebhook(env, {}, { "x-webhook-source": "s".repeat(LIMITS.sourceChars + 1) });
    assert.equal(longSource.status, 400);
    const longId = await postWebhook(env, {}, { "x-idempotency-key": "k".repeat(LIMITS.idBytes + 1) });
    assert.equal(longId.status, 400);
    assert.equal(env.INBOX_KV.store.size, 0);
  });

  test("idempotency key de-duplicates retries", async () => {
    const env = makeEnv();
    const first = await postWebhook(env, { v: 1 }, { "x-idempotency-key": "evt-1" });
    assert.equal(first.status, 201);
    const again = await postWebhook(env, { v: 2 }, { "x-idempotency-key": "evt-1" });
    assert.equal(again.status, 200);
    const body = await again.json();
    assert.equal(body.duplicate, true);
    assert.equal(body.message.id, "evt-1");
    assert.equal(body.message.payload_preview, '{"v":1}');
    const list = await (await request(env, "/messages")).json();
    assert.equal(list.total_returned, 1);
  });

  test("MESSAGE_TTL_SECONDS applies expiry to message and index", async () => {
    const env = makeEnv({ MESSAGE_TTL_SECONDS: "3600" });
    await postWebhook(env, {});
    for (const entry of env.INBOX_KV.store.values()) assert.ok(entry.expiresAt > Date.now());
    const noTtl = makeEnv({ MESSAGE_TTL_SECONDS: "10" }); // below KV minimum: ignored
    await postWebhook(noTtl, {});
    for (const entry of noTtl.INBOX_KV.store.values()) assert.equal(entry.expiresAt, null);
  });
});

describe("REST /messages", () => {
  test("list, get, delete", async () => {
    const env = makeEnv();
    const ids = [];
    for (let i = 0; i < 3; i++) {
      ids.push((await (await postWebhook(env, { i })).json()).message.id);
      await sleep(2);
    }
    const list = await (await request(env, "/messages?limit=2")).json();
    assert.equal(list.ok, true);
    assert.equal(list.limit, 2);
    assert.equal(list.total_returned, 2);
    assert.deepEqual(list.items.map((m) => m.id), [ids[2], ids[1]]);
    assert.ok(list.next_cursor);
    const page2 = await (await request(env, `/messages?limit=2&cursor=${encodeURIComponent(list.next_cursor)}`)).json();
    assert.deepEqual(page2.items.map((m) => m.id), [ids[0]]);
    assert.equal(page2.next_cursor, null);

    const got = await (await request(env, `/messages/${ids[0]}`)).json();
    assert.deepEqual(got.message.payload, { i: 0 });

    const del = await request(env, `/messages/${ids[0]}`, { method: "DELETE" });
    assert.equal(del.status, 200);
    assert.deepEqual(await del.json(), { ok: true, id: ids[0], deleted: true });
    assert.equal((await request(env, `/messages/${ids[0]}`)).status, 404);
    const delAgain = await request(env, `/messages/${ids[0]}`, { method: "DELETE" });
    assert.equal(delAgain.status, 404);
    assert.equal((await delAgain.json()).not_found, true);
    assert.equal([...env.INBOX_KV.store.keys()].filter((k) => k.startsWith(IDX_PREFIX)).length, 2);
  });

  test("ids with special characters round-trip", async () => {
    const env = makeEnv();
    await postWebhook(env, {}, { "x-idempotency-key": "a/b c" });
    const res = await request(env, `/messages/${encodeURIComponent("a/b c")}`);
    assert.equal(res.status, 200);
    assert.equal((await res.json()).message.id, "a/b c");
  });

  test("malformed percent-encoding is a 400, not a crash", async () => {
    const res = await request(makeEnv(), "/messages/%E0%A4%A");
    assert.equal(res.status, 400);
  });

  test("invalid cursor is a 400", async () => {
    const env = makeEnv();
    await postWebhook(env, {});
    const res = await request(env, "/messages?cursor=garbage");
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error, "invalid_cursor");
  });

  test("limit is clamped", async () => {
    const env = makeEnv();
    assert.equal((await (await request(env, "/messages?limit=999")).json()).limit, 100);
    assert.equal((await (await request(env, "/messages?limit=0")).json()).limit, 1);
    assert.equal((await (await request(env, "/messages?limit=x")).json()).limit, 20);
  });
});

describe("MCP tools", () => {
  test("ingest, list, get, delete", async () => {
    const env = makeEnv();
    const { data: msg } = await callTool(env, "ingest_webhook", { payload: { hello: "world" }, source: "agent" });
    assert.equal(msg.source, "agent");
    assert.equal(msg.duplicate, false);
    assert.deepEqual(msg.payload, { hello: "world" });

    const { data: list } = await callTool(env, "list_messages", {});
    assert.equal(list.total_returned, 1);
    assert.equal(list.items[0].id, msg.id);
    assert.equal(list.next_cursor, null);

    const { data: got } = await callTool(env, "get_message", { id: msg.id });
    assert.deepEqual(got, { id: msg.id, source: "agent", received_at: msg.received_at, payload: { hello: "world" } });

    assert.deepEqual((await callTool(env, "delete_message", { id: msg.id })).data, { ok: true, id: msg.id, deleted: true });
    assert.deepEqual((await callTool(env, "delete_message", { id: msg.id })).data, { ok: false, id: msg.id, deleted: false, not_found: true });
  });

  test("get_message not found is a tool error", async () => {
    const { result, data } = await callTool(makeEnv(), "get_message", { id: "missing" });
    assert.equal(result.isError, true);
    assert.equal(data.error, "not_found");
  });

  test("argument validation", async () => {
    const env = makeEnv();
    const cases = [
      ["ingest_webhook", {}, "missing_payload"],
      ["ingest_webhook", { payload: 1, source: 5 }, "invalid_argument"],
      ["ingest_webhook", { payload: 1, message_id: {} }, "invalid_argument"],
      ["get_message", {}, "id_required"],
      ["delete_message", { id: "  " }, "id_required"],
      ["list_messages", { cursor: 5 }, "invalid_argument"],
    ];
    for (const [name, args, code] of cases) {
      const { result, data } = await callTool(env, name, args);
      assert.equal(result.isError, true, `${name} ${JSON.stringify(args)}`);
      assert.equal(data.error, code);
    }
  });

  test("ingest with message_id is idempotent", async () => {
    const env = makeEnv();
    await callTool(env, "ingest_webhook", { payload: 1, message_id: "x" });
    const { data } = await callTool(env, "ingest_webhook", { payload: 2, message_id: "x" });
    assert.equal(data.duplicate, true);
    assert.equal(data.payload, 1);
  });
});

describe("index consistency", () => {
  test("concurrent ingests are all listed (no lost index updates)", async () => {
    const env = makeEnv();
    await Promise.all(Array.from({ length: 50 }, (_, i) => postWebhook(env, { i })));
    const { data } = await callTool(env, "list_messages", { limit: 100 });
    assert.equal(data.total_returned, 50);
  });

  test("stale and orphaned index entries are skipped", async () => {
    const env = makeEnv();
    const kv = env.INBOX_KV;
    const { data: msg } = await callTool(env, "ingest_webhook", { payload: 1 });
    // Orphan: index entry without message.
    await kv.put(indexKey("ghost", new Date().toISOString()), "", { metadata: { id: "ghost" } });
    // Stale: second index entry for the same id with a different timestamp.
    await kv.put(indexKey(msg.id, "2020-01-01T00:00:00Z"), "", { metadata: { id: msg.id } });
    const { data } = await callTool(env, "list_messages", {});
    assert.deepEqual(data.items.map((m) => m.id), [msg.id]);
  });

  test("short pages caused by stale entries are refilled", async () => {
    const env = makeEnv();
    const kv = env.INBOX_KV;
    const { data: real } = await callTool(env, "ingest_webhook", { payload: 1 });
    for (let i = 0; i < 3; i++) await kv.put(indexKey(`ghost${i}`, new Date(Date.now() + 1000).toISOString()), "", { metadata: { id: `ghost${i}` } });
    const { data } = await callTool(env, "list_messages", { limit: 2 });
    assert.deepEqual(data.items.map((m) => m.id), [real.id]);
  });

  test("migrates the v0.1 inbox:index array", async () => {
    const env = makeEnv();
    const kv = env.INBOX_KV;
    const legacy = [
      { id: "new", source: "webhook", received_at: "2026-01-02T00:00:00.000Z", payload: { n: 2 } },
      { id: "old", source: "github", received_at: "2026-01-01T00:00:00.000Z", payload: { n: 1 } },
    ];
    for (const m of legacy) await kv.put(messageKey(m.id), JSON.stringify(m));
    await kv.put(LEGACY_INDEX_KEY, JSON.stringify(["new", "old", "missing"]));

    const fresh = (await callTool(env, "ingest_webhook", { payload: 3 })).data;
    const { data } = await callTool(env, "list_messages", {});
    assert.deepEqual(data.items.map((m) => m.id), [fresh.id, "new", "old"]);
    assert.equal(kv.store.has(LEGACY_INDEX_KEY), false);

    // Legacy messages can be deleted cleanly afterwards.
    await callTool(env, "delete_message", { id: "old" });
    assert.deepEqual((await callTool(env, "list_messages", {})).data.items.map((m) => m.id), [fresh.id, "new"]);
  });

  test("corrupted message values do not crash and can be deleted", async () => {
    const env = makeEnv();
    await env.INBOX_KV.put(messageKey("bad"), "{oops");
    assert.equal((await request(env, "/messages/bad")).status, 404);
    await request(env, "/messages/bad", { method: "DELETE" });
    assert.equal(env.INBOX_KV.store.has(messageKey("bad")), false);
  });

  test("unexpected KV errors become 500 with CORS", async (t) => {
    t.mock.method(console, "error", () => {});
    const env = makeEnv();
    env.INBOX_KV.put = async () => {
      throw new Error("kv down");
    };
    const res = await postWebhook(env, {});
    assert.equal(res.status, 500);
    assert.equal(res.headers.get("access-control-allow-origin"), "*");
  });
});
