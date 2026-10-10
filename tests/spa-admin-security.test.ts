// Integration test of M4, GET /api/admin/security, the endpoint behind the SPA's Security page (needs DATABASE_URL,
// TOKEN_ENCRYPTION_KEY, APP_SECRET; skipped otherwise).
//
// It is also the home of the page-based assertions that tests/admin-mfa-routes.test.ts ("the administrator list is hidden
// from sessions that have not passed what they must") makes by rendering app/admin/(console)/security/page.tsx, ported to
// the endpoint, so the cleanup branch can delete the page import from that file:
//   - an administrator who still has to enrol (ADMIN_REQUIRE_2FA): 200, the page's data, but `admins: null`;
//   - a password-only session of an administrator who HAS two-factor: 403 `mfaAction: "verify"` and nothing else;
//   - a verified session: the list of administrators.
// Only `next/headers` is replaced (the cookie a request carries is chosen per call).
import "dotenv/config";
import assert from "node:assert/strict";
import { after, before, mock, test } from "node:test";
import { hashPassword } from "../lib/auth/password";
import { hashToken, randomToken } from "../lib/auth/tokens";
import { prisma } from "../lib/db";
import { assertNoSecretKeys } from "./helpers/assert-no-secret-keys";

const skip = process.env.DATABASE_URL && process.env.TOKEN_ENCRYPTION_KEY && process.env.APP_SECRET ? false : "DATABASE_URL / TOKEN_ENCRYPTION_KEY / APP_SECRET not set";
const run = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
const PASSWORD = "correct-horse-battery-9";
const emailX = `sec-x-${run}@example.com`; // has two-factor
const emailY = `sec-y-${run}@example.com`; // does not (yet)
const emailQ = `sec-q-${run}@example.com`; // has two-factor
const emailZ = `sec-z-${run}@example.com`; // has two-factor

const jar = new Map<string, string>();
let getSecurity: () => Promise<Response>;
let sessionLib: typeof import("../lib/admin/session");
let X = "";
let Y = "";
let Q = "";
let Z = "";
let secretX = "";
let recoveryX: string[] = [];

/** A password-only session row for an admin who has two-factor (createAdminSession refuses to make one). */
async function passwordOnlySession(adminId: string): Promise<string> {
  const token = randomToken();
  await prisma.adminSession.create({ data: { tokenHash: hashToken(token), adminId, expiresAt: new Date(Date.now() + 3_600_000) } });
  return token;
}

async function ask(token?: string): Promise<{ status: number; body: Record<string, unknown>; text: string; headers: Headers }> {
  jar.clear();
  if (token) jar.set(sessionLib.adminCookieName(), token);
  const res = await getSecurity();
  const text = await res.text();
  return { status: res.status, body: JSON.parse(text) as Record<string, unknown>, text, headers: res.headers };
}
const keys = (o: unknown) => Object.keys(o as object).sort();

before(async () => {
  if (skip) return;
  process.env.RATE_LIMIT_STORE = "memory";
  mock.module("next/headers", {
    namedExports: {
      cookies: async () => ({ get: (name: string) => (jar.has(name) ? { name, value: jar.get(name) } : undefined) }),
      headers: async () => new Headers(),
    },
  });
  sessionLib = await import("../lib/admin/session");
  const mfa = await import("../lib/admin/mfa");
  const totp = await import("../lib/admin/totp");
  getSecurity = (await import("../app/api/admin/security/route")).GET;

  const hash = await hashPassword(PASSWORD);
  X = (await prisma.adminUser.create({ data: { email: emailX, name: "Sec X", passwordHash: hash } })).id;
  Y = (await prisma.adminUser.create({ data: { email: emailY, name: "Sec Y", passwordHash: hash } })).id;
  Q = (await prisma.adminUser.create({ data: { email: emailQ, name: "Sec Q", passwordHash: hash } })).id;
  Z = (await prisma.adminUser.create({ data: { email: emailZ, name: "Sec Z", passwordHash: hash } })).id;
  for (const id of [X, Q, Z]) {
    const past = Date.now() - 60_000;
    const secret = (await mfa.startTotpEnrollment(id)).secret;
    const done = await mfa.confirmTotpEnrollment(id, totp.totpAt(secret, past), null, past);
    assert.ok(done.ok);
    if (id === X && done.ok) {
      secretX = secret;
      recoveryX = done.recoveryCodes;
    }
  }
});

after(async () => {
  if (!skip && X) {
    await prisma.adminAuditLog.deleteMany({ where: { adminEmail: { in: [emailX, emailY, emailQ, emailZ] } } });
    await prisma.adminUser.deleteMany({ where: { id: { in: [X, Y, Q, Z] } } });
  }
  delete process.env.ADMIN_REQUIRE_2FA;
  delete process.env.PAYOUT_FOUR_EYES;
  delete process.env.PAYOUT_FOUR_EYES_MIN_MINOR;
  await prisma.$disconnect();
});

test("M4 GET /api/admin/security: 401 signed out", { skip }, async () => {
  const out = await ask();
  assert.equal(out.status, 401);
  assert.equal(typeof out.body.error, "string");
  assert.equal((await ask("garbage")).status, 401);
});

test("the administrator list is hidden from sessions that have not passed what they must (the page assertions, on the endpoint)", { skip }, async () => {
  process.env.ADMIN_REQUIRE_2FA = "true";
  try {
    // A cookie of an admin who has not enrolled (2FA required) gets the page's data, but not who the other admins are.
    const enrolling = await ask(await sessionLib.createAdminSession(Y));
    assert.equal(enrolling.status, 200);
    assert.equal(enrolling.body.admins, null, "null, not an empty list");
    for (const other of [emailX, emailQ, emailZ]) assert.ok(!enrolling.text.includes(other), `${other} is not sent`);
    assert.deepEqual(enrolling.body.mfa, { enabled: false, recoveryCodesLeft: 0 });
    assert.equal(enrolling.body.required, true);
    assert.equal(enrolling.body.email, emailY);
    assertNoSecretKeys(enrolling.body);

    // A password-only session of an admin who HAS 2FA does not even get the page's data.
    const stale = await ask(await passwordOnlySession(X));
    assert.equal(stale.status, 403);
    assert.equal(stale.body.mfaRequired, true);
    assert.equal(stale.body.mfaAction, "verify");
    assert.deepEqual(keys(stale.body), ["error", "mfaAction", "mfaRequired"]);
    for (const other of [emailX, emailQ, emailZ]) assert.ok(!stale.text.includes(other));

    // A verified session of an enrolled admin sees the list.
    const shown = await ask(await sessionLib.createAdminSession(X, {}, { mfaVerified: true }));
    assert.equal(shown.status, 200);
    assert.ok(Array.isArray(shown.body.admins));
    const admins = shown.body.admins as { email: string }[];
    for (const other of [emailX, emailY, emailQ, emailZ]) assert.ok(admins.some((a) => a.email === other), `${other} is listed`);
  } finally {
    delete process.env.ADMIN_REQUIRE_2FA;
  }

  // Without the requirement the gate is "ok" for an admin with no 2FA, as it is for the page: the list is there. An admin who has
  // two-factor and a password-only session is still "verify".
  const plain = await ask(await sessionLib.createAdminSession(Y));
  assert.equal(plain.status, 200);
  assert.ok(Array.isArray(plain.body.admins));
  assert.equal(plain.body.required, false);
  assert.equal((await ask(await passwordOnlySession(Q))).status, 403);
});

test("M4 shape: hand-picked fields, one 'you' row, no ids, never the TOTP secret or the recovery codes", { skip }, async () => {
  process.env.PAYOUT_FOUR_EYES = "true";
  process.env.PAYOUT_FOUR_EYES_MIN_MINOR = "123456";
  try {
    const res = await ask(await sessionLib.createAdminSession(X, {}, { mfaVerified: true }));
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("cache-control"), "private, no-store");
    assert.equal(res.headers.get("access-control-allow-origin"), null);
    assert.deepEqual(keys(res.body), ["admins", "email", "fourEyes", "fourEyesMinMinor", "mfa", "required"]);
    assert.equal(res.body.email, emailX);
    assert.equal(res.body.fourEyes, true);
    assert.equal(res.body.fourEyesMinMinor, 123_456);
    assert.deepEqual(keys(res.body.mfa), ["enabled", "recoveryCodesLeft"]);
    assert.deepEqual(res.body.mfa, { enabled: true, recoveryCodesLeft: recoveryX.length });
    assertNoSecretKeys(res.body);

    const admins = (res.body.admins as Record<string, unknown>[]).filter((a) => [emailX, emailY, emailQ, emailZ].includes(a.email as string));
    assert.equal(admins.length, 4);
    for (const a of admins) assert.deepEqual(keys(a), ["disabled", "email", "isSelf", "lastLoginAt", "name", "totpEnabled"]);
    assert.deepEqual(admins.filter((a) => a.isSelf).map((a) => a.email), [emailX], "exactly the signed-in administrator is 'you'");
    assert.deepEqual(
      admins.map((a) => [a.email, a.totpEnabled]).sort(),
      [[emailQ, true], [emailX, true], [emailY, false], [emailZ, true]].sort(),
    );
    assert.ok(!res.text.includes(X) && !res.text.includes(Y) && !res.text.includes(Q) && !res.text.includes(Z), "no administrator ids");
    assert.ok(!res.text.includes(secretX), "the TOTP secret is never sent");
    for (const code of recoveryX) assert.ok(!res.text.includes(code), "recovery codes are never sent");
    assert.ok(!/passwordHash|tokenHash|secretEnc|recoveryCodes"/i.test(res.text));
  } finally {
    delete process.env.PAYOUT_FOUR_EYES;
    delete process.env.PAYOUT_FOUR_EYES_MIN_MINOR;
  }
  process.env.PAYOUT_FOUR_EYES = "false";
  try {
    const off = await ask(await sessionLib.createAdminSession(X, {}, { mfaVerified: true }));
    assert.equal(off.body.fourEyes, false);
  } finally {
    delete process.env.PAYOUT_FOUR_EYES;
  }
});
