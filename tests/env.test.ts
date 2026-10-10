import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { keyFingerprint } from "../lib/crypto";
import { EnvValidationError, KNOWN_ENV_VARS, getConfig, initEnv, initEnvOrExit, resetConfigForTests, validateEnv, type EnvRecord } from "../lib/env";

// Pure tests: the validator takes an env record, so nothing here reads or changes the real environment
// (except the few tests of the process wiring, which restore process.env).

const KEY = randomBytes(32).toString("base64");
const APP_SECRET = randomBytes(32).toString("base64");

/** A complete, valid production environment. Each test breaks one thing. */
const good: EnvRecord = {
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

const without = (...keys: string[]): EnvRecord => {
  const e = { ...good };
  for (const k of keys) delete e[k];
  return e;
};

test("a complete production environment has no errors", () => {
  const r = validateEnv(good);
  assert.deepEqual(r.errors, []);
  assert.equal(r.production, true);
  assert.equal(r.config.isProduction, true);
  assert.equal(r.config.appUrl, "https://sessions.example.com");
});

// Each case changes one thing and expects exactly that variable to be reported.
const failures: [string, EnvRecord, string][] = [
  ["DATABASE_URL missing", without("DATABASE_URL"), "DATABASE_URL"],
  ["DATABASE_URL too short", { ...good, DATABASE_URL: "postgres://x" }, "DATABASE_URL"],
  ["DATABASE_URL not postgres", { ...good, DATABASE_URL: "mysql://app:pw@db.example.com/sessions" }, "DATABASE_URL"],
  ["APP_URL missing", without("APP_URL"), "APP_URL"],
  ["APP_URL not https", { ...good, APP_URL: "http://sessions.example.com" }, "APP_URL"],
  ["APP_URL not a URL", { ...good, APP_URL: "sessions.example.com" }, "APP_URL"],
  ["APP_SECRET missing", without("APP_SECRET"), "APP_SECRET"],
  ["APP_SECRET shorter than 32", { ...good, APP_SECRET: "a".repeat(31) }, "APP_SECRET"],
  ["TOKEN_ENCRYPTION_KEY missing", without("TOKEN_ENCRYPTION_KEY"), "TOKEN_ENCRYPTION_KEY"],
  ["TOKEN_ENCRYPTION_KEY wrong length", { ...good, TOKEN_ENCRYPTION_KEY: randomBytes(16).toString("base64") }, "TOKEN_ENCRYPTION_KEY"],
  ["TOKEN_ENCRYPTION_KEY not base64", { ...good, TOKEN_ENCRYPTION_KEY: "!!!not-base64!!!" }, "TOKEN_ENCRYPTION_KEY"],
  ["TOKEN_ENCRYPTION_KEY_PREVIOUS malformed", { ...good, TOKEN_ENCRYPTION_KEY_PREVIOUS: "short" }, "TOKEN_ENCRYPTION_KEY_PREVIOUS"],
  ["REDIS_URL missing", without("REDIS_URL"), "REDIS_URL"],
  ["REDIS_URL wrong scheme", { ...good, REDIS_URL: "http://redis.example.com" }, "REDIS_URL"],
  ["RAZORPAY_KEY_ID missing", without("RAZORPAY_KEY_ID"), "RAZORPAY_KEY_ID"],
  ["RAZORPAY_KEY_SECRET missing", without("RAZORPAY_KEY_SECRET"), "RAZORPAY_KEY_SECRET"],
  ["RAZORPAY_WEBHOOK_SECRET missing", without("RAZORPAY_WEBHOOK_SECRET"), "RAZORPAY_WEBHOOK_SECRET"],
  ["EMAIL_PROVIDER=log", { ...good, EMAIL_PROVIDER: "log" }, "EMAIL_PROVIDER"],
  ["EMAIL_PROVIDER unset (defaults to log)", without("EMAIL_PROVIDER"), "EMAIL_PROVIDER"],
  ["resend without RESEND_API_KEY", without("RESEND_API_KEY"), "RESEND_API_KEY"],
  ["postmark without POSTMARK_SERVER_TOKEN", { ...without("RESEND_API_KEY"), EMAIL_PROVIDER: "postmark" }, "POSTMARK_SERVER_TOKEN"],
  ["no EMAIL_FROM", without("EMAIL_FROM"), "EMAIL_FROM"],
  ["MESSAGING_DRY_RUN=true", { ...good, MESSAGING_DRY_RUN: "true" }, "MESSAGING_DRY_RUN"],
  ["WHATSAPP_DISABLED=true", { ...good, WHATSAPP_DISABLED: "true" }, "WHATSAPP_DISABLED"],
  ["READINESS_BYPASS=true", { ...good, READINESS_BYPASS: "true" }, "READINESS_BYPASS"],
  ["RATE_LIMIT_ENABLED=false", { ...good, RATE_LIMIT_ENABLED: "false" }, "RATE_LIMIT_ENABLED"],
  ["unknown RATE_LIMIT_STORE", { ...good, RATE_LIMIT_STORE: "memcached" }, "RATE_LIMIT_STORE"],
];
for (const [name, env, variable] of failures) {
  test(`production rejects: ${name}`, () => {
    const r = validateEnv(env);
    assert.ok(r.errors.length >= 1, "expected at least one error");
    assert.ok(
      r.errors.some((e) => e.startsWith(`${variable}:`)),
      `expected an error for ${variable}, got: ${r.errors.join(" | ")}`,
    );
  });
}

test("every problem is reported at once, in one message, without any secret value", () => {
  const SECRET_A = "SENTINEL-db-password-must-not-leak";
  const SECRET_B = "SENTINEL-key-material"; // 20 chars: too short for APP_SECRET, not a valid key
  const env: EnvRecord = {
    NODE_ENV: "production",
    DATABASE_URL: `mysql://user:${SECRET_A}@h/db`,
    APP_URL: "http://insecure.example.com",
    APP_SECRET: SECRET_B,
    TOKEN_ENCRYPTION_KEY: SECRET_B,
    EMAIL_PROVIDER: "log",
    MESSAGING_DRY_RUN: "true",
    WHATSAPP_DISABLED: "true",
    READINESS_BYPASS: "true",
    RATE_LIMIT_ENABLED: "false",
  };
  const r = validateEnv(env);
  const variables = ["DATABASE_URL", "APP_URL", "APP_SECRET", "TOKEN_ENCRYPTION_KEY", "REDIS_URL", "RAZORPAY_KEY_ID", "RAZORPAY_KEY_SECRET", "RAZORPAY_WEBHOOK_SECRET", "EMAIL_PROVIDER", "MESSAGING_DRY_RUN", "WHATSAPP_DISABLED", "READINESS_BYPASS", "RATE_LIMIT_ENABLED"];
  for (const v of variables) assert.ok(r.errors.some((e) => e.startsWith(`${v}:`)), `${v} should be reported`);

  const error = new EnvValidationError(r.errors);
  assert.equal(error.issues.length, r.errors.length);
  for (const secret of [SECRET_A, SECRET_B]) {
    assert.ok(!error.message.includes(secret), "the message must not contain a value");
    assert.ok(!JSON.stringify(r.errors).includes(secret));
    assert.ok(!JSON.stringify(r.warnings).includes(secret));
  }
  assert.match(error.message, /\d+ problems/);
});

test("blank values count as unset", () => {
  const r = validateEnv({ ...good, RAZORPAY_KEY_ID: "", REDIS_URL: "" });
  assert.ok(r.errors.some((e) => e.startsWith("REDIS_URL:") && e.includes("is not set")));
  assert.ok(r.errors.some((e) => e.startsWith("RAZORPAY_KEY_ID:") && e.includes("is not set")));
});

// The app reads process.env exactly as given, so padding is a real difference. In production it is rejected, by name,
// without echoing the value; nothing is trimmed on the app's behalf.
const padded: [string, string, string][] = [
  ["EMAIL_PROVIDER with a trailing newline (the app would silently log every email)", "EMAIL_PROVIDER", "resend\n"],
  ["APP_URL with a leading space", "APP_URL", " https://sessions.example.com"],
  ["APP_URL with a trailing space", "APP_URL", "https://sessions.example.com "],
  ["RESEND_API_KEY with a trailing CR (CRLF env file)", "RESEND_API_KEY", "re_123\r"],
  ["DATABASE_URL with a trailing newline", "DATABASE_URL", `${good.DATABASE_URL}\n`],
  ["TOKEN_ENCRYPTION_KEY with a trailing newline", "TOKEN_ENCRYPTION_KEY", `${KEY}\n`],
  ["APP_SECRET padded", "APP_SECRET", ` ${APP_SECRET} `],
  ["a whitespace-only value", "RAZORPAY_KEY_SECRET", "   "],
  ["RATE_LIMIT_ENABLED padded", "RATE_LIMIT_ENABLED", "true "],
];
for (const [name, variable, value] of padded) {
  test(`production rejects whitespace: ${name}`, () => {
    const r = validateEnv({ ...good, [variable]: value });
    const hits = r.errors.filter((e) => e.startsWith(`${variable}:`) && e.includes("whitespace"));
    assert.equal(hits.length, 1, `expected exactly one whitespace error for ${variable}, got: ${r.errors.join(" | ")}`);
    const printed = JSON.stringify([r.errors, r.warnings]);
    for (const part of [value.trim(), KEY, APP_SECRET].filter((p) => p.length > 8)) assert.ok(!printed.includes(part), "never print the value");
    assert.equal(new EnvValidationError(r.errors).issues.length, r.errors.length);
  });
}

test("whitespace outside the variables this app reads is none of our business", () => {
  const r = validateEnv({ ...good, SOME_OTHER_TOOL: " padded ", LS_COLORS: "x\n", HOSTNAME: "host " });
  assert.deepEqual(r.errors, []);
});

test("whitespace is only a warning in development", () => {
  const r = validateEnv({ NODE_ENV: "development", EMAIL_PROVIDER: "log\n", APP_URL: " http://localhost:3000" });
  assert.deepEqual(r.errors, []);
  assert.ok(r.warnings.some((w) => w.startsWith("APP_URL:") && w.includes("whitespace")));
  assert.ok(r.warnings.some((w) => w.startsWith("EMAIL_PROVIDER:") && w.includes("whitespace")));
});

test("KNOWN_ENV_VARS covers every variable in .env.example, so none can escape the whitespace check", () => {
  const example = readFileSync(join(process.cwd(), ".env.example"), "utf8");
  const names = [...example.matchAll(/^([A-Z][A-Z0-9_]+)=/gm)].map((m) => m[1]);
  assert.ok(names.length > 40, "parsed the example file");
  const known = new Set<string>(KNOWN_ENV_VARS);
  assert.deepEqual(names.filter((n) => !known.has(n)), [], "add new .env.example variables to KNOWN_ENV_VARS (lib/env.ts)");
  assert.ok(!known.has("TOKEN_ENCRYPTION_KEY_NEW"), "the rotation tool uses the app's own variables now");
  assert.ok(!names.includes("TOKEN_ENCRYPTION_KEY_NEW"), ".env.example must not document a variable that no longer exists");
});

test("development only warns: dev-only settings are fine, missing essentials are warnings", () => {
  const dev = validateEnv({ NODE_ENV: "development", EMAIL_PROVIDER: "log", MESSAGING_DRY_RUN: "true", READINESS_BYPASS: "true", RATE_LIMIT_ENABLED: "false" });
  assert.deepEqual(dev.errors, [], "nothing blocks a development start");
  assert.equal(dev.production, false);
  for (const v of ["DATABASE_URL", "APP_SECRET", "TOKEN_ENCRYPTION_KEY"]) {
    assert.ok(dev.warnings.some((w) => w.startsWith(`${v}:`)), `${v} should warn`);
  }
  // The production-only rules are silent in development.
  for (const v of ["EMAIL_PROVIDER", "MESSAGING_DRY_RUN", "READINESS_BYPASS", "RATE_LIMIT_ENABLED", "REDIS_URL", "RAZORPAY_KEY_ID", "APP_URL"]) {
    assert.ok(!dev.warnings.some((w) => w.startsWith(`${v}:`)), `${v} should not warn in development`);
  }

  // A malformed value is still worth a warning in development.
  const bad = validateEnv({ ...good, NODE_ENV: "development", DATABASE_URL: "not a url", MESSAGING_DRY_RUN: "yes" });
  assert.deepEqual(bad.errors, []);
  assert.ok(bad.warnings.some((w) => w.startsWith("DATABASE_URL:")));
  assert.ok(bad.warnings.some((w) => w.startsWith("MESSAGING_DRY_RUN:")));
  // NODE_ENV=test and an unset NODE_ENV behave like development.
  assert.deepEqual(validateEnv({ NODE_ENV: "test" }).errors, []);
  assert.deepEqual(validateEnv({}).errors, []);
});

test("true/false flags must be spelled exactly, because the code compares strings", () => {
  const r = validateEnv({ ...good, RATE_LIMIT_ENABLED: "False" });
  assert.ok(r.errors.some((e) => e.startsWith("RATE_LIMIT_ENABLED:")), '"False" would silently leave limits ON while the operator thinks they are off');
});

test("local production run: the escape hatch relaxes only dev-only settings, only for localhost", () => {
  const local: EnvRecord = {
    ...good,
    APP_URL: "http://localhost:3000",
    EMAIL_PROVIDER: "log",
    RESEND_API_KEY: undefined,
    MESSAGING_DRY_RUN: "true",
    WHATSAPP_DISABLED: "true",
    ALLOW_INSECURE_LOCAL_RUN: "true",
  };
  const ok = validateEnv(local);
  assert.deepEqual(ok.errors, []);
  assert.equal(ok.localRun, true);
  assert.ok(ok.warnings.some((w) => w.startsWith("APP_URL:")));
  assert.ok(ok.warnings.some((w) => w.startsWith("EMAIL_PROVIDER:")));
  assert.ok(ok.warnings.some((w) => w.startsWith("MESSAGING_DRY_RUN:") && w.includes("ALLOW_INSECURE_LOCAL_RUN")));
  assert.ok(ok.warnings.some((w) => w.startsWith("WHATSAPP_DISABLED:")));

  // Without the flag the same environment is rejected.
  const strict = validateEnv({ ...local, ALLOW_INSECURE_LOCAL_RUN: undefined });
  assert.ok(strict.errors.length >= 3);

  // A public hostname cannot use the hatch: it is an error, not silently ignored.
  const pub = validateEnv({ ...local, APP_URL: "https://sessions.example.com" });
  assert.ok(pub.errors.some((e) => e.startsWith("ALLOW_INSECURE_LOCAL_RUN:")));
  assert.ok(pub.errors.some((e) => e.startsWith("EMAIL_PROVIDER:")), "the relaxations do not apply either");

  // Essentials stay mandatory even for a local run.
  const noDb = validateEnv({ ...local, DATABASE_URL: undefined });
  assert.ok(noDb.errors.some((e) => e.startsWith("DATABASE_URL:")));
  const noRazorpay = validateEnv({ ...local, RAZORPAY_KEY_ID: undefined });
  assert.ok(noRazorpay.errors.some((e) => e.startsWith("RAZORPAY_KEY_ID:")));
});

test("advisory warnings in production", () => {
  const r = validateEnv({ ...without("CLIENT_IP_HEADER"), RAZORPAY_KEY_ID: "rzp_test_abc", TOKEN_ENCRYPTION_KEY_PREVIOUS: randomBytes(32).toString("base64") });
  assert.deepEqual(r.errors, []);
  for (const v of ["CLIENT_IP_HEADER", "ERROR_WEBHOOK_URL", "RAZORPAY_KEY_ID", "TOKEN_ENCRYPTION_KEY_PREVIOUS", "GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET/GOOGLE_REDIRECT_URI"]) {
    assert.ok(r.warnings.some((w) => w.startsWith(`${v}:`)), `${v} should warn`);
  }
});

test("typed config: defaults mirror the code, trailing slash is stripped, secrets stay out of JSON", () => {
  const r = validateEnv({ ...good, APP_URL: "https://sessions.example.com/", DATABASE_POOL_MAX: "3", RATE_LIMIT_MULTIPLIER: "2", TOKEN_ENCRYPTION_KEY_PREVIOUS: randomBytes(32).toString("base64") });
  const c = r.config;
  assert.equal(c.appUrl, "https://sessions.example.com");
  assert.equal(c.database.poolMax, 3);
  assert.equal(c.database.statementTimeoutMs, 15_000);
  assert.equal(c.rateLimit.multiplier, 2);
  assert.equal(c.rateLimit.enabled, true);
  assert.equal(c.rateLimit.store, "auto");
  assert.equal(c.email.provider, "resend");
  assert.equal(c.redisConfigured, true);
  assert.equal(c.razorpay.testMode, false);

  assert.equal(c.encryption.fingerprint, keyFingerprint(Buffer.from(KEY, "base64")));
  assert.match(c.encryption.previousFingerprint ?? "", /^[0-9a-f]{8}$/);
  assert.equal(c.secrets.appSecret, APP_SECRET);
  assert.equal(c.secrets.tokenEncryptionKey?.length, 32);
  assert.equal(c.secrets.tokenEncryptionKeyPrevious?.length, 32);
  const printed = JSON.stringify(c) + JSON.stringify({ ...c }) + String(Object.keys(c));
  for (const secret of [APP_SECRET, "razorpay-secret-1", "db-password-1", "redis-password-1"]) assert.ok(!printed.includes(secret), "config must not serialise secrets");

  assert.equal(validateEnv({}).config.appUrl, "http://localhost:3000", "same default as lib/brand.ts");
});

test("getConfig validates process.env once and caches the result", () => {
  const saved = { ...process.env };
  try {
    Object.assign(process.env, good);
    resetConfigForTests();
    const a = getConfig();
    const b = getConfig();
    assert.equal(a, b, "cached");

    // Production with a broken environment: throws one aggregated error, and keeps throwing.
    process.env.REDIS_URL = "";
    resetConfigForTests();
    assert.throws(() => getConfig(), (e: unknown) => e instanceof EnvValidationError && e.issues.some((i) => i.startsWith("REDIS_URL:")));
    assert.throws(() => getConfig(), EnvValidationError);
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
    resetConfigForTests();
  }
});

test("initEnv logs warnings once; initEnvOrExit prints the problems and exits 1", () => {
  const saved = { ...process.env };
  const realWarn = console.warn;
  const realLog = console.log;
  const realError = console.error;
  const realExit = process.exit;
  const warned: string[] = [];
  const errored: string[] = [];
  const logged: string[] = [];
  let exitCode: number | undefined;
  try {
    console.warn = (...a: unknown[]) => void warned.push(a.join(" "));
    console.log = (...a: unknown[]) => void logged.push(a.join(" "));
    console.error = (...a: unknown[]) => void errored.push(a.join(" "));
    process.exit = ((code?: number) => {
      exitCode = code;
      throw new Error("exit");
    }) as typeof process.exit;

    Object.assign(process.env, good);
    delete process.env.CLIENT_IP_HEADER;
    resetConfigForTests();
    process.env.TOKEN_ENCRYPTION_KEY_PREVIOUS = randomBytes(32).toString("base64");
    initEnv("test");
    // Start-up logs the key fingerprints (never the keys) so operators can compare instances with the key tools' output.
    const fingerprintLine = logged.find((l) => l.includes("encryption key fingerprint")) ?? "";
    assert.ok(fingerprintLine.includes(keyFingerprint(Buffer.from(KEY, "base64"))), fingerprintLine);
    assert.match(fingerprintLine, /previous key fingerprint [0-9a-f]{8}/);
    for (const secret of [KEY, process.env.TOKEN_ENCRYPTION_KEY_PREVIOUS!, APP_SECRET]) assert.ok(!logged.concat(warned).join("\n").includes(secret), "no key material in the log");
    const firstCount = warned.length;
    assert.ok(firstCount > 0 && warned.some((w) => w.includes("CLIENT_IP_HEADER")));
    initEnv("test");
    assert.equal(warned.length, firstCount, "warnings are printed once");

    process.env.APP_SECRET = "SENTINEL-too-short";
    resetConfigForTests();
    assert.throws(() => initEnvOrExit("worker"), /exit/);
    assert.equal(exitCode, 1);
    assert.ok(errored.join("\n").includes("APP_SECRET"));
    assert.ok(!errored.join("\n").includes("SENTINEL"), "the output must not include the secret value");
  } finally {
    console.warn = realWarn;
    console.log = realLog;
    console.error = realError;
    process.exit = realExit;
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
    resetConfigForTests();
  }
});
