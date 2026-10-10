// Pure tests (no database): TOTP maths against the RFC 6238 vectors, recovery codes, env policy, route rate rules.
import assert from "node:assert/strict";
import { test } from "node:test";
import { admin2faRequired, parseFlag } from "../lib/admin/policy";
import {
  base32Decode,
  base32Encode,
  constantTimeEqual,
  formatSecretForDisplay,
  generateRecoveryCodes,
  generateTotpSecret,
  hashRecoveryCode,
  hotp,
  looksLikeRecoveryCode,
  normaliseRecoveryCode,
  normaliseTotpInput,
  otpauthUri,
  RECOVERY_CODE_COUNT,
  timeStepOf,
  totpAt,
  verifyTotp,
} from "../lib/admin/totp";
import { IDENTITY_RULES, matchRouteRule } from "../lib/rate-limit/policies";

// RFC 6238 appendix B, SHA-1: the ASCII secret "12345678901234567890" and 8-digit codes at these Unix times.
const RFC_SECRET = base32Encode(Buffer.from("12345678901234567890"));
const RFC_VECTORS: [number, string][] = [
  [59, "94287082"],
  [1111111109, "07081804"],
  [1111111111, "14050471"],
  [1234567890, "89005924"],
  [2000000000, "69279037"],
  [20000000000, "65353130"],
];

test("base32 matches the RFC 4648 test vectors and tolerates how people paste keys", () => {
  const vectors: [string, string][] = [["", ""], ["f", "MY"], ["fo", "MZXQ"], ["foo", "MZXW6"], ["foob", "MZXW6YQ"], ["fooba", "MZXW6YTB"], ["foobar", "MZXW6YTBOI"]];
  for (const [plain, encoded] of vectors) {
    assert.equal(base32Encode(Buffer.from(plain)), encoded, `encode ${plain}`);
    assert.equal(base32Decode(encoded).toString(), plain, `decode ${plain}`);
  }
  assert.equal(RFC_SECRET, "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");
  assert.equal(base32Decode("mzxw 6ytb-oi==").toString(), "foobar", "lowercase, spaces, dashes and padding are ignored");
  assert.throws(() => base32Decode("MZXW1"), /Invalid base32/, "1 is not in the alphabet");
  assert.throws(() => base32Decode("MZXW!"), /Invalid base32/);
});

test("TOTP reproduces the RFC 6238 test vectors (8 digits, and the same codes cut to 6)", () => {
  for (const [seconds, code8] of RFC_VECTORS) {
    assert.equal(totpAt(RFC_SECRET, seconds * 1000, { digits: 8 }), code8, `8 digits at ${seconds}`);
    assert.equal(totpAt(RFC_SECRET, seconds * 1000), code8.slice(-6), `6 digits at ${seconds}`);
  }
  // RFC 4226 appendix D: the HOTP counter values 0 and 1 for the same key.
  assert.equal(hotp(Buffer.from("12345678901234567890"), 0), "755224");
  assert.equal(hotp(Buffer.from("12345678901234567890"), 1), "287082");
  assert.equal(timeStepOf(59_000), 1);
  assert.equal(timeStepOf(60_000), 2);
});

test("a code is accepted one step either side of now, and not two", () => {
  const now = 1_700_000_000_000;
  const current = timeStepOf(now);
  const at = (step: number) => totpAt(RFC_SECRET, step * 30_000);
  for (const d of [-1, 0, 1]) {
    const r = verifyTotp(RFC_SECRET, at(current + d), { now });
    assert.deepEqual(r, { ok: true, step: current + d }, `step offset ${d}`);
  }
  for (const d of [-2, 2, 10]) {
    assert.deepEqual(verifyTotp(RFC_SECRET, at(current + d), { now }), { ok: false, reason: "invalid" }, `step offset ${d}`);
  }
  assert.equal(verifyTotp(RFC_SECRET, at(current + 2), { now, window: 2 }).ok, true, "the window is configurable");
});

test("wrong, malformed and empty codes are invalid; spaces and dashes in a code are fine", () => {
  const now = 1_700_000_000_000;
  const good = totpAt(RFC_SECRET, now);
  const wrong = good === "000000" ? "000001" : "000000";
  assert.deepEqual(verifyTotp(RFC_SECRET, wrong, { now }), { ok: false, reason: "invalid" });
  for (const bad of ["", "12345", "1234567", "abcdef", "12345a", "١٢٣٤٥٦"]) {
    assert.deepEqual(verifyTotp(RFC_SECRET, bad, { now }), { ok: false, reason: "invalid" }, JSON.stringify(bad));
  }
  assert.equal(verifyTotp(RFC_SECRET, `${good.slice(0, 3)} ${good.slice(3)}`, { now }).ok, true);
  assert.equal(verifyTotp(RFC_SECRET, `${good.slice(0, 3)}-${good.slice(3)}`, { now }).ok, true);
  assert.deepEqual(verifyTotp("not base32 !!", good, { now }), { ok: false, reason: "invalid" }, "a corrupt secret never accepts");
  assert.equal(normaliseTotpInput(" 123 456 "), "123456");
  assert.equal(normaliseTotpInput("12345"), null);
});

test("replay protection: a time step is accepted once; earlier steps are refused afterwards", () => {
  const now = 1_700_000_000_000;
  const current = timeStepOf(now);
  const at = (step: number) => totpAt(RFC_SECRET, step * 30_000);

  const first = verifyTotp(RFC_SECRET, at(current), { now, lastStep: null });
  assert.deepEqual(first, { ok: true, step: current });
  // The caller stores `first.step` as lastStep; the very same code is now a replay...
  assert.deepEqual(verifyTotp(RFC_SECRET, at(current), { now, lastStep: current }), { ok: false, reason: "replayed" });
  // ...and so is the code of the step before it (still inside the window, but older than the last accepted step).
  assert.deepEqual(verifyTotp(RFC_SECRET, at(current - 1), { now, lastStep: current }), { ok: false, reason: "replayed" });
  // The next step's code is fresh and works.
  assert.deepEqual(verifyTotp(RFC_SECRET, at(current + 1), { now, lastStep: current }), { ok: true, step: current + 1 });
  // A wrong code is "invalid", not "replayed", even when a replay marker exists.
  assert.deepEqual(verifyTotp(RFC_SECRET, "000000", { now: now + 3_600_000, lastStep: current }), { ok: false, reason: "invalid" });
});

test("constantTimeEqual compares by value and never throws on different lengths", () => {
  assert.equal(constantTimeEqual("123456", "123456"), true);
  assert.equal(constantTimeEqual("123456", "123457"), false);
  assert.equal(constantTimeEqual("123456", "12345"), false);
  assert.equal(constantTimeEqual("", ""), true);
});

test("generated secrets are 160-bit base32 and unique; the otpauth URI carries what an app needs", () => {
  const a = generateTotpSecret();
  const b = generateTotpSecret();
  assert.match(a, /^[A-Z2-7]{32}$/);
  assert.equal(base32Decode(a).length, 20);
  assert.notEqual(a, b);
  assert.equal(formatSecretForDisplay("ABCDEFGHIJKLMNOP"), "ABCD EFGH IJKL MNOP");

  const uri = new URL(otpauthUri({ secret: a, account: "ops+admin@example.com", issuer: "Session Automation Admin" }));
  assert.equal(uri.protocol, "otpauth:");
  assert.equal(uri.hostname, "totp");
  assert.equal(decodeURIComponent(uri.pathname), "/Session Automation Admin:ops+admin@example.com");
  assert.equal(uri.searchParams.get("secret"), a);
  assert.equal(uri.searchParams.get("issuer"), "Session Automation Admin");
  assert.equal(uri.searchParams.get("algorithm"), "SHA1");
  assert.equal(uri.searchParams.get("digits"), "6");
  assert.equal(uri.searchParams.get("period"), "30");
});

test("recovery codes: ten unique, typeable codes; hashing ignores case, spaces and dashes and is per admin", () => {
  const codes = generateRecoveryCodes();
  assert.equal(codes.length, RECOVERY_CODE_COUNT);
  assert.equal(new Set(codes).size, RECOVERY_CODE_COUNT);
  for (const c of codes) {
    assert.match(c, /^[a-hjkmnp-z2-9]{6}-[a-hjkmnp-z2-9]{6}$/, "no look-alike characters");
    assert.ok(looksLikeRecoveryCode(c));
  }
  const code = codes[0];
  const messy = code.toUpperCase().replace("-", "  ");
  assert.equal(normaliseRecoveryCode(messy), normaliseRecoveryCode(code));
  assert.equal(hashRecoveryCode("admin_1", messy), hashRecoveryCode("admin_1", code));
  assert.match(hashRecoveryCode("admin_1", code), /^[0-9a-f]{64}$/, "SHA-256 hex, like hashToken");
  assert.notEqual(hashRecoveryCode("admin_2", code), hashRecoveryCode("admin_1", code), "the same code hashes differently for another admin");
  assert.notEqual(hashRecoveryCode("admin_1", code), hashRecoveryCode("admin_1", codes[1]));
  assert.ok(!hashRecoveryCode("admin_1", code).includes(normaliseRecoveryCode(code)), "the hash does not contain the code");
  assert.equal(looksLikeRecoveryCode("123456"), false, "a 6-digit authenticator code is not a recovery code");
  assert.equal(looksLikeRecoveryCode("short"), false);
});

test("ADMIN_REQUIRE_2FA defaults to on in production and off elsewhere, and can be set either way", () => {
  const env = (o: Record<string, string>) => o as unknown as NodeJS.ProcessEnv;
  assert.equal(admin2faRequired(env({ NODE_ENV: "production" })), true);
  assert.equal(admin2faRequired(env({ NODE_ENV: "development" })), false);
  assert.equal(admin2faRequired(env({})), false);
  assert.equal(admin2faRequired(env({ NODE_ENV: "production", ADMIN_REQUIRE_2FA: "false" })), false);
  assert.equal(admin2faRequired(env({ NODE_ENV: "development", ADMIN_REQUIRE_2FA: "true" })), true);
  assert.equal(admin2faRequired(env({ NODE_ENV: "production", ADMIN_REQUIRE_2FA: "garbage" })), true, "unrecognised values keep the default");
  assert.equal(parseFlag(" Yes ", false), true);
  assert.equal(parseFlag("0", true), false);
});

test("the second-step and security routes have their own strict rate-limit rules", () => {
  assert.equal(matchRouteRule("POST", "/api/admin/auth/mfa")?.name, "admin-mfa");
  assert.equal(matchRouteRule("POST", "/api/admin/security/2fa")?.name, "admin-security");
  assert.equal(matchRouteRule("POST", "/api/admin/auth/login")?.name, "admin-login");
  assert.equal(matchRouteRule("POST", "/api/admin/payouts/abc")?.name, "admin-money", "approving a payout shares the money limit");
  assert.ok(matchRouteRule("POST", "/api/admin/auth/mfa")!.limit <= 10);
  assert.ok(IDENTITY_RULES.adminMfaIp.limit <= 10, "per admin + IP");
  assert.ok(IDENTITY_RULES.adminMfaAdmin.limit >= IDENTITY_RULES.adminMfaIp.limit, "the all-IPs cap is the looser backstop");
  assert.notEqual(IDENTITY_RULES.adminMfaIp.name, IDENTITY_RULES.adminLoginEmail.name);
});
