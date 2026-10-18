import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { validateEnv, type EnvRecord } from "../lib/env";

/**
 * doc/15: GOOGLE_CLIENT_MODE and EMAIL_PROVIDER=none in the start-up validation. Pure: the validator takes an env record.
 */

const good: EnvRecord = {
  NODE_ENV: "production",
  DATABASE_URL: "postgresql://app:db-password-1@db.example.com:5432/sessions",
  APP_URL: "https://sessions.example.com",
  APP_SECRET: randomBytes(32).toString("base64"),
  TOKEN_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
  REDIS_URL: "rediss://default:redis-password-1@redis.example.com:6379",
  RAZORPAY_KEY_ID: "rzp_live_abc123",
  RAZORPAY_KEY_SECRET: "razorpay-secret-1",
  RAZORPAY_WEBHOOK_SECRET: "razorpay-webhook-1",
  EMAIL_PROVIDER: "resend",
  RESEND_API_KEY: "re_123",
  EMAIL_FROM: "Bookings <bookings@example.com>",
  CLIENT_IP_HEADER: "x-real-ip",
};

const without = (...keys: string[]): EnvRecord => {
  const e = { ...good };
  for (const k of keys) delete e[k];
  return e;
};

test("GOOGLE_CLIENT_MODE: own (the default), platform and either are accepted, case does not matter, anything else is named", () => {
  for (const mode of ["own", "platform", "either", "OWN", "Either"]) {
    assert.deepEqual(validateEnv({ ...good, GOOGLE_CLIENT_MODE: mode }).errors, [], mode);
  }
  assert.equal(validateEnv(good).config.google.clientMode, "own", "unset means the default: influencers bring their own client");
  assert.equal(validateEnv({ ...good, GOOGLE_CLIENT_MODE: "either" }).config.google.clientMode, "either");
  const bad = validateEnv({ ...good, GOOGLE_CLIENT_MODE: "shared" });
  assert.ok(bad.errors.some((e) => e.startsWith("GOOGLE_CLIENT_MODE:") && e.includes("own, platform, either")), bad.errors.join("\n"));
  assert.deepEqual(validateEnv({ ...good, GOOGLE_CLIENT_MODE: "" }).errors, [], "a blank value is the default");
});

test("in the default mode there is no start-up warning about the shared Google pair being unset", () => {
  const r = validateEnv(good);
  assert.ok(!r.warnings.some((w) => w.startsWith("GOOGLE_CLIENT_ID")), r.warnings.join("\n"));
  const withPair = validateEnv({ ...good, GOOGLE_CLIENT_ID: "x", GOOGLE_CLIENT_SECRET: "y" });
  assert.ok(withPair.warnings.some((w) => w.startsWith("GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET:") && w.includes("GOOGLE_CLIENT_MODE=own")), "a pair that mode own will not use is said so");
  const platform = validateEnv({ ...good, GOOGLE_CLIENT_MODE: "platform" });
  assert.ok(platform.warnings.some((w) => w.startsWith("GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET:") && w.includes("platform")));
  const platformOk = validateEnv({ ...good, GOOGLE_CLIENT_MODE: "platform", GOOGLE_CLIENT_ID: "x", GOOGLE_CLIENT_SECRET: "y" });
  assert.ok(!platformOk.warnings.some((w) => w.startsWith("GOOGLE_CLIENT_ID")));
});

test("the redirect URI host warning stays, whatever the mode", () => {
  const r = validateEnv({ ...good, GOOGLE_REDIRECT_URI: "https://elsewhere.example.com/api/google/callback" });
  assert.ok(r.warnings.some((w) => w.startsWith("GOOGLE_REDIRECT_URI:") && w.includes("different host")), r.warnings.join("\n"));
  const same = validateEnv({ ...good, GOOGLE_REDIRECT_URI: "https://sessions.example.com/api/google/callback" });
  assert.ok(!same.warnings.some((w) => w.startsWith("GOOGLE_REDIRECT_URI:")));
});

test("EMAIL_PROVIDER=none is accepted in production with exactly one clear warning, and needs no provider keys", () => {
  const r = validateEnv({ ...without("RESEND_API_KEY", "EMAIL_FROM"), EMAIL_PROVIDER: "none" });
  assert.deepEqual(r.errors, []);
  const mine = r.warnings.filter((w) => w.startsWith("EMAIL_PROVIDER:"));
  assert.equal(mine.length, 1, mine.join("\n"));
  assert.match(mine[0], /sends no e-mail/);
  assert.match(mine[0], /Gmail/);
  assert.equal(r.config.email.provider, "none");
  assert.ok(!validateEnv(good).warnings.some((w) => w.startsWith("EMAIL_PROVIDER:")), "a real provider has no such warning");
  assert.deepEqual(validateEnv({ ...without("RESEND_API_KEY", "EMAIL_FROM"), EMAIL_PROVIDER: "NONE" }).errors, [], "case does not matter");
});

test("EMAIL_PROVIDER=log is still refused in production, and the message offers none as the way out", () => {
  const r = validateEnv({ ...good, EMAIL_PROVIDER: "log" });
  assert.ok(r.errors.some((e) => e.startsWith("EMAIL_PROVIDER:") && e.includes('"none"')), r.errors.join("\n"));
  assert.ok(validateEnv({ ...without("EMAIL_PROVIDER") }).errors.some((e) => e.startsWith("EMAIL_PROVIDER:")), "unset still means log, which is refused");
});

test("EMAIL_PROVIDER=none with trailing whitespace is rejected by name like any other padded value", () => {
  const r = validateEnv({ ...good, EMAIL_PROVIDER: "none\n" });
  assert.ok(r.errors.some((e) => e.startsWith("EMAIL_PROVIDER:") && e.includes("whitespace")), r.errors.join("\n"));
});

test("in development EMAIL_PROVIDER=none is quiet about being a problem (it is a choice, not a mistake)", () => {
  const r = validateEnv({ NODE_ENV: "development", EMAIL_PROVIDER: "none" });
  assert.equal(r.errors.length, 0);
  assert.equal(r.config.email.provider, "none");
});
