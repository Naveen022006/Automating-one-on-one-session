import assert from "node:assert/strict";
import { test } from "node:test";
import { clientIp, normaliseIp } from "../lib/rate-limit/client-ip";
import { FailoverStore, MemoryStore, consume, evaluate, rateLimitHeaders, windowStartFor, type RateLimitStore } from "../lib/rate-limit/core";
import { GLOBAL_API_RULE, ROUTE_RULES, matchRouteRule, scaled } from "../lib/rate-limit/policies";
import { PostgresStore, RedisStore } from "../lib/rate-limit/stores";

// Pure tests: no Redis, no Postgres. The real stores are exercised with fakes of their client interfaces.

const rule = { name: "t", limit: 3, windowMs: 60_000 };

test("allows up to the limit, then denies with Retry-After", async () => {
  const store = new MemoryStore();
  const now = windowStartFor(Date.now(), rule.windowMs) + 1_000;
  const results: Awaited<ReturnType<typeof consume>>[] = [];
  for (let i = 0; i < 4; i++) results.push(await consume(store, rule, "ip:1", { now }));
  assert.deepEqual(results.map((r) => r.allowed), [true, true, true, false]);
  assert.equal(results[2].remaining, 0);
  assert.ok(results[3].retryAfterSec >= 1);
  assert.equal(rateLimitHeaders(results[3])["Retry-After"], String(results[3].retryAfterSec));
  assert.equal(rateLimitHeaders(results[0])["Retry-After"], undefined);
});

test("identifiers are counted separately", async () => {
  const store = new MemoryStore();
  for (let i = 0; i < 3; i++) await consume(store, rule, "ip:a");
  assert.equal((await consume(store, rule, "ip:a")).allowed, false);
  assert.equal((await consume(store, rule, "ip:b")).allowed, true);
});

test("sliding window weights the previous bucket by the time left in it", () => {
  // 25% into the current window, previous bucket full (3), current has 1: weight = 3*0.75 + 1 = 3.25 > 3.
  const start = 600_000;
  const denied = evaluate(rule, { previous: 3, current: 1 }, start + 15_000, start);
  assert.equal(denied.allowed, false);
  // 90% into the window the previous bucket has mostly decayed: 3*0.1 + 2 = 2.3 <= 3.
  const allowed = evaluate(rule, { previous: 3, current: 2 }, start + 54_000, start);
  assert.equal(allowed.allowed, true);
});

test("a failing store fails open and reports the error", async () => {
  const broken: RateLimitStore = { name: "broken", hit: async () => Promise.reject(new Error("down")) };
  let reported: unknown = null;
  const r = await consume(broken, rule, "x", { onError: (e) => (reported = e) });
  assert.equal(r.allowed, true);
  assert.equal(r.store, "none");
  assert.ok(reported instanceof Error);
});

test("failover uses the secondary store while the primary is down, and skips the primary during cooldown", async () => {
  let primaryCalls = 0;
  const primary: RateLimitStore = {
    name: "redis",
    hit: async () => {
      primaryCalls++;
      throw new Error("ECONNREFUSED");
    },
  };
  const secondary = new MemoryStore();
  let failovers = 0;
  const store = new FailoverStore(primary, secondary, { cooldownMs: 60_000, onFailover: () => failovers++ });
  for (let i = 0; i < 4; i++) await consume(store, rule, "ip:z");
  assert.equal(primaryCalls, 1, "primary tried once, then skipped during cooldown");
  assert.equal(failovers, 1);
  assert.equal((await consume(store, rule, "ip:z")).allowed, false, "secondary still enforces the limit");
  assert.equal(store.name, "memory");
});

test("RedisStore runs one atomic script over both buckets with a hash-tagged key", async () => {
  const calls: unknown[][] = [];
  const store = new RedisStore({
    eval: async (...args: unknown[]) => {
      calls.push(args);
      return [2, 5];
    },
  });
  const counts = await store.hit("login:ip:1", 120_000, 60_000);
  assert.deepEqual(counts, { current: 2, previous: 5 });
  const [script, numKeys, k1, k2, ttl] = calls[0];
  assert.match(String(script), /INCR/);
  assert.equal(numKeys, 2);
  assert.equal(k1, "rl:{login:ip:1}:120000");
  assert.equal(k2, "rl:{login:ip:1}:60000");
  assert.equal(ttl, 120_000);
});

test("PostgresStore upserts the current bucket and reads the previous one in one statement", async () => {
  const seen: { sql: string; params: unknown[] }[] = [];
  const store = new PostgresStore(async <T,>(sql: string, ...params: unknown[]) => {
    seen.push({ sql, params });
    return [{ current: BigInt(4), previous: 1 }] as unknown as T[];
  });
  const counts = await store.hit("hold:ip:9", 180_000, 60_000);
  assert.deepEqual(counts, { current: 4, previous: 1 });
  assert.match(seen[0].sql, /ON CONFLICT \(key, window_start\) DO UPDATE/);
  assert.equal(seen[0].params[0], "hold:ip:9");
  assert.equal(Date.parse(seen[0].params[1] as string), 180_000);
  assert.equal(Date.parse(seen[0].params[2] as string), 300_000, "expires after two windows");
  assert.equal(Date.parse(seen[0].params[3] as string), 120_000, "previous bucket");
  assert.match(seen[0].sql, /AT TIME ZONE 'UTC'/);
});

test("every API family has a route rule, auth endpoints are strict", () => {
  const cases: [string, string, string][] = [
    ["POST", "/api/auth/login", "auth-login"],
    ["POST", "/api/auth/register", "auth-register"],
    ["POST", "/api/auth/forgot-password", "auth-forgot"],
    ["POST", "/api/auth/reset-password", "auth-reset"],
    ["GET", "/api/auth/sessions", "auth-other"],
    ["POST", "/api/bookings/hold", "hold"],
    ["POST", "/api/checkout", "checkout"],
    ["GET", "/api/bookings/abc", "booking-status"],
    ["GET", "/api/bookings/abc/ics", "booking-status"],
    ["POST", "/api/bookings/abc/resend", "booking-resend"],
    ["POST", "/api/bookings/abc/cancel", "booking-actions"],
    ["GET", "/api/slots", "slots"],
    ["GET", "/api/slots/days", "slots"],
    ["POST", "/api/manage/tok", "self-service"],
    ["POST", "/api/webhooks/payment", "webhooks"],
    ["GET", "/api/google/connect", "google-oauth"],
    ["POST", "/api/dashboard/bookings/abc/refund", "dashboard-refund"],
    ["GET", "/api/dashboard/earnings/export", "dashboard-export"],
    ["PATCH", "/api/dashboard/services", "dashboard"],
  ];
  for (const [method, path, name] of cases) assert.equal(matchRouteRule(method, path)?.name, name, `${method} ${path}`);
  assert.equal(matchRouteRule("GET", "/api/auth/login")?.name, "auth-other", "GET login is not the POST rule");
  assert.ok(matchRouteRule("POST", "/api/auth/login")!.limit <= 10);
  assert.ok(GLOBAL_API_RULE.limit > 0);
  assert.equal(scaled({ name: "x", limit: 10, windowMs: 1 }, 2).limit, 20);
});

test("SPA view endpoints: each new rule matches its path, the right method, and sits before the broader rule it must not fall into", () => {
  // The four rules added for the React SPA (doc/10-react-migration-plan.md, section 5).
  const cases: [string, string, string][] = [
    ["GET", "/api/auth/session", "auth-session"],
    ["GET", "/api/public/profiles/demo", "public-profile"],
    ["GET", "/api/pay/sometoken", "pay-view"],
    ["GET", "/api/manage/sometoken", "self-service-view"],
  ];
  for (const [method, path, name] of cases) assert.equal(matchRouteRule(method, path)?.name, name, `${method} ${path}`);

  // auth-session must not swallow its neighbours, and must beat auth-other (60 per 15 minutes would be used up by browsing).
  assert.equal(matchRouteRule("GET", "/api/auth/sessions")?.name, "auth-other", "the devices list is a different endpoint");
  assert.equal(matchRouteRule("POST", "/api/auth/session")?.name, "auth-other", "only GET is the cheap session check");
  assert.equal(matchRouteRule("GET", "/api/auth/session/x")?.name, "auth-other");
  assert.equal(matchRouteRule("GET", "/api/auth/session")?.by, "session-or-ip");
  const rate = (m: string, p: string) => matchRouteRule(m, p)!.limit / matchRouteRule(m, p)!.windowMs;
  assert.ok(rate("GET", "/api/auth/session") > rate("GET", "/api/auth/sessions") * 10, "the session check has a much wider budget than auth-other");
  const session = matchRouteRule("GET", "/api/auth/session")!;
  assert.deepEqual([session.limit, session.windowMs], [120, 60_000]);

  // Page-load budgets are separate from the action budgets: viewing the manage page must not eat the 20 per 10 minutes for actions.
  const view = matchRouteRule("GET", "/api/manage/tok")!;
  const action = matchRouteRule("POST", "/api/manage/tok")!;
  assert.equal(action.name, "self-service");
  assert.equal(matchRouteRule("PATCH", "/api/manage/tok")?.name, "self-service");
  assert.equal(matchRouteRule("GET", "/api/manage/tok/slots")?.name, "self-service", "sub-paths keep the action rule");
  assert.ok(view.limit > action.limit);
  const names = ROUTE_RULES.map((r) => r.name);
  assert.ok(names.indexOf("self-service-view") < names.indexOf("self-service"));
  assert.ok(names.indexOf("auth-session") < names.indexOf("auth-other"));
  assert.deepEqual([matchRouteRule("GET", "/api/public/profiles/demo")!.limit, matchRouteRule("GET", "/api/pay/t")!.limit], [120, 30]);
  assert.equal(matchRouteRule("POST", "/api/public/profiles/demo"), null, "no write method is rule-matched here (the handler does not exist)");
  assert.equal(matchRouteRule("GET", "/api/public/profiles/a/b"), null, "one segment only");
});

test("SPA dashboard and admin view endpoints fall under the generic dashboard / admin rules, not under a narrower money or security rule", () => {
  const dashboardGets = [
    "shell", "overview", "sessions", "messages", "customers", "earnings", "services", "availability", "payouts", "settings", "onboarding", "payout-account",
  ];
  for (const p of dashboardGets) assert.equal(matchRouteRule("GET", `/api/dashboard/${p}`)?.name, "dashboard", `GET /api/dashboard/${p}`);
  assert.equal(matchRouteRule("GET", "/api/dashboard/earnings/export")?.name, "dashboard-export", "the CSV export keeps its tight rule");
  assert.equal(matchRouteRule("PUT", "/api/dashboard/payout-account")?.name, "dashboard-payout-account", "the write keeps its rule, the new GET does not");

  const adminGets = [
    "session", "shell", "overview", "influencers", "influencers/abc", "security", "payments", "payouts", "bookings", "health", "audit",
  ];
  for (const p of adminGets) assert.equal(matchRouteRule("GET", `/api/admin/${p}`)?.name, "admin", `GET /api/admin/${p}`);
  // The same paths with a write method keep the tight rules.
  assert.equal(matchRouteRule("POST", "/api/admin/security/2fa")?.name, "admin-security");
  assert.equal(matchRouteRule("POST", "/api/admin/payouts/abc")?.name, "admin-money");
  assert.equal(matchRouteRule("POST", "/api/admin/payments/reconcile")?.name, "admin-reconcile");
  assert.equal(matchRouteRule("POST", "/api/admin/auth/login")?.name, "admin-login");
});

test("client IPs are normalised; IPv6 is grouped by /64", () => {
  assert.equal(normaliseIp("203.0.113.7"), "203.0.113.7");
  assert.equal(normaliseIp("::ffff:203.0.113.7"), "203.0.113.7");
  assert.equal(normaliseIp("203.0.113.7:51234"), "203.0.113.7");
  assert.equal(normaliseIp("2001:db8:abcd:12:1:2:3:4"), "2001:db8:abcd:12::/64");
  assert.equal(normaliseIp("2001:db8:abcd:12::99"), "2001:db8:abcd:12::/64");
  assert.equal(normaliseIp("[2001:db8::1]"), "2001:db8:0:0::/64");
});

test("client IP comes only from headers a client cannot forge", () => {
  const prev = process.env.CLIENT_IP_HEADER;
  try {
    delete process.env.CLIENT_IP_HEADER;
    // Default: the right-most X-Forwarded-For entry (appended by our own proxy); client-supplied entries and
    // client-settable headers are ignored.
    const spoofed = new Headers({ "x-forwarded-for": "1.1.1.1, 2.2.2.2, 203.0.113.9", "cf-connecting-ip": "9.9.9.9", "x-real-ip": "8.8.8.8" });
    assert.equal(clientIp(spoofed), "203.0.113.9");
    assert.equal(clientIp(new Headers({ "x-real-ip": "8.8.8.8" })), "unknown", "x-real-ip is not trusted unless configured");

    process.env.CLIENT_IP_HEADER = "cf-connecting-ip";
    assert.equal(clientIp(spoofed), "9.9.9.9", "the configured platform header is trusted exclusively");
    process.env.CLIENT_IP_HEADER = "x-forwarded-for";
    assert.equal(clientIp(spoofed), "203.0.113.9");
  } finally {
    if (prev === undefined) delete process.env.CLIENT_IP_HEADER;
    else process.env.CLIENT_IP_HEADER = prev;
  }
});
