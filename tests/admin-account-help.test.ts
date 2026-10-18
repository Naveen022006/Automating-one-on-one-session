// Integration test of the administrator's account help for a platform that sends no e-mail (doc/15):
//   POST /api/admin/influencers/:id/verify-email   and   POST /api/admin/influencers/:id/reset-link
// Needs DATABASE_URL, TOKEN_ENCRYPTION_KEY, APP_SECRET; skipped otherwise. Only `next/headers` (the cookie a request carries) is replaced.
//   - the gate is the console's: 401 signed out, 403 for a password-only session of an administrator with two-factor, 404 for an unknown
//     or malformed id, 409 when there is nothing to do, and a denied request changes nothing;
//   - the change and its audit row are one transaction, a repeat is a 409 with ONE audit row;
//   - the reset link is returned once in the response, works once, expires like an e-mailed one, replaces an older link, is stored only as
//     a hash and is in neither the audit row nor any log line, and a "forgot password" request on a site without e-mail cannot cancel it.
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
const emailX = `ach-x-${run}@example.com`; // administrator with two-factor
const emailY = `ach-y-${run}@example.com`; // administrator without
const ENV_KEYS = ["ADMIN_REQUIRE_2FA", "EMAIL_PROVIDER", "APP_URL", "RATE_LIMIT_STORE", "REDIS_URL", "MESSAGING_DRY_RUN"] as const;
const savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};
let envSaved = false;
const realLog = { log: console.log, error: console.error, warn: console.warn };
const logged: string[] = [];

const jar = new Map<string, string>();
type Ctx = { params: Promise<{ id: string }> };
type Route = { POST: (req: Request, ctx: Ctx) => Promise<Response> };
let verifyRoute: Route;
let linkRoute: Route;
let sessionLib: typeof import("../lib/admin/session");
let accountsLib: typeof import("../lib/auth/accounts");
let X = "";
let Y = "";
let influencerId = "";
let userId = "";
let noUserId = "";

const adminCookie = (token: string) => ({ [sessionLib.adminCookieName()]: token });
const asAdmin = async (token: string | null, call: () => Promise<Response>) => {
  jar.clear();
  if (token) for (const [k, v] of Object.entries(adminCookie(token))) jar.set(k, v);
  const res = await call();
  return { status: res.status, headers: res.headers, body: (await res.json()) as Record<string, unknown> };
};
const verify = (id = influencerId) => verifyRoute.POST(new Request(`http://localhost/api/admin/influencers/${id}/verify-email`, { method: "POST" }), { params: Promise.resolve({ id }) });
const link = (id = influencerId) => linkRoute.POST(new Request(`http://localhost/api/admin/influencers/${id}/reset-link`, { method: "POST" }), { params: Promise.resolve({ id }) });
const audit = (action: string, target = influencerId) => prisma.adminAuditLog.findMany({ where: { action, targetType: "influencer", targetId: target } });
const tokenOf = (url: string) => new URL(url).searchParams.get("token") ?? "";

async function passwordOnlySession(adminId: string): Promise<string> {
  const token = randomToken();
  await prisma.adminSession.create({ data: { tokenHash: hashToken(token), adminId, expiresAt: new Date(Date.now() + 3_600_000) } });
  return token;
}

before(async () => {
  if (skip) return;
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  envSaved = true;
  process.env.RATE_LIMIT_STORE = "memory";
  process.env.MESSAGING_DRY_RUN = "true";
  process.env.APP_URL = "http://localhost:3000";
  process.env.EMAIL_PROVIDER = "none"; // the situation these endpoints exist for
  console.log = (...a: unknown[]) => void logged.push(a.map(String).join(" "));
  console.error = (...a: unknown[]) => void logged.push(a.map(String).join(" "));
  console.warn = (...a: unknown[]) => void logged.push(a.map(String).join(" "));

  mock.module("next/headers", {
    namedExports: {
      cookies: async () => ({ get: (name: string) => (jar.has(name) ? { name, value: jar.get(name) } : undefined) }),
      headers: async () => new Headers(),
    },
  });
  sessionLib = await import("../lib/admin/session");
  accountsLib = await import("../lib/auth/accounts");
  verifyRoute = await import("../app/api/admin/influencers/[id]/verify-email/route");
  linkRoute = await import("../app/api/admin/influencers/[id]/reset-link/route");
  const mfa = await import("../lib/admin/mfa");
  const totp = await import("../lib/admin/totp");

  const hash = await hashPassword(PASSWORD);
  X = (await prisma.adminUser.create({ data: { email: emailX, name: "Ach Admin X", passwordHash: hash } })).id;
  Y = (await prisma.adminUser.create({ data: { email: emailY, name: "Ach Admin Y", passwordHash: hash } })).id;
  const past = Date.now() - 60_000;
  const secret = (await mfa.startTotpEnrollment(X)).secret;
  assert.ok((await mfa.confirmTotpEnrollment(X, totp.totpAt(secret, past), null, past)).ok);

  // Registration on a site without e-mail: the user exists, unverified, and no verification token was created or sent.
  const registered = await accountsLib.registerAccount({ name: `Ach Fixture ${run}`, email: `ach-inf-${run}@example.com`, password: PASSWORD, slug: `ach${run}`, timezone: "Asia/Kolkata", acceptTerms: true });
  userId = registered.userId;
  influencerId = (await prisma.user.findUniqueOrThrow({ where: { id: userId } })).influencerId;
  // An influencer without a sign-in account (a profile created by hand).
  noUserId = (await prisma.influencer.create({ data: { slug: `achn${run}`, name: `Ach NoUser ${run}`, email: `ach-nouser-${run}@example.com` } })).id;
});

after(async () => {
  console.log = realLog.log;
  console.error = realLog.error;
  console.warn = realLog.warn;
  try {
    if (!skip) {
      const step = async (what: string, fn: () => Promise<unknown>) => {
        try {
          await fn();
        } catch (e) {
          console.error(`[admin-account-help] cleanup step failed (${what}):`, e instanceof Error ? e.message : e);
        }
      };
      const ids = [influencerId, noUserId].filter(Boolean);
      await step("audit rows", () => prisma.adminAuditLog.deleteMany({ where: { OR: [{ targetId: { in: ids } }, { adminEmail: { in: [emailX, emailY] } }] } }));
      await step("influencers", () => prisma.influencer.deleteMany({ where: { id: { in: ids } } }));
      await step("administrators", () => prisma.adminUser.deleteMany({ where: { email: { in: [emailX, emailY] } } }));
    }
  } finally {
    if (envSaved) {
      for (const k of ENV_KEYS) {
        if (savedEnv[k] === undefined) delete process.env[k];
        else process.env[k] = savedEnv[k];
      }
    }
    await prisma.$disconnect().catch(() => undefined);
  }
});

test("registering on a site without e-mail succeeds, creates the user unverified, and creates no verification link nobody could receive", { skip }, async () => {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  assert.equal(user.emailVerifiedAt, null);
  assert.equal(await prisma.emailVerificationToken.count({ where: { userId } }), 0);
  assert.equal(await accountsLib.resendVerification(userId), false, "resend is 'not sent', not an error");
  assert.equal(await prisma.emailVerificationToken.count({ where: { userId } }), 0);
});

test("both endpoints are gated like the console: 401 signed out, 403 for a password-only session of an administrator with two-factor; a denial changes nothing", { skip }, async () => {
  const stale = await passwordOnlySession(X);
  for (const [name, call] of [["verify-email", () => verify()], ["reset-link", () => link()]] as const) {
    assert.equal((await asAdmin(null, call)).status, 401, `${name}: no cookie`);
    assert.equal((await asAdmin("garbage", call)).status, 401, `${name}: garbage cookie`);
    const denied = await asAdmin(stale, call);
    assert.equal(denied.status, 403, `${name}: password-only session`);
    assert.equal(denied.body.mfaAction, "verify");
  }
  // And an influencer's session is not an administrator's.
  assert.equal((await prisma.user.findUniqueOrThrow({ where: { id: userId } })).emailVerifiedAt, null);
  assert.equal(await prisma.passwordResetToken.count({ where: { userId } }), 0);
  assert.equal((await audit("influencer.email_verified")).length + (await audit("influencer.reset_link_created")).length, 0);
});

test("unknown and malformed ids are a 404; an influencer without a sign-in account is a 409", { skip }, async () => {
  const token = await sessionLib.createAdminSession(Y);
  for (const id of ["no-such-influencer", "x".repeat(65), "bad id", "a%00b", "cl00000000000000000000000"]) {
    for (const [name, call] of [["verify-email", () => verify(id)], ["reset-link", () => link(id)]] as const) {
      const out = await asAdmin(token, call);
      assert.equal(out.status, 404, `${name} ${id}`);
      assert.deepEqual(out.body, { error: "Influencer not found" });
    }
  }
  for (const call of [() => verify(noUserId), () => link(noUserId)]) {
    const out = await asAdmin(token, call);
    assert.equal(out.status, 409);
    assert.match(String(out.body.error), /no sign-in account/);
  }
  assert.equal((await audit("influencer.email_verified", noUserId)).length, 0);
});

test("verify-email: marks the address verified, one audit row in the same transaction, exact keys; a repeat is a 409 with no second row", { skip }, async () => {
  // A verification link sent earlier (before the site stopped sending e-mail) is retired by the verification.
  await prisma.emailVerificationToken.create({ data: { tokenHash: hashToken(`old-${run}`), userId, expiresAt: new Date(Date.now() + 3_600_000) } });
  const token = await sessionLib.createAdminSession(Y);
  const first = await asAdmin(token, () => verify());
  assert.equal(first.status, 200);
  assert.equal(first.headers.get("cache-control"), "private, no-store");
  assert.deepEqual(first.body, { ok: true, emailVerified: true });
  assertNoSecretKeys(first.body);
  assert.notEqual((await prisma.user.findUniqueOrThrow({ where: { id: userId } })).emailVerifiedAt, null);
  assert.equal(await prisma.emailVerificationToken.count({ where: { userId, usedAt: null } }), 0, "outstanding links are retired");
  const rows = await audit("influencer.email_verified");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].adminEmail, emailY);
  assert.equal(rows[0].detail, null, "nothing but the fact");

  const again = await asAdmin(token, () => verify());
  assert.equal(again.status, 409);
  assert.match(String(again.body.error), /already verified/);
  assert.equal((await audit("influencer.email_verified")).length, 1, "a repeat writes no second row");
});

test("a failing audit insert leaves the address unverified (one transaction)", { skip }, async () => {
  const lib = await import("../lib/admin/account-help");
  const other = await accountsLib.registerAccount({ name: `Ach Two ${run}`, email: `ach-two-${run}@example.com`, password: PASSWORD, slug: `acht${run}`, timezone: "Asia/Kolkata", acceptTerms: true });
  const otherInfluencer = (await prisma.user.findUniqueOrThrow({ where: { id: other.userId } })).influencerId;
  try {
    // An audit row for an administrator that does not exist breaks the foreign key, so the audit insert fails after the update.
    await assert.rejects(lib.adminVerifyEmail({ adminId: "no-such-admin", email: "x@example.com" }, otherInfluencer, null));
    assert.equal((await prisma.user.findUniqueOrThrow({ where: { id: other.userId } })).emailVerifiedAt, null, "the update was rolled back with the failed audit row");
  } finally {
    await prisma.influencer.delete({ where: { id: otherInfluencer } }).catch(() => undefined);
  }
});

test("reset-link: the full link comes back once; it is stored only as a hash and is in no audit row and no log line", { skip }, async () => {
  const admin = await sessionLib.createAdminSession(Y);
  const out = await asAdmin(admin, () => link());
  assert.equal(out.status, 200);
  assert.equal(out.headers.get("cache-control"), "private, no-store");
  assert.deepEqual(Object.keys(out.body).sort(), ["expiresAt", "ok", "url"]);
  const url = String(out.body.url);
  assert.match(url, /^http:\/\/localhost:3000\/reset-password\?token=[A-Za-z0-9_-]{20,}$/);
  const raw = tokenOf(url);

  const row = await prisma.passwordResetToken.findUnique({ where: { tokenHash: hashToken(raw) } });
  assert.ok(row && row.userId === userId && row.usedAt === null);
  assert.ok(!JSON.stringify(row).includes(raw), "only the hash is stored");
  // The same expiry as the e-mailed flow (one hour).
  assert.ok(Math.abs(row.expiresAt.getTime() - (Date.now() + accountsLib.RESET_TTL_MS)) < 30_000);
  assert.equal(new Date(String(out.body.expiresAt)).getTime(), row.expiresAt.getTime());

  const rows = await audit("influencer.reset_link_created");
  assert.equal(rows.length, 1);
  assert.deepEqual(Object.keys(rows[0].detail as object), ["expiresAt"]);
  assert.ok(!JSON.stringify(rows[0]).includes(raw) && !JSON.stringify(rows[0]).includes("reset-password"));
  assert.ok(!logged.join("\n").includes(raw), "the token is in no log line");
  // Nothing else in the response carries it, and it is not a header.
  assert.ok(![...out.headers.values()].some((v) => v.includes(raw)));
});

test("on a site without e-mail 'forgot password' does nothing, so it cannot cancel the link the administrator handed over", { skip }, async () => {
  const admin = await sessionLib.createAdminSession(Y);
  const out = await asAdmin(admin, () => link());
  const raw = tokenOf(String(out.body.url));
  await accountsLib.requestPasswordReset(`ach-inf-${run}@example.com`);
  const row = await prisma.passwordResetToken.findUniqueOrThrow({ where: { tokenHash: hashToken(raw) } });
  assert.equal(row.usedAt, null, "the handed-over link is still good");
  assert.ok(logged.every((l) => !l.includes("[email:password-reset] failed")));
});

test("the link works once, a newer link replaces the older one, and an expired link is refused", { skip }, async () => {
  const admin = await sessionLib.createAdminSession(Y);
  const one = tokenOf(String((await asAdmin(admin, () => link())).body.url));
  const two = tokenOf(String((await asAdmin(admin, () => link())).body.url));
  await assert.rejects(accountsLib.resetPassword(one, "another-long-password-1"), /invalid or has expired|already used/, "creating a newer link cancels the older one");

  // Expiry: age the second link past its hour.
  await prisma.passwordResetToken.update({ where: { tokenHash: hashToken(two) }, data: { expiresAt: new Date(Date.now() - 1000) } });
  await assert.rejects(accountsLib.resetPassword(two, "another-long-password-1"), /invalid or has expired/);

  const three = tokenOf(String((await asAdmin(admin, () => link())).body.url));
  const done = await accountsLib.resetPassword(three, "another-long-password-1");
  assert.equal(done.userId, userId);
  assert.notEqual((await prisma.user.findUniqueOrThrow({ where: { id: userId } })).passwordChangedAt, null);
  await assert.rejects(accountsLib.resetPassword(three, "yet-another-long-password-2"), /invalid or has expired|already used/, "one time only");
  // Setting the new password proved control of the account, so it also verifies the address (the existing reset flow).
  assert.notEqual((await prisma.user.findUniqueOrThrow({ where: { id: userId } })).emailVerifiedAt, null);
  assert.equal((await audit("influencer.reset_link_created")).length, 5, "every link handed over (two in the tests above, three here) is in the audit trail");
});

test("no token reached the logs at any point", { skip }, async () => {
  const tokens = await prisma.passwordResetToken.findMany({ where: { userId }, select: { tokenHash: true } });
  assert.ok(tokens.length >= 1);
  assert.ok(!/reset-password\?token=/.test(logged.join("\n")), "no reset link was logged");
});
