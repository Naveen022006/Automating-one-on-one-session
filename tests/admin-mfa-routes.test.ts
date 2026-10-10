// Integration test of the real route handlers (needs DATABASE_URL, TOKEN_ENCRYPTION_KEY, APP_SECRET; skipped otherwise).
// Only `next/headers` is replaced, so the admin session cookie can be chosen per call; rate limits use the in-memory store.
// Covers: the two-step login routes, the 403 `mfaRequired` gate on every sensitive admin route, and the enrolment route.
import "dotenv/config";
import assert from "node:assert/strict";
import { after, before, mock, test } from "node:test";
import { hashPassword } from "../lib/auth/password";
import { hashToken, randomToken } from "../lib/auth/tokens";
import { prisma } from "../lib/db";
import type { OutgoingEmail } from "../lib/email/providers";

const skip = process.env.DATABASE_URL && process.env.TOKEN_ENCRYPTION_KEY && process.env.APP_SECRET ? false : "DATABASE_URL / TOKEN_ENCRYPTION_KEY / APP_SECRET not set";
const run = Date.now();
const PASSWORD = "correct-horse-battery-9";
const emailX = `routes-x-${run}@example.com`; // has two-factor
const emailY = `routes-y-${run}@example.com`; // does not (yet)
const emailQ = `routes-q-${run}@example.com`; // has two-factor; fail-closed and many-IP guessing tests
const emailZ = `routes-z-${run}@example.com`; // has two-factor; the per-admin hourly caps
let X = "";
let Y = "";
let Q = "";
let Z = "";
let secretX = "";
let recoveryX: string[] = [];
let secretQ = "";
let recoveryQ: string[] = [];
const sent: OutgoingEmail[] = [];
const URL2FA = "/api/admin/security/2fa";

let currentCookie = "";
// Loaded after the mock is registered (so session.ts binds to the fake next/headers).
type Handler = (req: Request, ctx: { params: Promise<{ id: string }> }) => Promise<Response>;
let routes: Record<"fee" | "payoutAccount" | "createPayout" | "reconcile" | "unreconcile" | "payout", Record<string, Handler>>;
let loginRoute: (req: Request) => Promise<Response>;
let mfaRoute: (req: Request) => Promise<Response>;
let securityRoute: (req: Request) => Promise<Response>;
let changePasswordRoute: (req: Request) => Promise<Response>;
let session: typeof import("../lib/admin/session");
let mfa: typeof import("../lib/admin/mfa");
let totp: typeof import("../lib/admin/totp");
let rateLimit: typeof import("../lib/rate-limit");
let securityPage: () => Promise<unknown>;

/**
 * A password-only session row for an admin (no mfaVerifiedAt), like one created before they enrolled. Inserted directly
 * because createAdminSession refuses to create one for an admin who has 2FA on.
 */
async function passwordOnlySession(adminId: string): Promise<string> {
  const token = randomToken();
  await prisma.adminSession.create({ data: { tokenHash: hashToken(token), adminId, expiresAt: new Date(Date.now() + 3_600_000) } });
  return token;
}

/** The URL a `redirect()` thrown by a server component points to, or null if the callback did not redirect. */
async function redirectOf(fn: () => Promise<unknown>): Promise<string | null> {
  try {
    await fn();
    return null;
  } catch (e) {
    const digest = (e as { digest?: string }).digest;
    if (typeof digest === "string" && digest.startsWith("NEXT_REDIRECT")) return digest.split(";")[2];
    throw e;
  }
}

/** Every string reachable through a React element tree's props (titles, text, rows), without rendering client components. */
function textOf(node: unknown, seen = new Set<unknown>(), out: string[] = []): string[] {
  if (typeof node === "string") out.push(node);
  else if (Array.isArray(node)) for (const n of node) textOf(n, seen, out);
  else if (node && typeof node === "object" && !seen.has(node)) {
    seen.add(node);
    const props = (node as { props?: Record<string, unknown> }).props;
    if (props) for (const v of Object.values(props)) textOf(v, seen, out);
  }
  return out;
}

async function enrol(adminId: string): Promise<{ secret: string; recovery: string[] }> {
  const past = Date.now() - 60_000; // a minute "in the past", so codes for the real clock are fresh
  const secret = (await mfa.startTotpEnrollment(adminId)).secret;
  const done = await mfa.confirmTotpEnrollment(adminId, totp.totpAt(secret, past), null, past);
  assert.ok(done.ok);
  return { secret, recovery: done.ok ? done.recoveryCodes : [] };
}

function json(url: string, body: unknown, ip = "203.0.113.1"): Request {
  return new Request(`http://localhost${url}`, { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": ip }, body: JSON.stringify(body) });
}
const ctxFor = (id = "does-not-exist") => ({ params: Promise.resolve({ id }) });

/** Every sensitive admin route, with a body that passes validation and then stops at "not found" (no side effects). */
function sensitiveCalls(): { name: string; run: () => Promise<Response>; passes: number }[] {
  return [
    { name: "change fee", run: () => routes.fee.PATCH(new Request("http://localhost/x", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ feePercent: 5 }) }), ctxFor()), passes: 404 },
    { name: "verify payout account", run: () => routes.payoutAccount.POST(json("/x", { action: "verify" }), ctxFor()), passes: 404 },
    { name: "reveal payout account", run: () => routes.payoutAccount.POST(json("/x", { action: "reveal" }), ctxFor()), passes: 404 },
    { name: "reject payout account", run: () => routes.payoutAccount.POST(json("/x", { action: "reject", reason: "Please fix the IFSC code" }), ctxFor()), passes: 404 },
    { name: "create payout", run: () => routes.createPayout.POST(json("/x", { currency: "INR" }), ctxFor()), passes: 404 },
    { name: "reconcile", run: () => routes.reconcile.POST(json("/x", { paymentIds: ["does-not-exist"] }), ctxFor()), passes: 200 },
    { name: "undo reconcile", run: () => routes.unreconcile.POST(json("/x", {}), ctxFor()), passes: 409 },
    { name: "approve payout", run: () => routes.payout.POST(json("/x", { action: "approve" }), ctxFor()), passes: 404 },
    { name: "mark payout paid", run: () => routes.payout.POST(json("/x", { action: "paid", reference: "UTR1234567" }), ctxFor()), passes: 409 },
    { name: "cancel payout", run: () => routes.payout.POST(json("/x", { action: "cancel" }), ctxFor()), passes: 409 },
  ];
}

before(async () => {
  if (skip) return;
  process.env.RATE_LIMIT_STORE = "memory";
  mock.module("next/headers", {
    namedExports: {
      cookies: async () => ({ get: (name: string) => (currentCookie ? { name, value: currentCookie } : undefined) }),
      headers: async () => new Headers(),
    },
  });
  session = await import("../lib/admin/session");
  mfa = await import("../lib/admin/mfa");
  totp = await import("../lib/admin/totp");
  rateLimit = await import("../lib/rate-limit");
  (await import("../lib/email")).setEmailSender(async (e) => {
    sent.push(e); // captured, never sent
    return { providerMessageId: null };
  });
  securityPage = (await import("../app/admin/(console)/security/page")).default as unknown as () => Promise<unknown>;
  routes = {
    fee: await import("../app/api/admin/influencers/[id]/fee/route"),
    payoutAccount: await import("../app/api/admin/influencers/[id]/payout-account/route"),
    createPayout: await import("../app/api/admin/influencers/[id]/payouts/route"),
    reconcile: await import("../app/api/admin/payments/reconcile/route"),
    unreconcile: await import("../app/api/admin/payments/[id]/unreconcile/route"),
    payout: await import("../app/api/admin/payouts/[id]/route"),
  } as unknown as typeof routes;
  loginRoute = (await import("../app/api/admin/auth/login/route")).POST;
  mfaRoute = (await import("../app/api/admin/auth/mfa/route")).POST;
  securityRoute = (await import("../app/api/admin/security/2fa/route")).POST;
  changePasswordRoute = (await import("../app/api/admin/auth/change-password/route")).POST;

  const hash = await hashPassword(PASSWORD);
  X = (await prisma.adminUser.create({ data: { email: emailX, name: "Routes X", passwordHash: hash } })).id;
  Y = (await prisma.adminUser.create({ data: { email: emailY, name: "Routes Y", passwordHash: hash } })).id;
  Q = (await prisma.adminUser.create({ data: { email: emailQ, name: "Routes Q", passwordHash: hash } })).id;
  Z = (await prisma.adminUser.create({ data: { email: emailZ, name: "Routes Z", passwordHash: hash } })).id;
  ({ secret: secretX, recovery: recoveryX } = await enrol(X));
  ({ secret: secretQ, recovery: recoveryQ } = await enrol(Q));
  await enrol(Z);
});

after(async () => {
  if (!skip && X) {
    await prisma.adminAuditLog.deleteMany({ where: { adminEmail: { in: [emailX, emailY, emailQ, emailZ] } } });
    // Rejected pending tokens are audited without a known admin (email "unknown").
    await prisma.adminAuditLog.deleteMany({ where: { adminEmail: "unknown", action: "admin.mfa_failed", createdAt: { gte: new Date(run - 1000) } } });
    await prisma.adminUser.deleteMany({ where: { id: { in: [X, Y, Q, Z] } } });
  }
  delete process.env.ADMIN_REQUIRE_2FA;
  await prisma.$disconnect();
});

function cookieValue(res: Response): string | null {
  const set = res.headers.getSetCookie().find((c) => c.startsWith(`${session.adminCookieName()}=`));
  return set ? set.split(";")[0].slice(session.adminCookieName().length + 1) : null;
}

test("password step for an admin with 2FA returns a pending token and NO session cookie", { skip }, async () => {
  const res = await loginRoute(json("/api/admin/auth/login", { email: emailX, password: PASSWORD }, "198.51.100.10"));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.mfaRequired, true);
  assert.equal(typeof body.pendingToken, "string");
  assert.equal(body.expiresInSec, 300);
  assert.equal(cookieValue(res), null, "no cookie from the password alone");
  assert.equal(body.redirect, undefined);
  assert.equal(await prisma.adminSession.count({ where: { adminId: X } }), 0, "no session row either");

  const bad = await loginRoute(json("/api/admin/auth/login", { email: emailX, password: "wrong-password-123" }, "198.51.100.11"));
  assert.equal(bad.status, 401);
  assert.equal((await bad.json()).pendingToken, undefined, "a wrong password gets no token");

  const audit = await prisma.adminAuditLog.findMany({ where: { adminEmail: emailX, action: { in: ["admin.login_mfa_challenge", "admin.login_failed"] } } });
  assert.ok(audit.some((a) => a.action === "admin.login_mfa_challenge"));
});

test("second step: wrong code, then the right code creates an MFA-verified session; the same code cannot be used again", { skip }, async () => {
  const ip = "198.51.100.20";
  const { pendingToken } = await (await loginRoute(json("/api/admin/auth/login", { email: emailX, password: PASSWORD }, ip))).json();

  const wrong = await mfaRoute(json("/api/admin/auth/mfa", { pendingToken, code: "000000" }, ip));
  assert.equal(wrong.status, 401);
  assert.equal(cookieValue(wrong), null);
  assert.equal(await prisma.adminSession.count({ where: { adminId: X } }), 0);

  const code = totp.totpAt(secretX, Date.now());
  const ok = await mfaRoute(json("/api/admin/auth/mfa", { pendingToken, code, next: "/admin/payouts" }, ip));
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).redirect, "/admin/payouts");
  const cookie = cookieValue(ok);
  assert.ok(cookie, "a session cookie is issued");
  const ctx = await session.resolveAdminSession(cookie);
  assert.equal(ctx?.adminId, X);
  assert.equal(ctx?.mfaVerified, true);

  // A fresh login attempt replaying the very same code is refused.
  const again = await (await loginRoute(json("/api/admin/auth/login", { email: emailX, password: PASSWORD }, ip))).json();
  const replay = await mfaRoute(json("/api/admin/auth/mfa", { pendingToken: again.pendingToken, code }, ip));
  assert.equal(replay.status, 401);
  assert.match((await replay.json()).error, /already used/);

  const actions = (await prisma.adminAuditLog.findMany({ where: { adminEmail: emailX } })).map((a) => `${a.action}:${(a.detail as { reason?: string; method?: string } | null)?.reason ?? (a.detail as { method?: string } | null)?.method ?? ""}`);
  assert.ok(actions.includes("admin.mfa_failed:invalid"), "a failed code is audited");
  assert.ok(actions.includes("admin.mfa_failed:replayed"), "a replayed code is audited");
  assert.ok(actions.includes("admin.login:totp"), "a successful second step is audited");
});

test("second step: a recovery code signs in once; an expired or forged pending token is refused with restart", { skip }, async () => {
  const ip = "198.51.100.30";
  const start = async () => (await (await loginRoute(json("/api/admin/auth/login", { email: emailX, password: PASSWORD }, ip))).json()).pendingToken as string;

  const first = await mfaRoute(json("/api/admin/auth/mfa", { pendingToken: await start(), code: recoveryX[0] }, ip));
  assert.equal(first.status, 200);
  assert.equal((await first.json()).recoveryCodesLeft, 9);
  assert.ok(cookieValue(first));
  const second = await mfaRoute(json("/api/admin/auth/mfa", { pendingToken: await start(), code: recoveryX[0] }, ip));
  assert.equal(second.status, 401, "a recovery code works once");

  const expired = mfa.issueAdminPendingToken(X, session.adminPasswordFingerprint((await prisma.adminUser.findUniqueOrThrow({ where: { id: X } })).passwordHash), -5);
  const res = await mfaRoute(json("/api/admin/auth/mfa", { pendingToken: expired, code: totp.totpAt(secretX, Date.now() + 300_000) }, ip));
  assert.equal(res.status, 401);
  assert.equal((await res.json()).restart, true);
  const forged = await mfaRoute(json("/api/admin/auth/mfa", { pendingToken: "e30.AAAA", code: "123456" }, ip));
  assert.equal(forged.status, 401);

  const audit = await prisma.adminAuditLog.findMany({ where: { adminEmail: emailX, action: "admin.recovery_code_used" } });
  assert.ok(audit.length >= 1, "using a recovery code is audited");
});

test("second step is rate limited per admin and IP, and a lockout also stops the right code", { skip }, async () => {
  const ip = "198.51.100.40";
  const { pendingToken } = await (await loginRoute(json("/api/admin/auth/login", { email: emailX, password: PASSWORD }, ip))).json();
  const statuses: number[] = [];
  for (let i = 0; i < 8; i++) statuses.push((await mfaRoute(json("/api/admin/auth/mfa", { pendingToken, code: "000000" }, ip))).status);
  assert.deepEqual(statuses.slice(0, 6), [401, 401, 401, 401, 401, 401], "six attempts are allowed (admin-mfa-admin-ip)");
  assert.deepEqual(statuses.slice(6), [429, 429], "then the limiter answers 429");
  const blocked = await mfaRoute(json("/api/admin/auth/mfa", { pendingToken, code: totp.totpAt(secretX, Date.now()) }, ip));
  assert.equal(blocked.status, 429, "even a correct code is refused while rate limited");
  // Another IP is not affected (a stranger cannot lock the real admin out from their own address).
  const other = await mfaRoute(json("/api/admin/auth/mfa", { pendingToken, code: "000000" }, "198.51.100.41"));
  assert.equal(other.status, 401);
});

test("every sensitive admin route refuses a session that did not pass the second factor, and allows one that did", { skip }, async () => {
  const stale = await passwordOnlySession(X); // password only, although X has 2FA
  const verified = await session.createAdminSession(X, {}, { mfaVerified: true });

  const calls = sensitiveCalls();
  assert.equal(calls.length, 10);
  for (const c of calls) {
    currentCookie = "";
    assert.equal((await c.run()).status, 401, `${c.name}: not signed in`);

    currentCookie = stale;
    const denied = await c.run();
    assert.equal(denied.status, 403, `${c.name}: password-only session`);
    const body = await denied.json();
    assert.equal(body.mfaRequired, true, `${c.name}: mfaRequired flag`);
    assert.equal(body.mfaAction, "verify");
    assert.equal(typeof body.error, "string");

    currentCookie = verified;
    const allowed = await c.run();
    assert.equal(allowed.status, c.passes, `${c.name}: verified session reaches the handler`);
  }
  currentCookie = "";
});

test("ADMIN_REQUIRE_2FA: an admin who has not enrolled is locked out of every admin API except enrolment", { skip }, async () => {
  process.env.ADMIN_REQUIRE_2FA = "true";
  try {
    currentCookie = await session.createAdminSession(Y);
    for (const c of sensitiveCalls()) {
      const res = await c.run();
      assert.equal(res.status, 403, c.name);
      const body = await res.json();
      assert.equal(body.mfaRequired, true);
      assert.equal(body.mfaAction, "enroll");
    }
    const pw = await changePasswordRoute(json("/api/admin/auth/change-password", { currentPassword: PASSWORD, newPassword: "a-brand-new-passphrase-7" }));
    assert.equal(pw.status, 403, "even a non-sensitive admin route is closed");
    assert.equal((await pw.json()).mfaRequired, true);

    // A session cookie alone cannot enrol: without the password (missing or wrong) nothing is generated or stored.
    const ip = "198.51.100.60";
    const noPassword = await securityRoute(json(URL2FA, { action: "setup" }, ip));
    assert.equal(noPassword.status, 400, "setup without a password is refused");
    const wrongPassword = await securityRoute(json(URL2FA, { action: "setup", password: "not-the-password-1" }, ip));
    assert.equal(wrongPassword.status, 400);
    assert.equal((await wrongPassword.json()).field, "password");
    assert.equal((await prisma.adminUser.findUniqueOrThrow({ where: { id: Y } })).totpSecretEnc, null, "no secret was created for the cookie holder");

    // With the password it works: set up, confirm with a wrong code / password / no password, then the right ones.
    const setup = await securityRoute(json(URL2FA, { action: "setup", password: PASSWORD }, ip));
    assert.equal(setup.status, 200);
    const { secret, uri } = await setup.json();
    assert.match(secret, /^[A-Z2-7]{32}$/);
    assert.match(uri, /^otpauth:\/\/totp\//);

    const goodCode = totp.totpAt(secret, Date.now());
    assert.equal((await securityRoute(json(URL2FA, { action: "enable", code: goodCode }, ip))).status, 400, "enable without a password is refused");
    const wrongPwEnable = await securityRoute(json(URL2FA, { action: "enable", password: "not-the-password-1", code: goodCode }, ip));
    assert.equal(wrongPwEnable.status, 400, "a valid code with the wrong password does not enable 2FA");
    assert.equal((await wrongPwEnable.json()).field, "password");
    assert.equal((await prisma.adminUser.findUniqueOrThrow({ where: { id: Y } })).totpEnabledAt, null);
    const badEnable = await securityRoute(json(URL2FA, { action: "enable", password: PASSWORD, code: "000000" }, ip));
    assert.equal(badEnable.status, 400);
    const stillBlocked = await sensitiveCalls()[0].run();
    assert.equal(stillBlocked.status, 403, "a failed confirmation does not unlock anything");

    const enable = await securityRoute(json(URL2FA, { action: "enable", password: PASSWORD, code: goodCode }, ip));
    assert.equal(enable.status, 200);
    const { recoveryCodes } = await enable.json();
    assert.equal(recoveryCodes.length, 10);
    assert.ok(sent.some((e) => e.to.email === emailY && /turned on/i.test(e.subject)), "the admin is emailed when 2FA is enabled");

    // The session that enrolled is now verified: the gate opens (the sensitive calls reach their handlers).
    for (const c of sensitiveCalls()) assert.equal((await c.run()).status, c.passes, c.name);
    const ctx = await session.resolveAdminSession(currentCookie);
    assert.equal(ctx?.mfaVerified, true);
    assert.equal(ctx?.totpEnabled, true);

    // Turning it off needs the password AND a valid code; a wrong code or password fails and nothing changes.
    const other = await session.createAdminSession(Y, {}, { mfaVerified: true }); // a second browser of the same admin
    const stolen = await passwordOnlySession(Y); // and a leftover password-only session
    const noCode = await securityRoute(json(URL2FA, { action: "disable", password: PASSWORD, code: "000000" }, ip));
    assert.equal(noCode.status, 400);
    const wrongPwDisable = await securityRoute(json(URL2FA, { action: "disable", password: "not-the-password-1", code: recoveryCodes[0] }, ip));
    assert.equal(wrongPwDisable.status, 400);
    assert.equal((await mfa.getMfaStatus(Y)).enabled, true, "still on after the refused attempts");
    assert.equal((await mfa.getMfaStatus(Y)).recoveryCodesLeft, 10, "the recovery code was not consumed by the wrong-password attempt");
    const viaRecovery = await securityRoute(json(URL2FA, { action: "disable", password: PASSWORD, code: recoveryCodes[0] }, ip));
    assert.equal(viaRecovery.status, 200);
    assert.equal((await sensitiveCalls()[0].run()).status, 403, "required again once 2FA is off");
    assert.equal(await session.resolveAdminSession(other), null, "disabling signs every OTHER session of the admin out");
    assert.equal(await session.resolveAdminSession(stolen), null, "including a leftover password-only one that could race to re-enrol");
    assert.equal((await session.resolveAdminSession(currentCookie))?.adminId, Y, "the session that made the change survives");
    assert.ok(sent.some((e) => e.to.email === emailY && /turned off/i.test(e.subject)), "the admin is emailed when 2FA is disabled");

    const actions = (await prisma.adminAuditLog.findMany({ where: { adminEmail: emailY } })).map((a) => a.action);
    for (const expected of ["admin.2fa_setup_started", "admin.mfa_failed", "admin.2fa_enabled", "admin.2fa_disabled"]) {
      assert.ok(actions.includes(expected), `audited: ${expected}`);
    }
    const reasons = (await prisma.adminAuditLog.findMany({ where: { adminEmail: emailY, action: "admin.mfa_failed" } })).map((a) => (a.detail as { reason?: string }).reason);
    assert.ok(reasons.includes("wrong-password"), "wrong passwords are audited");
  } finally {
    delete process.env.ADMIN_REQUIRE_2FA;
    currentCookie = "";
  }
});

test("without ADMIN_REQUIRE_2FA an admin with no 2FA can still use the console (development default)", { skip }, async () => {
  delete process.env.ADMIN_REQUIRE_2FA;
  currentCookie = await session.createAdminSession(Y);
  for (const c of sensitiveCalls()) assert.equal((await c.run()).status, c.passes, c.name);
  currentCookie = "";
});

test("payout approval over HTTP: the creator is refused, another administrator approves, mark-as-paid waits for it", { skip }, async () => {
  process.env.PAYOUT_FOUR_EYES = "true";
  const influencer = await prisma.influencer.create({ data: { slug: `routes-po-${run}`, name: "Routes Payout", email: `routes-po-${run}@example.com` } });
  const payout = await prisma.payout.create({
    data: {
      influencerId: influencer.id,
      currency: "INR",
      grossMinor: 50_000,
      refundsMinor: 0,
      feeBps: 0,
      feeMinor: 0,
      netMinor: 50_000,
      paymentCount: 1,
      destination: "HDFC Bank XXXXXXXX9012",
      createdByEmail: emailX,
    },
  });
  const approve = () => routes.payout.POST(json("/x", { action: "approve" }), ctxFor(payout.id));
  const pay = () => routes.payout.POST(json("/x", { action: "paid", reference: "UTR1234567890" }), ctxFor(payout.id));
  try {
    // X created the payout (and passed 2FA): it still cannot approve its own payout, and nobody can pay it yet.
    currentCookie = await session.createAdminSession(X, {}, { mfaVerified: true });
    const own = await approve();
    assert.equal(own.status, 403);
    assert.match((await own.json()).error, /different administrator/);
    const earlyPay = await pay();
    assert.equal(earlyPay.status, 409);
    assert.match((await earlyPay.json()).error, /second administrator/);

    // Y is a different administrator.
    currentCookie = await session.createAdminSession(Y);
    assert.equal((await pay()).status, 409, "another admin cannot pay an unapproved payout either");
    const ok = await approve();
    assert.equal(ok.status, 200);
    assert.equal((await ok.json()).approvedByEmail, emailY);
    const row = await prisma.payout.findUniqueOrThrow({ where: { id: payout.id } });
    assert.equal(row.approvedByEmail, emailY);
    assert.ok(row.approvedAt);
    assert.equal(row.status, "PENDING");
    assert.equal((await approve()).status, 409, "approving twice");

    const audit = await prisma.adminAuditLog.findMany({ where: { action: "payout.approved", targetId: payout.id } });
    assert.equal(audit.length, 1, "payout.approved is audited once, for the approver");
    assert.equal(audit[0].adminEmail, emailY);
    assert.equal((audit[0].detail as { createdBy?: string }).createdBy, emailX);
    await prisma.adminAuditLog.deleteMany({ where: { action: "payout.approved", targetId: payout.id } });
  } finally {
    delete process.env.PAYOUT_FOUR_EYES;
    currentCookie = "";
    await prisma.payout.deleteMany({ where: { influencerId: influencer.id } });
    await prisma.influencer.delete({ where: { id: influencer.id } });
  }
});

test("regenerating recovery codes needs the password as well as a code, and the admin is emailed", { skip }, async () => {
  currentCookie = await session.createAdminSession(X, {}, { mfaVerified: true });
  const ip = "198.51.100.80";
  try {
    const unused = () => prisma.adminRecoveryCode.count({ where: { adminId: X, usedAt: null } });
    const start = await unused();
    assert.equal((await securityRoute(json(URL2FA, { action: "regenerate", code: recoveryX[3] }, ip))).status, 400, "no password");
    const wrongPw = await securityRoute(json(URL2FA, { action: "regenerate", password: "not-the-password-1", code: recoveryX[3] }, ip));
    assert.equal(wrongPw.status, 400);
    assert.equal(await unused(), start, "nothing changed and the code was not consumed");

    const ok = await securityRoute(json(URL2FA, { action: "regenerate", password: PASSWORD, code: recoveryX[3] }, ip));
    assert.equal(ok.status, 200);
    const { recoveryCodes } = await ok.json();
    assert.equal(recoveryCodes.length, 10);
    recoveryX = recoveryCodes;
    assert.ok(sent.some((e) => e.to.email === emailX && /recovery codes/i.test(e.subject)), "the admin is emailed");
    assert.ok((await prisma.adminAuditLog.count({ where: { adminEmail: emailX, action: "admin.2fa_recovery_regenerated" } })) >= 1);
  } finally {
    currentCookie = "";
  }
});

test("every password attempt, wrong ones included, counts against the re-auth limiter", { skip }, async () => {
  currentCookie = await session.createAdminSession(Y);
  const ip = "198.51.100.90";
  try {
    const statuses: number[] = [];
    for (let i = 0; i < 10; i++) statuses.push((await securityRoute(json(URL2FA, { action: "setup", password: `wrong-password-${i}` }, ip))).status);
    assert.deepEqual(statuses, Array(10).fill(400), "ten wrong passwords are answered, not stored");
    const limited = await securityRoute(json(URL2FA, { action: "setup", password: PASSWORD }, ip));
    assert.equal(limited.status, 429, "the eleventh attempt is refused even with the right password");
    assert.equal((await prisma.adminUser.findUniqueOrThrow({ where: { id: Y } })).totpSecretEnc, null, "nothing was enrolled");
    // The limit is per admin AND IP: the right password from another address is accepted.
    assert.equal((await securityRoute(json(URL2FA, { action: "setup", password: PASSWORD }, "198.51.100.91"))).status, 200);
  } finally {
    currentCookie = "";
  }
});

test("when the rate limiter is down the admin code and password checks refuse (503) instead of allowing unlimited guesses", { skip }, async () => {
  const ip = "198.51.100.110";
  const { pendingToken } = await (await loginRoute(json("/api/admin/auth/login", { email: emailQ, password: PASSWORD }, ip))).json();
  const code = totp.totpAt(secretQ, Date.now());
  const lastStep = () => prisma.adminUser.findUniqueOrThrow({ where: { id: Q }, select: { totpLastStep: true } }).then((r) => r.totpLastStep);
  const stepBefore = await lastStep();
  const sessionsBefore = await prisma.adminSession.count({ where: { adminId: Q } });

  rateLimit.setStore({
    name: "broken",
    hit: async () => {
      throw new Error("rate-limit store down");
    },
  });
  try {
    const res = await mfaRoute(json("/api/admin/auth/mfa", { pendingToken, code }, ip));
    assert.equal(res.status, 503, "the login code step fails closed");
    assert.match((await res.json()).error, /temporarily unavailable/);
    assert.equal(cookieValue(res), null);
    assert.equal(await prisma.adminSession.count({ where: { adminId: Q } }), sessionsBefore, "no session was created");
    assert.equal(await lastStep(), stepBefore, "the correct code was never evaluated, so it is not consumed");

    currentCookie = await session.createAdminSession(Q, {}, { mfaVerified: true });
    const manage = await securityRoute(json(URL2FA, { action: "regenerate", password: PASSWORD, code: recoveryQ[9] }, ip));
    assert.equal(manage.status, 503, "so does the Security page");
    assert.equal(await prisma.adminRecoveryCode.count({ where: { adminId: Q, usedAt: null } }), 10, "no recovery code was touched");
  } finally {
    rateLimit.setStore(null);
    currentCookie = "";
  }
  // With the limiter back the very same code works.
  const ok = await mfaRoute(json("/api/admin/auth/mfa", { pendingToken, code }, ip));
  assert.equal(ok.status, 200);
});

test("guessing spread over many IP addresses still hits the durable lockout; a recovery code still lets the real admin in", { skip }, async () => {
  await prisma.adminUser.update({ where: { id: Q }, data: { mfaFailedCount: 0, mfaLockLevel: 0, mfaLockedUntil: null } });
  const { pendingToken } = await (await loginRoute(json("/api/admin/auth/login", { email: emailQ, password: PASSWORD }, "198.51.100.120"))).json();

  const statuses: number[] = [];
  for (let i = 0; i < 10; i++) statuses.push((await mfaRoute(json("/api/admin/auth/mfa", { pendingToken, code: "000000" }, `198.51.100.${130 + i}`))).status);
  assert.deepEqual(statuses, Array(10).fill(401), "ten wrong guesses from ten addresses: no per-IP limit is ever reached");

  const sessionsBefore = await prisma.adminSession.count({ where: { adminId: Q } });
  const correct = totp.totpAt(secretQ, Date.now() + 30_000); // a fresh step, so only the lock can refuse it
  const locked = await mfaRoute(json("/api/admin/auth/mfa", { pendingToken, code: correct }, "198.51.100.150"));
  assert.equal(locked.status, 429);
  const body = await locked.json();
  assert.equal(body.locked, true);
  assert.match(body.error, /locked/i);
  assert.equal(cookieValue(locked), null);
  assert.equal(await prisma.adminSession.count({ where: { adminId: Q } }), sessionsBefore, "even the correct code gets no session while locked");
  assert.ok(sent.some((e) => e.to.email === emailQ && /locked/i.test(e.subject)), "the admin was emailed about the lock");

  // Break-glass: password (the pending token) + a recovery code works while locked, and clears the lock.
  const rec = await mfaRoute(json("/api/admin/auth/mfa", { pendingToken, code: recoveryQ[0] }, "198.51.100.151"));
  assert.equal(rec.status, 200);
  assert.ok(cookieValue(rec));
  const state = await prisma.adminUser.findUniqueOrThrow({ where: { id: Q }, select: { mfaLockedUntil: true, mfaLockLevel: true } });
  assert.deepEqual(state, { mfaLockedUntil: null, mfaLockLevel: 0 });
});

test("per-admin hourly caps hold across many IP addresses: 30 attempts at the code step and 30 on the Security page", { skip }, async () => {
  // Code step: lock Z so every attempt is cheap and cannot succeed, then use a different IP for each.
  await prisma.adminUser.update({ where: { id: Z }, data: { mfaLockedUntil: new Date(Date.now() + 3_600_000) } });
  const { pendingToken } = await (await loginRoute(json("/api/admin/auth/login", { email: emailZ, password: PASSWORD }, "198.51.100.160"))).json();
  const attempts: { status: number; body: { locked?: boolean; error: string } }[] = [];
  for (let i = 0; i < 31; i++) {
    const res = await mfaRoute(json("/api/admin/auth/mfa", { pendingToken, code: "000000" }, `198.51.100.${170 + i}`));
    attempts.push({ status: res.status, body: await res.json() });
  }
  for (const a of attempts.slice(0, 30)) assert.ok(a.status === 429 && a.body.locked === true, "the first 30 reach the lockout check");
  assert.equal(attempts[30].status, 429);
  assert.equal(attempts[30].body.locked, undefined, "the 31st is stopped by the per-admin cap, before the lockout check");
  assert.match(attempts[30].body.error, /Too many attempts on this account/);

  // Security page: 30 wrong-password attempts from 30 addresses, then the 31st is stopped by the per-admin cap.
  currentCookie = await session.createAdminSession(Z, {}, { mfaVerified: true });
  try {
    const results: { status: number; error: string }[] = [];
    for (let i = 0; i < 31; i++) {
      const res = await securityRoute(json(URL2FA, { action: "regenerate", password: `wrong-password-${i}`, code: "000000" }, `198.51.100.${210 + i}`));
      results.push({ status: res.status, error: (await res.json()).error });
    }
    for (const r of results.slice(0, 30)) assert.equal(r.status, 400, "wrong password");
    assert.equal(results[30].status, 429);
    assert.match(results[30].error, /Too many attempts on this account/);
  } finally {
    currentCookie = "";
  }
});

test("page guards: signed-out, must-enrol and password-only sessions are each sent where they belong", { skip }, async () => {
  process.env.ADMIN_REQUIRE_2FA = "true";
  try {
    currentCookie = "";
    assert.equal(await redirectOf(() => session.requireAdminPage("/admin/payouts")), "/admin/login?next=%2Fadmin%2Fpayouts");

    // "enroll": 2FA is required and Y has none -> Security is the only page open.
    currentCookie = await session.createAdminSession(Y);
    assert.equal(await redirectOf(() => session.requireAdminPage("/admin/payouts")), "/admin/security");
    assert.equal(await redirectOf(() => session.requireAdminPage("/admin")), "/admin/security");
    assert.equal(await redirectOf(() => session.requireAdminPage("/admin/security")), null);
    assert.equal(await redirectOf(() => session.requireAdminPage("/admin/payouts", { mfaGate: false })), null, "mfaGate:false skips the redirect");

    // "verify": X has 2FA, this session is password-only -> back to sign in with a code, from every page.
    currentCookie = await passwordOnlySession(X);
    for (const p of ["/admin", "/admin/payouts", "/admin/security"]) {
      assert.equal(await redirectOf(() => session.requireAdminPage(p)), `/admin/login?next=${encodeURIComponent(p)}`, p);
    }
    assert.equal(await redirectOf(() => session.requireAdminPage("/admin/payouts", { mfaGate: false })), null);

    // verified session: everywhere.
    currentCookie = await session.createAdminSession(X, {}, { mfaVerified: true });
    for (const p of ["/admin", "/admin/payouts", "/admin/security"]) assert.equal(await redirectOf(() => session.requireAdminPage(p)), null, p);
  } finally {
    delete process.env.ADMIN_REQUIRE_2FA;
    currentCookie = "";
  }
});

test("the administrator list is hidden from sessions that have not passed what they must", { skip }, async () => {
  process.env.ADMIN_REQUIRE_2FA = "true";
  try {
    // A cookie of an admin who has not enrolled (2FA required) sees the page, but not who the other admins are.
    currentCookie = await session.createAdminSession(Y);
    const hidden = textOf(await securityPage()).join("\n");
    for (const other of [emailX, emailQ, emailZ]) assert.ok(!hidden.includes(other), `${other} is not shown`);
    assert.ok(!/Administrators \(\d+\)/.test(hidden));
    assert.match(hidden, /shown after you have set up two-factor/);

    // A password-only session of an admin who HAS 2FA does not even get the page.
    currentCookie = await passwordOnlySession(X);
    assert.equal(await redirectOf(() => securityPage()), "/admin/login?next=%2Fadmin%2Fsecurity");

    // A verified session of an enrolled admin sees the list.
    currentCookie = await session.createAdminSession(X, {}, { mfaVerified: true });
    const shown = textOf(await securityPage()).join("\n");
    assert.match(shown, /Administrators \(\d+\)/);
    for (const other of [emailX, emailY, emailQ, emailZ]) assert.ok(shown.includes(other), `${other} is listed`);
  } finally {
    delete process.env.ADMIN_REQUIRE_2FA;
    currentCookie = "";
  }
});

test("requireAdminMfa(): the gate of every admin READ endpoint. ok passes; enroll and verify are denied; allowEnrollment admits enroll only", { skip }, async () => {
  type Outcome = "ok" | { status: number; mfaAction?: string };
  const call = async (opts?: { allowEnrollment?: boolean }): Promise<Outcome> => {
    const r = await session.requireAdminMfa(opts);
    if (!(r instanceof Response)) return "ok";
    const body = await r.json();
    return { status: r.status, mfaAction: body.mfaAction };
  };
  process.env.ADMIN_REQUIRE_2FA = "true";
  try {
    // Signed out: 401 whatever the option.
    currentCookie = "";
    assert.deepEqual(await call(), { status: 401, mfaAction: undefined });
    assert.deepEqual(await call({ allowEnrollment: true }), { status: 401, mfaAction: undefined });

    // "enroll": Y has no authenticator and 2FA is required. Only the two enrolling-admin endpoints pass allowEnrollment.
    currentCookie = await session.createAdminSession(Y);
    assert.deepEqual(await call(), { status: 403, mfaAction: "enroll" });
    assert.deepEqual(await call({}), { status: 403, mfaAction: "enroll" });
    assert.deepEqual(await call({ allowEnrollment: false }), { status: 403, mfaAction: "enroll" });
    assert.equal(await call({ allowEnrollment: true }), "ok");

    // "verify": X has 2FA, this session is password-only. Denied everywhere, enrolment option or not (it is not an enrolment case).
    currentCookie = await passwordOnlySession(X);
    assert.deepEqual(await call(), { status: 403, mfaAction: "verify" });
    assert.deepEqual(await call({ allowEnrollment: true }), { status: 403, mfaAction: "verify" });

    // "ok": a verified session of an enrolled admin passes both ways.
    currentCookie = await session.createAdminSession(X, {}, { mfaVerified: true });
    assert.equal(await call(), "ok");
    assert.equal(await call({ allowEnrollment: true }), "ok");
  } finally {
    delete process.env.ADMIN_REQUIRE_2FA;
    currentCookie = "";
  }
  // Without the requirement an admin with no authenticator is simply "ok" (development default), and requireAdminApi still lets
  // a password-only session of a 2FA admin through: that is exactly why the read endpoints use requireAdminMfa instead.
  currentCookie = await session.createAdminSession(Y);
  assert.equal(await call(), "ok");
  currentCookie = await passwordOnlySession(X);
  assert.ok(!((await session.requireAdminApi()) instanceof Response), "requireAdminApi does not stop a password-only session of a 2FA admin");
  assert.equal((await session.requireAdminMfa()) instanceof Response, true, "requireAdminMfa does");
  currentCookie = "";
});
