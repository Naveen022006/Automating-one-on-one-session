import "dotenv/config";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { NextRequest } from "next/server";
import { GET as healthGet } from "../app/api/health/route";
import { isCsrfExempt } from "../lib/auth/csrf";
import { checkReadiness, closeReadinessConnections, defaultReadinessDeps, livenessResponse, logReadinessFailure, readinessResponse } from "../lib/health";
import { MemoryStore, type RateLimitStore } from "../lib/rate-limit/core";
import { hit, setStore } from "../lib/rate-limit";
import { GLOBAL_API_RULE, PROBE_RULES, matchRouteRule } from "../lib/rate-limit/policies";
import { proxy } from "../proxy";

const ok = async () => 1;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

after(() => closeReadinessConnections());

/* ---------- liveness ---------- */

test("GET /api/health is 200 {ok:true}, uncached, and needs nothing", async () => {
  const res = healthGet();
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
  assert.equal(res.headers.get("cache-control"), "no-store");
  assert.deepEqual(await livenessResponse().json(), { ok: true });
});

/* ---------- readiness logic ---------- */

test("ready: database and Redis answering means 200 ok", async () => {
  const r = await checkReadiness({ pingDb: ok, pingRedis: ok });
  assert.deepEqual(r, { ok: true, checks: { db: "ok", redis: "ok" } });
});

test("ready: Redis is skipped, not failed, when it is not configured", async () => {
  const r = await checkReadiness({ pingDb: ok, pingRedis: null });
  assert.deepEqual(r, { ok: true, checks: { db: "ok", redis: "skipped" } });
});

test("ready: a failing database is reported as the failed check", async () => {
  const r = await checkReadiness({ pingDb: async () => Promise.reject(new Error("boom")), pingRedis: ok });
  assert.deepEqual(r, { ok: false, checks: { db: "fail", redis: "ok" } });
});

test("ready: a failing Redis is reported as the failed check", async () => {
  const r = await checkReadiness({ pingDb: ok, pingRedis: async () => Promise.reject(new Error("boom")) });
  assert.deepEqual(r, { ok: false, checks: { db: "ok", redis: "fail" } });
});

test("ready: a ping that throws synchronously still yields a clean failure", async () => {
  const r = await checkReadiness({
    pingDb: () => {
      throw new Error("sync boom");
    },
    pingRedis: null,
  });
  assert.equal(r.checks.db, "fail");
});

test("ready: a hung dependency fails at the timeout instead of hanging the probe", async () => {
  const started = Date.now();
  const reasons: string[] = [];
  const r = await checkReadiness({
    pingDb: () => new Promise(() => {}),
    pingRedis: ok,
    timeoutMs: 60,
    onFailure: (check, reason) => reasons.push(`${check}:${reason}`),
  });
  assert.deepEqual(r, { ok: false, checks: { db: "fail", redis: "ok" } });
  assert.deepEqual(reasons, ["db:timeout"]);
  assert.ok(Date.now() - started < 1_000, "returned promptly");
});

test("ready: a ping that fails after the deadline is not an unhandled rejection", async () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (e: unknown) => unhandled.push(e);
  process.on("unhandledRejection", onUnhandled);
  try {
    const r = await checkReadiness({
      pingDb: () => new Promise((_, reject) => setTimeout(() => reject(new Error("late")), 120)),
      pingRedis: null,
      timeoutMs: 30,
    });
    assert.equal(r.checks.db, "fail");
    await sleep(200);
    assert.deepEqual(unhandled, []);
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
});

test("ready: the HTTP response is 200 or 503, never cached, and leaks nothing about the failure", async () => {
  const SECRET = "postgresql://admin:SENTINEL-password@internal-db.example.com:5432/prod";
  const err = Object.assign(new Error(`connect failed for ${SECRET}`), { code: "ECONNREFUSED" });
  const reasons: string[] = [];

  const bad = await readinessResponse({ pingDb: async () => Promise.reject(err), pingRedis: ok, onFailure: (c, r) => reasons.push(`${c}:${r}`) });
  assert.equal(bad.status, 503);
  assert.equal(bad.headers.get("cache-control"), "no-store");
  const text = await bad.text();
  assert.deepEqual(JSON.parse(text), { ok: false, checks: { db: "fail", redis: "ok" } });
  assert.ok(!text.includes("SENTINEL") && !text.includes("internal-db") && !text.includes("ECONNREFUSED"), "response has no error details");
  // The log reason is the code only: never the message that carries the connection string.
  assert.deepEqual(reasons, ["db:ECONNREFUSED"]);
  assert.ok(!reasons.join().includes("SENTINEL"));

  const good = await readinessResponse({ pingDb: ok, pingRedis: null });
  assert.equal(good.status, 200);
  assert.deepEqual(await good.json(), { ok: true, checks: { db: "ok", redis: "skipped" } });
});

test("ready: failure logging is throttled to once a minute per check", () => {
  const realError = console.error;
  const lines: string[] = [];
  console.error = (...a: unknown[]) => void lines.push(a.join(" "));
  try {
    const t = 1_000_000_000_000;
    logReadinessFailure("db", "timeout", t);
    logReadinessFailure("db", "timeout", t + 5_000);
    logReadinessFailure("redis", "timeout", t + 5_000);
    logReadinessFailure("db", "timeout", t + 61_000);
    assert.equal(lines.length, 3);
  } finally {
    console.error = realError;
  }
});

test("ready: the default dependencies skip Redis without REDIS_URL, and report an unreachable Redis as a failure", async () => {
  const saved = process.env.REDIS_URL;
  try {
    delete process.env.REDIS_URL;
    assert.equal(defaultReadinessDeps().pingRedis, null);

    process.env.REDIS_URL = "redis://127.0.0.1:1"; // nothing listens on port 1
    const deps = defaultReadinessDeps();
    assert.ok(deps.pingRedis);
    const started = Date.now();
    const r = await checkReadiness({ pingDb: ok, pingRedis: deps.pingRedis, onFailure: () => {} });
    assert.deepEqual(r, { ok: false, checks: { db: "ok", redis: "fail" } });
    assert.ok(Date.now() - started < 4_000, "fails fast");
  } finally {
    closeReadinessConnections();
    if (saved === undefined) delete process.env.REDIS_URL;
    else process.env.REDIS_URL = saved;
  }
});

const skipDb = process.env.DATABASE_URL ? false : "DATABASE_URL not set";
test("ready: the default database check works against the real database", { skip: skipDb }, async () => {
  const saved = process.env.REDIS_URL;
  try {
    delete process.env.REDIS_URL;
    const res = await readinessResponse(defaultReadinessDeps());
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, checks: { db: "ok", redis: "skipped" } });
  } finally {
    if (saved !== undefined) process.env.REDIS_URL = saved;
    const { prisma } = await import("../lib/db");
    await prisma.$disconnect();
  }
});

/* ---------- rate limits and CSRF ---------- */

test("probe paths have explicit, generous, in-memory rules that win over everything else", () => {
  for (const [path, name] of [
    ["/api/health", "health"],
    ["/api/ready", "ready"],
  ] as const) {
    for (const method of ["GET", "HEAD"]) {
      const rule = matchRouteRule(method, path);
      assert.equal(rule?.name, name, `${method} ${path}`);
      assert.equal(rule?.local, true, "counted in process memory: no Redis or Postgres involved");
      assert.ok(rule!.limit >= GLOBAL_API_RULE.limit * 2, "far above any real probe schedule");
    }
    assert.equal(matchRouteRule("POST", path), null, "no probe exemption for other methods");
  }
  assert.equal(PROBE_RULES.length, 2);
  assert.ok(PROBE_RULES.find((r) => r.name === "ready")!.limit <= PROBE_RULES.find((r) => r.name === "health")!.limit, "readiness touches the database, so it is the tighter one");
});

test("probes are CSRF-exempt because they are GET, and nothing else on those paths is", () => {
  assert.equal(isCsrfExempt("GET", "/api/health"), true);
  assert.equal(isCsrfExempt("HEAD", "/api/ready"), true);
  assert.equal(isCsrfExempt("POST", "/api/health"), false);
  assert.equal(isCsrfExempt("POST", "/api/ready"), false);
});

test("probe rules never touch the shared store, so probes keep answering when Redis and Postgres are down", async () => {
  const touched: string[] = [];
  const boom: RateLimitStore = {
    name: "shared",
    hit: async (key) => {
      touched.push(key);
      throw new Error("store down");
    },
  };
  setStore(boom);
  try {
    const health = await hit(PROBE_RULES[0], "ip:probe-1");
    assert.equal(health?.allowed, true);
    assert.equal(health?.store, "memory");
    assert.deepEqual(touched, [], "the shared store was not used");
    const other = await hit(GLOBAL_API_RULE, "ip:probe-1");
    assert.equal(other?.store, "none", "an ordinary rule does use the shared store (and fails open)");
    assert.equal(touched.length, 1);
  } finally {
    setStore(null);
  }
});

const call = (path: string, ip: string, method = "GET") =>
  proxy(new NextRequest(`http://localhost:3000${path}`, { method, headers: { "x-forwarded-for": ip } }));

test("proxy: probes are limited per address with their own budget and skip the global ceiling", async () => {
  const savedMultiplier = process.env.RATE_LIMIT_MULTIPLIER;
  const savedHeader = process.env.CLIENT_IP_HEADER;
  delete process.env.CLIENT_IP_HEADER;
  // Shrink every limit by 100x so the test can reach them: health 60/min, ready 12/min, global ceiling 3/min.
  process.env.RATE_LIMIT_MULTIPLIER = "0.01";
  setStore(new MemoryStore());
  try {
    // Ordinary API traffic from address A (a path with no route rule of its own) trips the shrunk global ceiling
    // after 3 requests...
    const flood = "198.51.100.10";
    const codes: number[] = [];
    for (let i = 0; i < 5; i++) codes.push((await call("/api/no-route-rule", flood)).status);
    assert.deepEqual(codes.slice(0, 3), [200, 200, 200]);
    assert.equal(codes[4], 429, "the global per-IP ceiling applies to normal routes");

    // ...but the same address can still be probed: probes have their own rule and skip the global one.
    const res = await call("/api/health", flood);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("RateLimit-Limit"), "60", "the health rule, not the 3/min global ceiling");

    // Readiness has its own, tighter budget (12/min here); it is exhausted per address, and other addresses are unaffected.
    const prober = "198.51.100.20";
    const statuses: number[] = [];
    for (let i = 0; i < 14; i++) statuses.push((await call("/api/ready", prober)).status);
    assert.equal(statuses.filter((s) => s === 200).length, 12);
    assert.equal(statuses[13], 429);
    assert.equal((await call("/api/ready", "198.51.100.21")).status, 200, "another prober is unaffected");
    assert.equal((await call("/api/health", prober)).status, 200, "liveness has a separate bucket from readiness");
  } finally {
    setStore(null);
    if (savedMultiplier === undefined) delete process.env.RATE_LIMIT_MULTIPLIER;
    else process.env.RATE_LIMIT_MULTIPLIER = savedMultiplier;
    if (savedHeader !== undefined) process.env.CLIENT_IP_HEADER = savedHeader;
  }
});

test("proxy: a POST to a probe path is not exempt from the cross-site check", async () => {
  const res = await proxy(new NextRequest("http://localhost:3000/api/health", { method: "POST", headers: { origin: "https://evil.example", "x-forwarded-for": "198.51.100.30" } }));
  assert.equal(res.status, 403);
});
