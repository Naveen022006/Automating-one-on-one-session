import assert from "node:assert/strict";
import { test } from "node:test";
import { getKv, kvKeys, MemoryKv, QR_TTL_MS, RedisKv, SENT_COUNTER_TTL_MS, setKv, type RedisKvClient } from "../lib/whatsapp-web/kv";

// Pure tests: an in-memory store and a recording stand-in for the Redis client. Nothing connects anywhere.

test("keys live under the wa-web: prefix, one counter per influencer per Indian day", () => {
  assert.equal(kvKeys.qr("inf1"), "wa-web:qr:inf1");
  assert.equal(kvKeys.sent("inf1", "2026-11-09"), "wa-web:sent:inf1:2026-11-09");
  assert.equal(QR_TTL_MS, 60_000);
  assert.equal(SENT_COUNTER_TTL_MS, 2 * 24 * 60 * 60 * 1000);
});

test("memory store: values expire, counters count, give-back never goes below zero", async () => {
  let now = 1_000;
  const kv = new MemoryKv(() => now);
  assert.equal(await kv.get("a"), null);
  await kv.set("a", "v", 500);
  assert.equal(await kv.get("a"), "v");
  now += 499;
  assert.equal(await kv.get("a"), "v");
  now += 1;
  assert.equal(await kv.get("a"), null);

  assert.equal(await kv.incr("n", 1_000), 1);
  assert.equal(await kv.incr("n", 1_000), 2);
  now += 900;
  assert.equal(await kv.incr("n", 1_000), 3, "the expiry is set when the counter is created, not renewed");
  now += 101;
  assert.equal(await kv.getInt("n"), 0, "gone after its first expiry");
  assert.equal(await kv.incr("n", 1_000), 1);
  await kv.decr("n");
  await kv.decr("n");
  assert.equal(await kv.getInt("n"), 0);
  await kv.del("n");
  await kv.close();
});

test("redis store: the same operations through one SET with an expiry and two small scripts", async () => {
  const log: unknown[][] = [];
  const data = new Map<string, string>();
  const client: RedisKvClient = {
    get: async (k) => data.get(k) ?? null,
    set: async (k, v, mode, ttl) => (log.push(["set", k, v, mode, ttl]), data.set(k, v)),
    del: async (k) => (log.push(["del", k]), data.delete(k)),
    eval: async (script, numKeys, ...args) => {
      log.push(["eval", numKeys, ...args]);
      const key = String(args[0]);
      if (/INCR/.test(script)) {
        const n = Number(data.get(key) ?? 0) + 1;
        data.set(key, String(n));
        return n;
      }
      const v = Number(data.get(key) ?? 0);
      if (v > 0) data.set(key, String(v - 1));
      return 1;
    },
    quit: async () => void log.push(["quit"]),
  };
  const kv = new RedisKv(client);
  await kv.set("wa-web:qr:x", "payload", 60_000);
  assert.equal(await kv.get("wa-web:qr:x"), "payload");
  assert.deepEqual(log[0], ["set", "wa-web:qr:x", "payload", "PX", 60_000]);
  assert.equal(await kv.incr("wa-web:sent:x:d", 172_800_000), 1);
  assert.equal(await kv.incr("wa-web:sent:x:d", 172_800_000), 2);
  assert.deepEqual(log.at(-1), ["eval", 1, "wa-web:sent:x:d", 172_800_000]);
  await kv.decr("wa-web:sent:x:d");
  assert.equal(await kv.getInt("wa-web:sent:x:d"), 1);
  assert.equal(await kv.getInt("missing"), 0);
  await kv.del("wa-web:qr:x");
  await kv.close();
  assert.deepEqual(log.at(-1), ["quit"]);
});

test("without REDIS_URL the process-wide store is the in-memory one; a test can swap it", async () => {
  const saved = process.env.REDIS_URL;
  delete process.env.REDIS_URL;
  try {
    setKv(null);
    const kv = getKv();
    assert.ok(kv instanceof MemoryKv);
    assert.equal(getKv(), kv, "one store per process");
    const other = new MemoryKv();
    setKv(other);
    assert.equal(getKv(), other);
  } finally {
    setKv(null);
    if (saved !== undefined) process.env.REDIS_URL = saved;
  }
});
