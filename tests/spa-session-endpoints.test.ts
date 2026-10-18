// Integration test of the four foundation endpoints the SPA's guards and layouts depend on (needs DATABASE_URL,
// TOKEN_ENCRYPTION_KEY, APP_SECRET; skipped otherwise):
//   A1 GET /api/auth/session       A2 GET /api/admin/session
//   A3 GET /api/dashboard/shell    A4 GET /api/admin/shell
// Only `next/headers` is replaced (the cookies a request carries are chosen per call). Every body goes through
// assertNoSecretKeys, and the exact set of keys is pinned, so adding a field to a DTO is a deliberate act.
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
const emailX = `spa-x-${run}@example.com`; // administrator with two-factor
const emailY = `spa-y-${run}@example.com`; // administrator without

const jar = new Map<string, string>();
type Handler = () => Promise<Response>;
let routes: { session: Handler; adminSession: Handler; dashboardShell: Handler; adminShell: Handler };
let sessionLib: typeof import("../lib/admin/session");
let authLib: typeof import("../lib/auth/session");
let X = "";
let Y = "";
let userId = "";
let influencerId = "";

/** A password-only session row for an admin who has two-factor (createAdminSession refuses to make one). */
async function passwordOnlySession(adminId: string): Promise<string> {
  const token = randomToken();
  await prisma.adminSession.create({ data: { tokenHash: hashToken(token), adminId, expiresAt: new Date(Date.now() + 3_600_000) } });
  return token;
}

async function ask(handler: Handler, cookies: Record<string, string> = {}): Promise<{ status: number; body: Record<string, unknown>; headers: Headers }> {
  jar.clear();
  for (const [k, v] of Object.entries(cookies)) jar.set(k, v);
  const res = await handler();
  return { status: res.status, body: (await res.json()) as Record<string, unknown>, headers: res.headers };
}
const influencerCookie = (token: string) => ({ [authLib.sessionCookieName()]: token });
const adminCookie = (token: string) => ({ [sessionLib.adminCookieName()]: token });
const keys = (o: unknown) => Object.keys(o as object).sort();

before(async () => {
  if (skip) return;
  process.env.RATE_LIMIT_STORE = "memory";
  // GET /api/admin/shell builds the health report, which would open BullMQ/Redis connections that keep the test process alive
  // (and touch the shared Redis). Without REDIS_URL the report degrades exactly as it does in production when Redis is down:
  // `loadAdminShell` then reports 0 health issues.
  delete process.env.REDIS_URL;
  mock.module("next/headers", {
    namedExports: {
      cookies: async () => ({ get: (name: string) => (jar.has(name) ? { name, value: jar.get(name) } : undefined) }),
      headers: async () => new Headers(),
    },
  });
  sessionLib = await import("../lib/admin/session");
  authLib = await import("../lib/auth/session");
  const mfa = await import("../lib/admin/mfa");
  const totp = await import("../lib/admin/totp");
  routes = {
    session: (await import("../app/api/auth/session/route")).GET,
    adminSession: (await import("../app/api/admin/session/route")).GET,
    dashboardShell: (await import("../app/api/dashboard/shell/route")).GET,
    adminShell: (await import("../app/api/admin/shell/route")).GET,
  };

  const accounts = await import("../lib/auth/accounts");
  const registered = await accounts.registerAccount({
    name: `Spa Owner ${run}`,
    email: `spa-owner-${run}@example.com`,
    password: "a long passphrase for the spa test",
    slug: `spa-owner-${run}`,
    timezone: "Asia/Kolkata",
    acceptTerms: true,
  });
  userId = registered.userId;
  influencerId = (await prisma.user.findUniqueOrThrow({ where: { id: userId } })).influencerId;

  const hash = await hashPassword(PASSWORD);
  X = (await prisma.adminUser.create({ data: { email: emailX, name: "Spa Admin X", passwordHash: hash } })).id;
  Y = (await prisma.adminUser.create({ data: { email: emailY, name: "Spa Admin Y", passwordHash: hash } })).id;
  const past = Date.now() - 60_000;
  const secret = (await mfa.startTotpEnrollment(X)).secret;
  assert.ok((await mfa.confirmTotpEnrollment(X, totp.totpAt(secret, past), null, past)).ok);
});

after(async () => {
  if (!skip) {
    if (influencerId) await prisma.influencer.deleteMany({ where: { id: influencerId } });
    if (X) {
      await prisma.adminAuditLog.deleteMany({ where: { adminEmail: { in: [emailX, emailY] } } });
      await prisma.adminUser.deleteMany({ where: { id: { in: [X, Y] } } });
    }
  }
  delete process.env.ADMIN_REQUIRE_2FA;
  await prisma.$disconnect();
});

test("A1 GET /api/auth/session: signed out is a normal 200, signed in has exactly the five hand-picked fields", { skip }, async () => {
  const out = await ask(routes.session);
  assert.equal(out.status, 200);
  assert.deepEqual(out.body, { authenticated: false, emailEnabled: true });
  assert.equal(out.headers.get("cache-control"), "private, no-store");
  assert.equal(out.headers.get("access-control-allow-origin"), null);

  const garbage = await ask(routes.session, influencerCookie("not-a-real-session-token"));
  assert.deepEqual(garbage.body, { authenticated: false, emailEnabled: true }, "an invalid cookie is signed out, not an error");

  const token = await authLib.createSession(userId);
  const signedIn = await ask(routes.session, influencerCookie(token));
  assert.equal(signedIn.status, 200);
  assert.equal(signedIn.body.authenticated, true);
  assert.deepEqual(keys(signedIn.body), ["authenticated", "emailEnabled", "user"]); // emailEnabled: doc/15, whether the site sends e-mail
  assert.deepEqual(keys(signedIn.body.user), ["email", "emailVerified", "name", "onboarded", "slug"]);
  assert.deepEqual(signedIn.body.user, {
    email: `spa-owner-${run}@example.com`,
    emailVerified: false,
    name: `Spa Owner ${run}`,
    slug: `spa-owner-${run}`,
    onboarded: false,
  });
  assertNoSecretKeys(signedIn.body);
  assert.ok(!JSON.stringify(signedIn.body).includes(userId) && !JSON.stringify(signedIn.body).includes(influencerId), "no database ids");
  assert.ok(!JSON.stringify(signedIn.body).includes(token), "the session token is never echoed");

  await prisma.influencer.update({ where: { id: influencerId }, data: { onboardedAt: new Date() } });
  await prisma.user.update({ where: { id: userId }, data: { emailVerifiedAt: new Date() } });
  const done = await ask(routes.session, influencerCookie(token));
  assert.equal((done.body.user as { onboarded: boolean }).onboarded, true);
  assert.equal((done.body.user as { emailVerified: boolean }).emailVerified, true);
  await prisma.influencer.update({ where: { id: influencerId }, data: { onboardedAt: null } });
  await prisma.user.update({ where: { id: userId }, data: { emailVerifiedAt: null } });
});

test("A1 does not answer for an administrator cookie, and A2 does not answer for an influencer cookie", { skip }, async () => {
  const adminToken = await sessionLib.createAdminSession(Y);
  assert.deepEqual((await ask(routes.session, influencerCookie(adminToken))).body, { authenticated: false, emailEnabled: true });
  const influencerToken = await authLib.createSession(userId);
  assert.deepEqual((await ask(routes.adminSession, adminCookie(influencerToken))).body, { authenticated: false, emailEnabled: true });
});

test("A3 GET /api/dashboard/shell: 401 signed out; otherwise the frame data with exactly the hand-picked fields, even before onboarding", { skip }, async () => {
  const out = await ask(routes.dashboardShell);
  assert.equal(out.status, 401);
  assert.equal(typeof out.body.error, "string");
  assert.equal((await ask(routes.dashboardShell, influencerCookie("nope"))).status, 401);

  const token = await authLib.createSession(userId);
  const shell = await ask(routes.dashboardShell, influencerCookie(token));
  assert.equal(shell.status, 200);
  assert.equal(shell.headers.get("cache-control"), "private, no-store");
  assert.deepEqual(keys(shell.body), ["attentionCount", "user"]);
  assert.deepEqual(keys(shell.body.user), ["email", "emailVerified", "name", "onboarded", "photoUrl", "slug"]);
  const user = shell.body.user as Record<string, unknown>;
  assert.equal(user.onboarded, false, "the SPA guard, not the API, sends this account to /onboarding");
  assert.equal(user.photoUrl, null);
  assert.equal(user.slug, `spa-owner-${run}`);
  // Badge: Google not connected (1) + email not verified (1) + nothing to refund (0), the same arithmetic as the old layout.
  assert.equal(shell.body.attentionCount, 2);
  assertNoSecretKeys(shell.body);
  assert.ok(!JSON.stringify(shell.body).includes(userId) && !JSON.stringify(shell.body).includes(influencerId));

  await prisma.user.update({ where: { id: userId }, data: { emailVerifiedAt: new Date() } });
  assert.equal((await ask(routes.dashboardShell, influencerCookie(token))).body.attentionCount, 1);
  await prisma.user.update({ where: { id: userId }, data: { emailVerifiedAt: null } });
});

test("A2 GET /api/admin/session reports the two-factor gate: ok, enroll, verify (never 401, never anything but name, email and gate)", { skip }, async () => {
  const signedOut = await ask(routes.adminSession);
  assert.equal(signedOut.status, 200);
  assert.deepEqual(signedOut.body, { authenticated: false, emailEnabled: true });
  assert.equal(signedOut.headers.get("cache-control"), "private, no-store");
  assert.deepEqual((await ask(routes.adminSession, adminCookie("garbage"))).body, { authenticated: false, emailEnabled: true });

  // Neither required nor enabled: ok.
  const plain = await sessionLib.createAdminSession(Y);
  const ok = await ask(routes.adminSession, adminCookie(plain));
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.body, { authenticated: true, admin: { name: "Spa Admin Y", email: emailY }, gate: "ok", emailEnabled: true });
  assertNoSecretKeys(ok.body);
  assert.ok(!JSON.stringify(ok.body).includes(Y), "no administrator id");

  // 2FA required and not enrolled: enroll.
  process.env.ADMIN_REQUIRE_2FA = "true";
  try {
    const enroll = await ask(routes.adminSession, adminCookie(plain));
    assert.equal(enroll.status, 200);
    assert.equal(enroll.body.gate, "enroll");
    assert.deepEqual(keys(enroll.body), ["admin", "authenticated", "emailEnabled", "gate"]);

    // X has two-factor: a password-only session is "verify", a session that passed the second step is "ok".
    const stale = await passwordOnlySession(X);
    assert.equal((await ask(routes.adminSession, adminCookie(stale))).body.gate, "verify");
    const verified = await sessionLib.createAdminSession(X, {}, { mfaVerified: true });
    assert.equal((await ask(routes.adminSession, adminCookie(verified))).body.gate, "ok");
  } finally {
    delete process.env.ADMIN_REQUIRE_2FA;
  }
  // Even without the requirement, an admin who HAS two-factor and a password-only session is "verify".
  const stale2 = await passwordOnlySession(X);
  assert.equal((await ask(routes.adminSession, adminCookie(stale2))).body.gate, "verify");
});

test("A4 GET /api/admin/shell: 401 signed out; ok and enroll may read it; a password-only session of a 2FA admin may not (403 verify)", { skip }, async () => {
  const signedOut = await ask(routes.adminShell);
  assert.equal(signedOut.status, 401);
  assert.equal((await ask(routes.adminShell, adminCookie("garbage"))).status, 401);

  const shape = (r: { body: Record<string, unknown> }) => {
    assert.deepEqual(keys(r.body), ["admin", "attentionCount", "healthCount"]);
    assert.deepEqual(r.body.admin, r.body.admin && { name: (r.body.admin as { name: string }).name, email: (r.body.admin as { email: string }).email });
    assert.deepEqual(keys(r.body.admin), ["email", "name"]);
    assert.equal(typeof r.body.attentionCount, "number");
    assert.equal(typeof r.body.healthCount, "number");
    assertNoSecretKeys(r.body);
  };

  const plain = await sessionLib.createAdminSession(Y);
  const ok = await ask(routes.adminShell, adminCookie(plain));
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get("cache-control"), "private, no-store");
  shape(ok);
  assert.equal((ok.body.admin as { email: string }).email, emailY);

  process.env.ADMIN_REQUIRE_2FA = "true";
  try {
    const enrolling = await ask(routes.adminShell, adminCookie(plain));
    assert.equal(enrolling.status, 200, "the Security page, the only screen open to an enrolling admin, shows this sidebar");
    shape(enrolling);

    const stale = await passwordOnlySession(X);
    const denied = await ask(routes.adminShell, adminCookie(stale));
    assert.equal(denied.status, 403);
    assert.equal(denied.body.mfaRequired, true);
    assert.equal(denied.body.mfaAction, "verify");
    assert.ok(!("attentionCount" in denied.body), "nothing of the console leaks to a denied session");

    const verified = await sessionLib.createAdminSession(X, {}, { mfaVerified: true });
    shape(await ask(routes.adminShell, adminCookie(verified)));
  } finally {
    delete process.env.ADMIN_REQUIRE_2FA;
  }
});
