// Integration test of the real route handlers (needs DATABASE_URL, TOKEN_ENCRYPTION_KEY, APP_SECRET; skipped otherwise).
// Only `next/headers` is replaced, so the admin session cookie can be chosen per call; rate limits use the in-memory store.
// Covers: the two-step login routes, the 403 `mfaRequired` gate on every sensitive admin route, and the enrolment route.
import "dotenv/config";
import assert from "node:assert/strict";
import { after, before, mock, test } from "node:test";
import { hashPassword } from "../lib/auth/password";
import { prisma } from "../lib/db";

const skip = process.env.DATABASE_URL && process.env.TOKEN_ENCRYPTION_KEY && process.env.APP_SECRET ? false : "DATABASE_URL / TOKEN_ENCRYPTION_KEY / APP_SECRET not set";
const run = Date.now();
const PASSWORD = "correct-horse-battery-9";
const emailX = `routes-x-${run}@example.com`; // has two-factor
const emailY = `routes-y-${run}@example.com`; // does not (yet)
let X = "";
let Y = "";
let secretX = "";
let recoveryX: string[] = [];

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
  // X enrols through the library, a minute "in the past" so that codes for the real clock are fresh.
  const past = Date.now() - 60_000;
  secretX = (await mfa.startTotpEnrollment(X)).secret;
  const done = await mfa.confirmTotpEnrollment(X, totp.totpAt(secretX, past), null, past);
  assert.ok(done.ok);
  if (done.ok) recoveryX = done.recoveryCodes;
});

after(async () => {
  if (!skip && X) {
    await prisma.adminAuditLog.deleteMany({ where: { adminEmail: { in: [emailX, emailY] } } });
    // Rejected pending tokens are audited without a known admin (email "unknown").
    await prisma.adminAuditLog.deleteMany({ where: { adminEmail: "unknown", action: "admin.mfa_failed", createdAt: { gte: new Date(run - 1000) } } });
    await prisma.adminUser.deleteMany({ where: { id: { in: [X, Y] } } });
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
  const stale = await session.createAdminSession(X); // password only, although X has 2FA
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

    // Enrolment itself is open: set up, confirm with a wrong code, then with the right one.
    const setup = await securityRoute(json("/api/admin/security/2fa", { action: "setup" }));
    assert.equal(setup.status, 200);
    const { secret, uri } = await setup.json();
    assert.match(secret, /^[A-Z2-7]{32}$/);
    assert.match(uri, /^otpauth:\/\/totp\//);

    const badEnable = await securityRoute(json("/api/admin/security/2fa", { action: "enable", code: "000000" }));
    assert.equal(badEnable.status, 400);
    const stillBlocked = await sensitiveCalls()[0].run();
    assert.equal(stillBlocked.status, 403, "a failed confirmation does not unlock anything");

    const enable = await securityRoute(json("/api/admin/security/2fa", { action: "enable", code: totp.totpAt(secret, Date.now()) }));
    assert.equal(enable.status, 200);
    const { recoveryCodes } = await enable.json();
    assert.equal(recoveryCodes.length, 10);

    // The session that enrolled is now verified: the gate opens (the sensitive calls reach their handlers).
    for (const c of sensitiveCalls()) assert.equal((await c.run()).status, c.passes, c.name);
    const ctx = await session.resolveAdminSession(currentCookie);
    assert.equal(ctx?.mfaVerified, true);
    assert.equal(ctx?.totpEnabled, true);

    // Turning it off needs a valid code; the code that just enrolled is spent, a wrong one fails.
    const noCode = await securityRoute(json("/api/admin/security/2fa", { action: "disable", code: "000000" }));
    assert.equal(noCode.status, 400);
    const viaRecovery = await securityRoute(json("/api/admin/security/2fa", { action: "disable", code: recoveryCodes[0] }));
    assert.equal(viaRecovery.status, 200);
    assert.equal((await sensitiveCalls()[0].run()).status, 403, "required again once 2FA is off");

    const actions = (await prisma.adminAuditLog.findMany({ where: { adminEmail: emailY } })).map((a) => a.action);
    for (const expected of ["admin.2fa_setup_started", "admin.mfa_failed", "admin.2fa_enabled", "admin.2fa_disabled"]) {
      assert.ok(actions.includes(expected), `audited: ${expected}`);
    }
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
