import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { KNOWN_ENV_VARS, validateEnv, type EnvRecord } from "../lib/env";
import { GLOBAL_API_RULE, ROUTE_RULES, matchRouteRule, scaled } from "../lib/rate-limit/policies";
import { consume, MemoryStore } from "../lib/rate-limit/core";
import { QR_DEFAULTS, QR_MIN_GAP_CEILING_MS, QR_MIN_GAP_FLOOR_MS, qrFakeRefusal, qrGapClamp, readQrConfig } from "../lib/whatsapp-web/config";
import { CONSENT_VERSION, RISK_TEXT } from "../lib/whatsapp-web/types";

// Pure tests: nothing here reads the real environment, the database or Redis.

for (const name of KNOWN_ENV_VARS) delete process.env[name];

const KEY = randomBytes(32).toString("base64");
const APP_SECRET = randomBytes(32).toString("base64");

const production: EnvRecord = {
  NODE_ENV: "production",
  DATABASE_URL: "postgresql://app:db-password-1@db.example.com:5432/sessions",
  APP_URL: "https://sessions.example.com",
  APP_SECRET,
  TOKEN_ENCRYPTION_KEY: KEY,
  REDIS_URL: "rediss://default:redis-password-1@redis.example.com:6379",
  RAZORPAY_KEY_ID: "rzp_live_abc123",
  RAZORPAY_KEY_SECRET: "razorpay-secret-1",
  RAZORPAY_WEBHOOK_SECRET: "razorpay-webhook-1",
  EMAIL_PROVIDER: "resend",
  RESEND_API_KEY: "re_123",
  EMAIL_FROM: "Bookings <bookings@example.com>",
  CLIENT_IP_HEADER: "x-real-ip",
};

const development: EnvRecord = {
  NODE_ENV: "development",
  DATABASE_URL: production.DATABASE_URL,
  APP_URL: "http://localhost:3000",
  APP_SECRET,
  TOKEN_ENCRYPTION_KEY: KEY,
};

test("every WHATSAPP_QR_* setting is a known environment variable", () => {
  for (const name of ["WHATSAPP_QR_ENABLED", "WHATSAPP_QR_FAKE", "WHATSAPP_QR_MAX_SESSIONS", "WHATSAPP_QR_DAILY_CAP", "WHATSAPP_QR_MIN_GAP_MS", "WHATSAPP_QR_KEEP_AUTH_WHEN_DISABLED"]) {
    assert.ok((KNOWN_ENV_VARS as readonly string[]).includes(name), name);
  }
});

test("an unset or EMPTY setting means the default, never 0", () => {
  for (const env of [{}, { WHATSAPP_QR_MAX_SESSIONS: "", WHATSAPP_QR_DAILY_CAP: "", WHATSAPP_QR_MIN_GAP_MS: "", WHATSAPP_QR_ENABLED: "", WHATSAPP_QR_FAKE: "", WHATSAPP_QR_KEEP_AUTH_WHEN_DISABLED: "" }, { WHATSAPP_QR_DAILY_CAP: "   " }]) {
    assert.deepEqual(readQrConfig(env), {
      enabled: false,
      fake: false,
      maxSessions: QR_DEFAULTS.maxSessions,
      dailyCap: QR_DEFAULTS.dailyCap,
      minGapMs: QR_DEFAULTS.minGapMs,
      keepAuthWhenDisabled: false,
    });
  }
  assert.deepEqual([QR_DEFAULTS.maxSessions, QR_DEFAULTS.dailyCap, QR_DEFAULTS.minGapMs], [10, 150, 4000]);
});

test("values are read as given, and a bad value falls back to the default instead of loosening a limit", () => {
  const c = readQrConfig({ WHATSAPP_QR_ENABLED: "true", WHATSAPP_QR_MAX_SESSIONS: "3", WHATSAPP_QR_DAILY_CAP: "40", WHATSAPP_QR_MIN_GAP_MS: "9000", WHATSAPP_QR_KEEP_AUTH_WHEN_DISABLED: "true" });
  assert.deepEqual(c, { enabled: true, fake: false, maxSessions: 3, dailyCap: 40, minGapMs: 9000, keepAuthWhenDisabled: true });
  for (const bad of ["0", "-5", "abc", "1.5", "1e3"]) {
    const d = readQrConfig({ WHATSAPP_QR_MAX_SESSIONS: bad, WHATSAPP_QR_DAILY_CAP: bad, WHATSAPP_QR_MIN_GAP_MS: bad });
    assert.deepEqual([d.maxSessions, d.dailyCap, d.minGapMs], [QR_DEFAULTS.maxSessions, QR_DEFAULTS.dailyCap, QR_DEFAULTS.minGapMs], bad);
  }
  assert.equal(readQrConfig({ WHATSAPP_QR_MIN_GAP_MS: String(QR_MIN_GAP_FLOOR_MS - 1) }).minGapMs, QR_DEFAULTS.minGapMs, "a spacing under the floor is not honoured");
  assert.equal(readQrConfig({ WHATSAPP_QR_MIN_GAP_MS: String(QR_MIN_GAP_FLOOR_MS) }).minGapMs, QR_MIN_GAP_FLOOR_MS);
  assert.equal(readQrConfig({ WHATSAPP_QR_ENABLED: "yes" }).enabled, false, "only the word true switches it on");
});

test("the spacing is capped below 15 s: a larger value is lowered, with a warning, because a gap over 20 s would make every message inside it go another way", () => {
  assert.equal(QR_MIN_GAP_CEILING_MS, 14_000);
  assert.equal(readQrConfig({ WHATSAPP_QR_MIN_GAP_MS: "14000" }).minGapMs, 14_000);
  assert.equal(readQrConfig({ WHATSAPP_QR_MIN_GAP_MS: "14001" }).minGapMs, 14_000);
  assert.equal(readQrConfig({ WHATSAPP_QR_MIN_GAP_MS: "60000" }).minGapMs, 14_000);
  assert.equal(readQrConfig({ WHATSAPP_QR_MIN_GAP_MS: "3600000" }).minGapMs, 14_000);
  assert.equal(qrGapClamp({ WHATSAPP_QR_MIN_GAP_MS: "14000" }), null);
  assert.equal(qrGapClamp({}), null);
  assert.equal(qrGapClamp({ WHATSAPP_QR_MIN_GAP_MS: "abc" }), null);
  assert.match(qrGapClamp({ WHATSAPP_QR_MIN_GAP_MS: "60000" })!, /lowered to 14000 ms/);
  const r = validateEnv({ ...production, WHATSAPP_QR_MIN_GAP_MS: "60000" });
  assert.ok(r.warnings.some((w) => /^WHATSAPP_QR_MIN_GAP_MS: is lowered to 14000 ms/.test(w)), "the start-up warning");
  assert.ok(!r.errors.some((e) => e.startsWith("WHATSAPP_QR_MIN_GAP_MS")), "and not an error: the process starts");
  assert.ok(!validateEnv({ ...production, WHATSAPP_QR_MIN_GAP_MS: "9000" }).warnings.some((w) => w.startsWith("WHATSAPP_QR_MIN_GAP_MS")));
});

test("the simulator is accepted only outside production with a local APP_URL", () => {
  const ok = { WHATSAPP_QR_FAKE: "true", NODE_ENV: "development", APP_URL: "http://localhost:3000" };
  assert.equal(readQrConfig(ok).fake, true);
  assert.equal(qrFakeRefusal(ok), null);
  assert.equal(readQrConfig({ ...ok, NODE_ENV: undefined }).fake, true, "NODE_ENV unset is not production");
  assert.equal(readQrConfig({ ...ok, NODE_ENV: "test" }).fake, true);
  assert.equal(readQrConfig({ ...ok, NODE_ENV: "production" }).fake, false);
  assert.match(qrFakeRefusal({ ...ok, NODE_ENV: "production" })!, /production/);
  assert.equal(readQrConfig({ ...ok, APP_URL: "https://sessions.example.com" }).fake, false);
  assert.equal(readQrConfig({ ...ok, APP_URL: undefined }).fake, false, "an unset APP_URL does not count as local");
  assert.equal(readQrConfig({ ...ok, WHATSAPP_QR_FAKE: "" }).fake, false);
  assert.equal(qrFakeRefusal({}), null, "nothing requested, nothing refused");
});

test("validateEnv: a complete production environment stays valid with the QR mode on, and says so", () => {
  const r = validateEnv({ ...production, WHATSAPP_QR_ENABLED: "true", WHATSAPP_QR_DAILY_CAP: "100" });
  assert.deepEqual(r.errors, []);
  assert.ok(r.warnings.some((w) => w.startsWith("WHATSAPP_QR_ENABLED") && /unofficial/.test(w)));
  assert.deepEqual(validateEnv({ ...production, WHATSAPP_QR_ENABLED: "", WHATSAPP_QR_MAX_SESSIONS: "" }).errors, [], "empty values are unset, not errors");
});

test("validateEnv: WHATSAPP_QR_FAKE is refused in production, even for a local run", () => {
  const r = validateEnv({ ...production, WHATSAPP_QR_FAKE: "true" });
  assert.equal(r.errors.length, 1);
  assert.match(r.errors[0], /^WHATSAPP_QR_FAKE: /);
  const local = validateEnv({ ...production, APP_URL: "http://localhost:3000", ALLOW_INSECURE_LOCAL_RUN: "true", EMAIL_PROVIDER: "log", WHATSAPP_QR_FAKE: "true" });
  assert.ok(local.errors.some((e) => e.startsWith("WHATSAPP_QR_FAKE")), "ALLOW_INSECURE_LOCAL_RUN does not excuse it");
});

test("validateEnv: in development the simulator is explained, never an error", () => {
  assert.deepEqual(validateEnv({ ...development, WHATSAPP_QR_ENABLED: "true", WHATSAPP_QR_FAKE: "true" }).errors, []);
  const active = validateEnv({ ...development, WHATSAPP_QR_ENABLED: "true", WHATSAPP_QR_FAKE: "true" });
  assert.ok(active.warnings.some((w) => /WHATSAPP_QR_FAKE: ACTIVE/.test(w)));
  const idle = validateEnv({ ...development, WHATSAPP_QR_FAKE: "true" });
  assert.ok(idle.warnings.some((w) => /no effect without WHATSAPP_QR_ENABLED/.test(w)));
  const remote = validateEnv({ ...development, APP_URL: "https://staging.example.com", WHATSAPP_QR_ENABLED: "true", WHATSAPP_QR_FAKE: "true" });
  assert.ok(remote.warnings.some((w) => /WHATSAPP_QR_FAKE: ignored/.test(w)));
});

test("validateEnv: malformed QR settings are reported by name, without echoing the value", () => {
  for (const [name, value] of [["WHATSAPP_QR_ENABLED", "yes"], ["WHATSAPP_QR_MAX_SESSIONS", "0"], ["WHATSAPP_QR_DAILY_CAP", "lots"], ["WHATSAPP_QR_MIN_GAP_MS", "500"], ["WHATSAPP_QR_KEEP_AUTH_WHEN_DISABLED", "1"]] as const) {
    const r = validateEnv({ ...production, [name]: value });
    assert.ok(r.errors.some((e) => e.startsWith(`${name}: `)), name);
    assert.ok(r.errors.every((e) => !e.includes(`"${value}"`)), "the value is not echoed");
  }
  assert.ok(validateEnv({ ...production, WHATSAPP_QR_DAILY_CAP: " 100" }).errors.some((e) => /whitespace/.test(e)), "padding is rejected like everywhere else");
});

test("the consent contract: a versioned plain-language risk statement", () => {
  assert.match(CONSENT_VERSION, /^wa-web-/);
  for (const word of [/unofficial/i, /ban/i, /replies/i, /encrypted/i, /disconnect/i, /official/i, /booking/i]) assert.match(RISK_TEXT, word);
});

// ---- rate-limit policy for the endpoints implementer 2 adds -------------------------------------------------------------

test("route rules: the QR-code WhatsApp endpoints have their own budgets, ahead of the catch-alls", () => {
  const read = matchRouteRule("GET", "/api/dashboard/whatsapp-web")!;
  assert.equal(read.name, "dashboard-whatsapp-web-read");
  assert.equal(matchRouteRule("HEAD", "/api/dashboard/whatsapp-web")?.name, "dashboard-whatsapp-web-read");
  assert.equal(read.by, "session-or-ip");
  assert.ok(read.limit / (read.windowMs / 60_000) >= 30, "the 2 s status poll (30 a minute) fits with headroom");
  assert.equal(read.limit, 60);
  const write = matchRouteRule("POST", "/api/dashboard/whatsapp-web")!;
  assert.equal(write.name, "dashboard-whatsapp-web");
  assert.equal(write.limit, 10);
  assert.equal(write.windowMs, 60_000);
  assert.equal(matchRouteRule("DELETE", "/api/dashboard/whatsapp-web")?.name, "dashboard-whatsapp-web");
  assert.equal(matchRouteRule("POST", "/api/dashboard/whatsapp-web/test")?.name, "dashboard-whatsapp-web");
  // The official connection keeps its own rule and the new rules do not capture it.
  assert.equal(matchRouteRule("POST", "/api/dashboard/whatsapp")?.name, "dashboard-whatsapp");
  assert.equal(matchRouteRule("GET", "/api/dashboard/whatsapp")?.name, "dashboard");
  assert.equal(matchRouteRule("GET", "/api/dashboard/whatsapp-webhook")?.name, "dashboard", "only the exact path or a sub-path matches");

  const adminWrite = matchRouteRule("POST", "/api/admin/whatsapp-web/abc/disconnect")!;
  assert.equal(adminWrite.name, "admin-whatsapp-web");
  assert.equal(adminWrite.by, "ip");
  assert.equal(matchRouteRule("POST", "/api/admin/whatsapp-web")?.name, "admin-whatsapp-web");
  assert.equal(matchRouteRule("GET", "/api/admin/whatsapp-web")?.name, "admin", "reads share the general admin budget");
  assert.equal(matchRouteRule("POST", "/api/admin/whatsapp-webhook")?.name, "admin");

  const names = ROUTE_RULES.map((r) => r.name);
  assert.equal(new Set(names).size, names.length, "rule names are unique");
  assert.ok(GLOBAL_API_RULE.limit > read.limit);
});

test("route rules: the status poll is allowed, the write budget is enforced and scaled by RATE_LIMIT_MULTIPLIER", async () => {
  const store = new MemoryStore();
  const now = Date.UTC(2026, 10, 9, 10, 0, 30);
  const read =matchRouteRule("GET", "/api/dashboard/whatsapp-web")!;
  let blocked = 0;
  // Two minutes of 2-second polling = 60 requests: inside the budget of one minute for the first 30 and again the next minute.
  for (let i = 0; i < 30; i++) if (!(await consume(store, read, "user-1", { now })).allowed) blocked++;
  assert.equal(blocked, 0);
  const write = matchRouteRule("POST", "/api/dashboard/whatsapp-web")!;
  const results: boolean[] = [];
  for (let i = 0; i < 12; i++) results.push((await consume(store, write, "user-2", { now })).allowed);
  assert.deepEqual(results.filter(Boolean).length, 10, "the 11th and 12th POST in a minute are refused");
  assert.equal(scaled(write, 2).limit, 20);
});
