// Integration test of influencer moderation (WP-A): suspend, reinstate and approve through GET/POST
// /api/admin/influencers/:id/status, and what a suspension does to the booking page, holds, checkout, request approvals and
// payouts (needs DATABASE_URL, TOKEN_ENCRYPTION_KEY, APP_SECRET; skipped otherwise).
//
// Only `next/headers` (the cookie a request carries) and the Razorpay order call are replaced. Email goes to a capturing sender,
// so nothing is ever sent. The point of the file:
//   - the gate is the console's: 401 signed out, 403 `enroll` / `verify`, 200 for a verified session; a denied POST changes nothing;
//   - the exact key sets are pinned and go through assertNoSecretKeys;
//   - a change and its audit row are one transaction (a failing audit insert leaves the account untouched), and a repeated or
//     concurrent click is a 409 with ONE audit row and ONE e-mail;
//   - a suspension takes the page offline for strangers (the owner sees a preview), refuses holds, checkout (even for a hold made
//     before), request approvals and payouts; reinstating makes every one of them work again; paid bookings are left alone;
//   - READINESS_BYPASS never lifts a suspension; "approve" only exists while READINESS_REQUIRED contains "approval".
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
const DAY = 86_400_000;
const emailX = `mod-x-${run}@example.com`; // administrator with two-factor
const emailY = `mod-y-${run}@example.com`; // administrator without; does the moderating
const slug = `mod-${run}`;
const reviewSlug = `modr-${run}`;
const thirdSlug = `modt-${run}`;
const influencerEmail = `mod-inf-${run}@example.com`;
const REASON = "Chargeback investigation";

// Settings the developer's .env may carry that change what these endpoints answer. Removed or fixed for the run, restored after.
const ENV_KEYS = [
  "ADMIN_REQUIRE_2FA",
  "PAYOUT_HOLD_DAYS",
  "PAYOUT_FOUR_EYES",
  "PAYOUT_FOUR_EYES_MIN_MINOR",
  "PLATFORM_FEE_BPS",
  "READINESS_BYPASS",
  "READINESS_REQUIRED",
  "RATE_LIMIT_STORE",
  "REDIS_URL",
  "MESSAGING_DRY_RUN",
  "APP_URL",
] as const;
const savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};
let envSaved = false;

const jar = new Map<string, string>();
type Answer = { status: number; body: Record<string, unknown>; headers: Headers };
type Ctx = { params: Promise<{ id: string }> };
let statusRoute: { GET: (req: Request, ctx: Ctx) => Promise<Response>; POST: (req: Request, ctx: Ctx) => Promise<Response> };
let listRoute: { GET: (req: Request) => Promise<Response> };
let holdRoute: { POST: (req: Request) => Promise<Response> };
let slotsRoute: { GET: (req: Request) => Promise<Response> };
let overviewRoute: { GET: () => Promise<Response> };
let onboardingRoute: { POST: (req: Request) => Promise<Response> };
let payoutRoute: { POST: (req: Request, ctx: Ctx) => Promise<Response> };
let selfServiceLib: typeof import("../lib/self-service");
let signingLib: typeof import("../lib/signing");
let manageViewLib: typeof import("../lib/views/booking-manage");
let payViewLib: typeof import("../lib/views/booking-pay");
let payoutViewLib: typeof import("../lib/views/admin-payouts");
let sessionLib: typeof import("../lib/admin/session");
let authLib: typeof import("../lib/auth/session");
let moderationLib: typeof import("../lib/admin/moderation");
let profileLib: typeof import("../lib/public-profile");
let holdsLib: typeof import("../lib/holds");
let checkoutLib: typeof import("../lib/checkout");
let approvalLib: typeof import("../lib/booking-approval");
let payoutsLib: typeof import("../lib/payouts");
let readinessLib: typeof import("../lib/readiness");
let X = "";
let Y = "";
let influencerId = "";
let reviewId = "";
let thirdId = "";
const thirdEmail = `mod-third-${run}@example.com`;
let ownerCookie = "";
let serviceId = "";
let approvalServiceId = "";
let heldBookingId = "";
let requestedBookingId = "";
let paidBookingId = "";
let paidPaymentId = "";
const sent: { to: { email: string; name?: string }; subject: string; html: string; text: string; tag?: string }[] = [];
let orderCalls = 0;

const adminCookie = (token: string) => ({ [sessionLib.adminCookieName()]: token });
const keys = (o: unknown) => Object.keys(o as object).sort();
const accountEmails = () => sent.filter((m) => m.tag === "account-status");

function set(cookies: Record<string, string>) {
  jar.clear();
  for (const [k, v] of Object.entries(cookies)) jar.set(k, v);
}
async function answer(res: Response): Promise<Answer> {
  return { status: res.status, body: (await res.json()) as Record<string, unknown>, headers: res.headers };
}
const post = (body: unknown, id = influencerId) =>
  statusRoute.POST(new Request(`http://localhost/api/admin/influencers/${id}/status`, { method: "POST", headers: { "content-type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body) }), {
    params: Promise.resolve({ id }),
  });
const get = (id = influencerId) => statusRoute.GET(new Request(`http://localhost/api/admin/influencers/${id}/status`), { params: Promise.resolve({ id }) });
const asAdmin = async (token: string, call: () => Promise<Response>): Promise<Answer> => {
  set(adminCookie(token));
  return answer(await call());
};
const list = (token: string, query: string) => asAdmin(token, () => listRoute.GET(new Request(`http://localhost/api/admin/influencers${query}`)));
const auditRows = (action?: string) => prisma.adminAuditLog.findMany({ where: { targetType: "influencer", targetId: influencerId, ...(action ? { action } : {}) } });
const dbRow = () => prisma.influencer.findUniqueOrThrow({ where: { id: influencerId } });

async function passwordOnlySession(adminId: string): Promise<string> {
  const token = randomToken();
  await prisma.adminSession.create({ data: { tokenHash: hashToken(token), adminId, expiresAt: new Date(Date.now() + 3_600_000) } });
  return token;
}

/** An ISO time on the hour, this far ahead. */
function hourIso(offsetMs: number): string {
  const d = new Date(Date.now() + offsetMs);
  d.setUTCMinutes(0, 0, 0);
  return d.toISOString();
}

function holdInput(svc: string, offsetMs: number, email: string, requestApproval = false) {
  const start = new Date(Date.now() + offsetMs);
  start.setUTCMinutes(0, 0, 0);
  return {
    serviceId: svc,
    startTime: start,
    endTime: new Date(start.getTime() + 30 * 60_000),
    capacity: 1,
    customerName: "Moderation Customer",
    customerEmail: email,
    whatsappE164: "+919876543210",
    whatsappOptIn: true,
    requestApproval,
  };
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
  // "Development" readiness: no connection is required (a bare test account can be live), but a suspension is never bypassed.
  process.env.READINESS_BYPASS = "true";

  mock.module("next/headers", {
    namedExports: {
      cookies: async () => ({ get: (name: string) => (jar.has(name) ? { name, value: jar.get(name) } : undefined) }),
      headers: async () => new Headers(),
    },
  });
  // Razorpay is never called: the order is made by this stand-in, which counts how often checkout got as far as creating one.
  const realPayments = await import("../lib/payments");
  mock.module("@/lib/payments", {
    namedExports: {
      ...realPayments,
      razorpayKeyId: () => "rzp_test_moderation",
      createOrder: async (input: { amountMinor: number; currency: string }) => {
        orderCalls += 1;
        return { id: `order_mod_${run}_${orderCalls}`, amount: input.amountMinor, currency: input.currency, status: "created" };
      },
    },
  });

  sessionLib = await import("../lib/admin/session");
  authLib = await import("../lib/auth/session");
  moderationLib = await import("../lib/admin/moderation");
  profileLib = await import("../lib/public-profile");
  holdsLib = await import("../lib/holds");
  checkoutLib = await import("../lib/checkout");
  approvalLib = await import("../lib/booking-approval");
  payoutsLib = await import("../lib/payouts");
  readinessLib = await import("../lib/readiness");
  const email = await import("../lib/email");
  email.setEmailSender(async (m) => {
    sent.push(m);
    return { providerMessageId: null };
  });
  statusRoute = await import("../app/api/admin/influencers/[id]/status/route");
  listRoute = await import("../app/api/admin/influencers/route");
  holdRoute = await import("../app/api/bookings/hold/route");
  slotsRoute = await import("../app/api/slots/route");
  overviewRoute = await import("../app/api/dashboard/overview/route");
  onboardingRoute = await import("../app/api/dashboard/onboarding/route");
  payoutRoute = await import("../app/api/admin/payouts/[id]/route");
  selfServiceLib = await import("../lib/self-service");
  signingLib = await import("../lib/signing");
  manageViewLib = await import("../lib/views/booking-manage");
  payViewLib = await import("../lib/views/booking-pay");
  payoutViewLib = await import("../lib/views/admin-payouts");
  const mfa = await import("../lib/admin/mfa");
  const totp = await import("../lib/admin/totp");

  const hash = await hashPassword(PASSWORD);
  X = (await prisma.adminUser.create({ data: { email: emailX, name: "Mod Admin X", passwordHash: hash } })).id;
  Y = (await prisma.adminUser.create({ data: { email: emailY, name: "Mod Admin Y", passwordHash: hash } })).id;
  const past = Date.now() - 60_000;
  const secret = (await mfa.startTotpEnrollment(X)).secret;
  assert.ok((await mfa.confirmTotpEnrollment(X, totp.totpAt(secret, past), null, past)).ok);

  // The fixture: a finished, e-mail-verified influencer (no availability rules, so the hold route can never create a booking by
  // accident), a 1:1 service, a service that needs approval, verified payout details, and bookings in each state.
  influencerId = (await prisma.influencer.create({ data: { slug, name: `Mod Fixture ${run}`, email: influencerEmail, onboardedAt: new Date() } })).id;
  const user = await prisma.user.create({
    data: { email: `mod-user-${run}@example.com`, passwordHash: "not-a-real-hash", emailVerifiedAt: new Date(), termsAcceptedAt: new Date(), influencerId },
  });
  ownerCookie = await authLib.createSession(user.id);
  reviewId = (await prisma.influencer.create({ data: { slug: reviewSlug, name: `Mod Review ${run}`, email: `mod-review-${run}@example.com`, onboardedAt: new Date() } })).id;

  thirdId = (await prisma.influencer.create({ data: { slug: thirdSlug, name: `Mod Third ${run}`, email: thirdEmail, onboardedAt: new Date() } })).id;

  serviceId = (await prisma.service.create({ data: { influencerId, title: "Mod 1:1", durationMin: 30, priceMinor: 1000 } })).id;
  approvalServiceId = (await prisma.service.create({ data: { influencerId, title: "Mod reviewed", durationMin: 30, priceMinor: 2000, requiresApproval: true } })).id;
  await prisma.payoutAccount.create({
    data: { influencerId, accountHolderName: "Mod Holder", bankName: "HDFC Bank", ifsc: "HDFC0001234", accountNumberEnc: "x", accountNumberMasked: "XXXXXXXX9012", status: "VERIFIED" },
  });

  heldBookingId = (await holdsLib.createHold(holdInput(serviceId, 5 * DAY, `held-${run}@example.com`))).id;
  requestedBookingId = (await holdsLib.createHold(holdInput(approvalServiceId, 6 * DAY, `req-${run}@example.com`, true))).id;

  // A paid upcoming session (counted in the impact numbers, never touched) and an old reconciled payment that is payable.
  const upcoming = new Date(Date.now() + 7 * DAY);
  const upSession = await prisma.session.create({ data: { serviceId, startTime: upcoming, endTime: new Date(upcoming.getTime() + 30 * 60_000) } });
  paidBookingId = (
    await prisma.booking.create({ data: { sessionId: upSession.id, status: "SCHEDULED", customerName: "Paid Customer", customerEmail: `paid-${run}@example.com`, whatsappE164: "+919876543210" } })
  ).id;
  paidPaymentId = (
    await prisma.payment.create({
      data: { bookingId: paidBookingId, providerOrderId: `order_modpaid_${run}`, providerPaymentId: `pay_modpaid_${run}`, amountMinor: 1000, currency: "INR", status: "CAPTURED", reconciledAt: new Date() },
    })
  ).id;
  const old = new Date(Date.now() - 60 * DAY);
  const oldSession = await prisma.session.create({ data: { serviceId, startTime: old, endTime: new Date(old.getTime() + 30 * 60_000) } });
  const oldBooking = await prisma.booking.create({ data: { sessionId: oldSession.id, status: "SCHEDULED", customerName: "Old Customer", customerEmail: `old-${run}@example.com`, whatsappE164: "+919876543210" } });
  await prisma.payment.create({
    data: { bookingId: oldBooking.id, providerOrderId: `order_modold_${run}`, providerPaymentId: `pay_modold_${run}`, amountMinor: 5000, currency: "INR", status: "CAPTURED", reconciledAt: new Date() },
  });
});

after(async () => {
  // Every step on its own, so one failure (a pool timeout on a slow network) cannot leave the rest behind; the pool is always closed.
  try {
    if (!skip) {
      const step = async (what: string, fn: () => Promise<unknown>) => {
        try {
          await fn();
        } catch (e) {
          console.error(`[moderation] cleanup step failed (${what}):`, e instanceof Error ? e.message : e);
        }
      };
      // Everything this file creates has a slug that starts with "mod" and ends with this run's timestamp.
      const ids = (await prisma.influencer.findMany({ where: { slug: { startsWith: "mod", endsWith: run } }, select: { id: true } }).catch(() => [])).map((i) => i.id);
      if (ids.length) {
        await step("payments", () => prisma.payment.updateMany({ where: { booking: { session: { service: { influencerId: { in: ids } } } } }, data: { payoutId: null } }));
        await step("payouts", () => prisma.payout.deleteMany({ where: { influencerId: { in: ids } } }));
        await step("audit rows", () => prisma.adminAuditLog.deleteMany({ where: { targetType: "influencer", targetId: { in: ids } } }));
        await step("influencers", () => prisma.influencer.deleteMany({ where: { id: { in: ids } } }));
      }
      await step("audit rows by admin", () => prisma.adminAuditLog.deleteMany({ where: { adminEmail: { in: [emailX, emailY] } } }));
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

test("the status endpoints are gated like the console: 401 signed out, 403 enroll, 403 verify, 200 verified; a denied POST changes nothing", { skip }, async () => {
  const suspend = { action: "suspend", reason: "Should never be applied" };
  const calls = [
    ["GET", () => get()],
    ["POST", () => post(suspend)],
  ] as const;
  for (const [name, call] of calls) {
    set({});
    assert.equal((await answer(await call())).status, 401, `${name}: no cookie`);
    set(adminCookie("garbage"));
    assert.equal((await answer(await call())).status, 401, `${name}: garbage cookie`);
  }

  const plainY = await sessionLib.createAdminSession(Y);
  const staleX = await passwordOnlySession(X);
  const verifiedX = await sessionLib.createAdminSession(X, {}, { mfaVerified: true });

  process.env.ADMIN_REQUIRE_2FA = "true";
  try {
    for (const [name, call] of calls) {
      const enroll = await asAdmin(plainY, call);
      assert.equal(enroll.status, 403, `${name}: enroll`);
      assert.deepEqual(keys(enroll.body), ["error", "mfaAction", "mfaRequired"], `${name}: nothing of the console in a denial`);
      assert.equal(enroll.body.mfaAction, "enroll");
      const verify = await asAdmin(staleX, call);
      assert.equal(verify.status, 403, `${name}: verify`);
      assert.equal(verify.body.mfaAction, "verify");
    }
    assert.equal((await asAdmin(verifiedX, () => get())).status, 200, "GET: verified session");
    // past the gate: "reinstate" on an account that is not suspended is a 409, which proves the session was let in
    assert.equal((await asAdmin(verifiedX, () => post({ action: "reinstate" }))).status, 409, "POST: verified session");
  } finally {
    delete process.env.ADMIN_REQUIRE_2FA;
  }
  // Without the requirement an administrator without 2FA is fine; one WITH 2FA and a password-only session is still refused.
  assert.equal((await asAdmin(plainY, () => get())).status, 200);
  assert.equal((await asAdmin(staleX, () => get())).status, 403);

  const row = await dbRow();
  assert.equal(row.suspendedAt, null, "no denied request suspended anything");
  assert.equal((await auditRows()).length, 0);
  assert.equal(accountEmails().length, 0);
});

test("unknown and malformed ids are a 404 for GET and POST (only for a session that may use the console)", { skip }, async () => {
  const token = await sessionLib.createAdminSession(Y);
  for (const id of ["no-such-influencer", "x".repeat(65), "bad id", "a%00b"]) {
    const g = await asAdmin(token, () => get(id));
    assert.equal(g.status, 404, `GET ${id}`);
    assert.deepEqual(g.body, { error: "Influencer not found" });
    assert.equal((await asAdmin(token, () => post({ action: "reinstate" }, id))).status, 404, `POST ${id}`);
  }
  const unknown = await asAdmin(token, () => post({ action: "suspend", reason: "Looks valid enough" }, "cl00000000000000000000000"));
  assert.equal(unknown.status, 404);
  assert.equal(accountEmails().length, 0);
});

test("GET returns the hand-picked fields only", { skip }, async () => {
  const token = await sessionLib.createAdminSession(Y);
  const res = await asAdmin(token, () => get());
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("cache-control"), "private, no-store");
  assert.equal(res.headers.get("access-control-allow-origin"), null);
  assert.deepEqual(keys(res.body), ["approval", "emailEnabled", "impact", "status", "suspension"]);
  assert.equal(res.body.status, "active");
  assert.equal(res.body.suspension, null);
  assert.deepEqual(res.body.approval, { required: false, at: null, byEmail: null });
  assert.deepEqual(res.body.impact, { upcomingPaidBookings: 1, pendingPayouts: 0 });
  assertNoSecretKeys(res.body);
  const text = JSON.stringify(res.body);
  for (const secret of [influencerEmail, "XXXXXXXX9012", ownerCookie]) assert.ok(!text.includes(secret), "no influencer detail in the moderation panel's data");
});

test("input is validated: reason 5 to 500 characters, a known action, a body; nothing changes on a 400", { skip }, async () => {
  const token = await sessionLib.createAdminSession(Y);
  const bad: [string, unknown][] = [
    ["no body", ""],
    ["not json", "not json"],
    ["unknown action", { action: "delete" }],
    ["no action", { reason: REASON }],
    ["suspend without a reason", { action: "suspend" }],
    ["reason of 4 characters", { action: "suspend", reason: "abcd" }],
    ["reason of spaces only", { action: "suspend", reason: "          " }],
    ["reason of 501 characters", { action: "suspend", reason: "x".repeat(501) }],
    ["reason that is not a string", { action: "suspend", reason: 12345 }],
    ["NUL in the reason", { action: "suspend", reason: "abc\u0000def ghi" }],
    ["array body", [{ action: "reinstate" }]],
  ];
  for (const [name, body] of bad) {
    const res = await asAdmin(token, () => post(body));
    assert.equal(res.status, 400, name);
    assert.equal(typeof res.body.error, "string", name);
  }
  assert.equal((await dbRow()).suspendedAt, null);
  assert.equal((await auditRows()).length, 0);
  assert.equal(accountEmails().length, 0);
});

test("a change and its audit entry are one transaction: a failing audit insert leaves the account untouched", { skip }, async () => {
  // adminId is a foreign key: an administrator that does not exist makes the audit insert fail.
  await assert.rejects(moderationLib.moderateInfluencer({ adminId: "no-such-admin", email: emailY }, influencerId, { action: "suspend", reason: "Atomic check reason" }, null));
  const row = await dbRow();
  assert.equal(row.suspendedAt, null);
  assert.equal(row.suspendedReason, null);
  assert.equal(row.suspendedByEmail, null);
  assert.equal((await auditRows()).length, 0);
  assert.equal(accountEmails().length, 0, "no e-mail for a change that did not happen");
});

test("suspend: 200 with the new view, one audit row, one e-mail with the reason; a second suspend is a 409", { skip }, async () => {
  const token = await sessionLib.createAdminSession(Y);
  const res = await asAdmin(token, () => post({ action: "suspend", reason: `  ${REASON}  ` }));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("cache-control"), "private, no-store");
  assert.deepEqual(keys(res.body), ["emailed", "ok", "view"]);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.emailed, true, "the e-mail went out, so the console may say so");
  const view = res.body.view as Record<string, unknown>;
  assert.deepEqual(keys(view), ["approval", "emailEnabled", "impact", "status", "suspension"]);
  assert.equal(view.status, "suspended");
  const suspension = view.suspension as Record<string, unknown>;
  assert.deepEqual(keys(suspension), ["at", "byEmail", "reason"]);
  assert.equal(suspension.reason, REASON, "trimmed");
  assert.equal(suspension.byEmail, emailY);
  assert.deepEqual(view.impact, { upcomingPaidBookings: 1, pendingPayouts: 0 }, "the paid session stays booked");
  assertNoSecretKeys(res.body);

  const row = await dbRow();
  assert.ok(row.suspendedAt);
  assert.equal(row.suspendedReason, REASON);
  assert.equal(row.suspendedByEmail, emailY);

  const audit = await auditRows("influencer.suspended");
  assert.equal(audit.length, 1);
  assert.equal(audit[0].adminId, Y);
  assert.equal(audit[0].adminEmail, emailY);
  assert.deepEqual(audit[0].detail, { reason: REASON });

  const mails = accountEmails();
  assert.equal(mails.length, 1);
  assert.equal(mails[0].to.email, influencerEmail);
  assert.match(mails[0].subject, /suspended/i);
  assert.ok(mails[0].text.includes(REASON) && mails[0].html.includes(REASON), "the reason is in the e-mail");
  assert.match(mails[0].text, /support@|@/, "and where to turn");

  const again = await asAdmin(token, () => post({ action: "suspend", reason: "A different reason" }));
  assert.equal(again.status, 409);
  assert.deepEqual(keys(again.body), ["error"]);
  assert.equal((await auditRows("influencer.suspended")).length, 1, "a repeated click adds no audit row");
  assert.equal(accountEmails().length, 1, "and sends no second e-mail");
  assert.equal((await dbRow()).suspendedReason, REASON, "and keeps the first reason");
});

test("while suspended: the page is offline for strangers (the owner sees a preview), holds, checkout, approvals and payouts are refused, paid bookings are untouched", { skip }, async () => {
  const day = new Date(Date.now() + 4 * DAY).toISOString().slice(0, 10);
  const holdBody = { serviceId, startTime: hourIso(3 * DAY), name: "Stranger", email: `stranger-${run}@example.com`, whatsapp: "+919876543210", whatsappOptIn: true };
  const postHold = async () => {
    set({});
    return answer(await holdRoute.POST(new Request("http://localhost/api/bookings/hold", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(holdBody) })));
  };
  const slots = async (cookies: Record<string, string>) => {
    set(cookies);
    return answer(await slotsRoute.GET(new Request(`http://localhost/api/slots?serviceId=${serviceId}&date=${day}`)));
  };

  // The public page.
  set({});
  assert.equal(await profileLib.loadPublicProfile(slug), null, "a stranger gets a 404");
  set({ [authLib.sessionCookieName()]: ownerCookie });
  const preview = await profileLib.loadPublicProfile(slug);
  assert.equal(preview?.preview, true);
  assert.ok(preview?.blockers.includes("Account in good standing"), "the owner's preview names the blocker");

  // Slots and holds.
  assert.equal((await slots({})).status, 404, "slot listing for strangers");
  assert.equal((await slots({ [authLib.sessionCookieName()]: ownerCookie })).status, 200, "the owner can still load their own slots");
  const refusedHold = await postHold();
  assert.equal(refusedHold.status, 404, `a new hold is refused ${JSON.stringify(refusedHold.body)}`);

  // Checkout for a hold made BEFORE the suspension: no order, no payment row.
  const calls = orderCalls;
  await assert.rejects(checkoutLib.startCheckout(heldBookingId), (e: unknown) => e instanceof checkoutLib.NotPayableError && /can no longer be paid\. You have not been charged\./.test(e.message));
  assert.equal(orderCalls, calls, "no Razorpay order was created");
  assert.equal(await prisma.payment.count({ where: { bookingId: heldBookingId } }), 0, "and no Payment row");
  assert.equal((await prisma.booking.findUniqueOrThrow({ where: { id: heldBookingId } })).status, "HELD");

  // Approving a request; declining stays allowed.
  await assert.rejects(approvalLib.approveRequest(influencerId, requestedBookingId), (e: unknown) => e instanceof approvalLib.ApprovalError && e.status === 409 && /suspended/.test(e.message));
  assert.equal((await prisma.booking.findUniqueOrThrow({ where: { id: requestedBookingId } })).status, "REQUESTED");
  const toDecline = await holdsLib.createHold(holdInput(approvalServiceId, 8 * DAY, `decline-${run}@example.com`, true));
  await approvalLib.declineRequest(influencerId, toDecline.id, "Not available");
  assert.equal((await prisma.booking.findUniqueOrThrow({ where: { id: toDecline.id } })).status, "CANCELLED", "declining is still allowed");

  // A new payout.
  await assert.rejects(payoutsLib.createPayout(influencerId, "INR", emailY), (e: unknown) => e instanceof payoutsLib.PayoutError && e.status === 409 && /suspended/.test(e.message));
  assert.equal(await prisma.payout.count({ where: { influencerId } }), 0);

  // The paid booking is untouched.
  assert.equal((await prisma.booking.findUniqueOrThrow({ where: { id: paidBookingId } })).status, "SCHEDULED");
  assert.equal((await prisma.payment.findUniqueOrThrow({ where: { id: paidPaymentId } })).status, "CAPTURED");

  // The customer's manage page says rescheduling is unavailable (instead of an empty calendar); cancelling still works.
  const manageToken = signingLib.signToken(selfServiceLib.SELF_SERVICE_PURPOSE, { b: paidBookingId }, 3600);
  const manage = await manageViewLib.loadManageView(manageToken);
  assert.equal(manage.state, "ok");
  if (manage.state === "ok") {
    assert.equal(manage.booking.hostSuspended, true);
    assert.equal(manage.booking.canReschedule, false);
    assert.equal(manage.booking.canManage, true, "cancelling is still offered");
    assert.ok(!JSON.stringify(manage).includes(REASON) && !JSON.stringify(manage).includes(emailY), "the customer learns nothing about why");
  }
  // The pay page of the hold made before the suspension has no Pay button.
  const payToken = signingLib.signToken(selfServiceLib.BOOKING_PAY_PURPOSE, { b: heldBookingId }, 3600);
  const pay = await payViewLib.loadPayView(payToken);
  assert.deepEqual(pay, { state: "unavailable", hostName: `Mod Fixture ${run}` });

  // The influencer's own dashboard says why, with the reason and never who suspended them.
  set({ [authLib.sessionCookieName()]: ownerCookie });
  const overview = await answer(await overviewRoute.GET());
  assert.equal(overview.status, 200);
  assert.equal(overview.body.live, false);
  const items = (overview.body.readiness as { items: { key: string; label: string; state: string; required: boolean; detail: string; href: string }[] }).items;
  const account = items.find((i) => i.key === "account");
  assert.ok(account, "the go-live checklist has the account item");
  assert.equal(account.label, "Account in good standing");
  assert.equal(account.state, "attention");
  assert.equal(account.required, true);
  assert.ok(account.detail.includes(REASON) && account.detail.startsWith("Suspended by the platform"));
  assert.ok(!JSON.stringify(overview.body).includes(emailY), "the influencer never sees who suspended them");
  assertNoSecretKeys(overview.body);

  // READINESS_BYPASS=true is set for this whole file: the page was still offline above. The checklist agrees.
  const readiness = await readinessLib.loadReadiness(influencerId, true);
  assert.ok(readiness.blockers.some((b) => b.key === "account"));
});

test("the Influencers list filters by status and counts the moderation tabs", { skip }, async () => {
  const token = await sessionLib.createAdminSession(Y);
  const q = `&q=${encodeURIComponent(slug)}`;
  const suspended = await list(token, `?status=suspended${q}`);
  assert.equal(suspended.status, 200);
  assert.deepEqual(keys(suspended.body), ["counts", "page", "pageCount", "rows", "status", "total"]);
  assert.equal(suspended.body.status, "suspended");
  const rows = suspended.body.rows as Record<string, unknown>[];
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, influencerId);
  assert.equal(rows[0].accountStatus, "suspended");
  assert.equal(rows[0].live, false);
  assert.ok((rows[0].blockers as string[]).includes("Account in good standing"));
  assert.deepEqual(keys(suspended.body.counts), ["awaitingApproval", "suspended"]);
  assert.ok((suspended.body.counts as { suspended: number }).suspended >= 1);
  assertNoSecretKeys(suspended.body);

  assert.equal((await list(token, `?status=live${q}`)).body.total, 0, "not live");
  assert.equal((await list(token, `?status=not-live${q}`)).body.total, 1);
  assert.equal((await list(token, `?status=awaiting-approval${q}`)).body.total, 0, "the gate is off: nobody awaits approval");
  const all = await list(token, `?status=bogus${q}`);
  assert.equal(all.body.status, "all", "an unknown status means all");
  assert.equal(all.body.total, 1);
  assert.equal((await list(token, `?${q.slice(1)}`)).body.status, "all");
  const noMatch = await list(token, `?status=suspended&q=${encodeURIComponent(`zzz-nobody-${run}`)}`);
  assert.deepEqual(noMatch.body.rows, []);
});

test("reinstate: concurrent clicks give one 200 and one 409, one audit row and one e-mail; then everything works again", { skip }, async () => {
  const token = await sessionLib.createAdminSession(Y);
  sent.length = 0;
  set(adminCookie(token));
  const both = await Promise.all([post({ action: "reinstate" }), post({ action: "reinstate" })]);
  assert.deepEqual(both.map((r) => r.status).sort(), [200, 409]);
  const ok = await answer(both.find((r) => r.status === 200)!);
  assert.deepEqual(keys(ok.body), ["emailed", "ok", "view"]);
  assert.equal(ok.body.emailed, true);
  assert.equal((ok.body.view as { status: string }).status, "active");
  assert.equal((ok.body.view as { suspension: unknown }).suspension, null);
  assert.equal((await auditRows("influencer.reinstated")).length, 1);
  const mails = accountEmails();
  assert.equal(mails.length, 1);
  assert.match(mails[0].subject, /reinstated/i);
  assert.match(mails[0].text, /live again/, "the gate is off: reinstating does put the page back online");
  assert.doesNotMatch(mails[0].text, /still offline/);
  const row = await dbRow();
  assert.deepEqual([row.suspendedAt, row.suspendedReason, row.suspendedByEmail], [null, null, null]);
  const third = await asAdmin(token, () => post({ action: "reinstate" }));
  assert.equal(third.status, 409);
  assert.equal((await auditRows("influencer.reinstated")).length, 1);

  // The page is live again.
  set({});
  const profile = await profileLib.loadPublicProfile(slug);
  assert.equal(profile?.preview, false, "strangers see the page");
  const day = new Date(Date.now() + 4 * DAY).toISOString().slice(0, 10);
  assert.equal((await answer(await slotsRoute.GET(new Request(`http://localhost/api/slots?serviceId=${serviceId}&date=${day}`)))).status, 200);
  const hold = await answer(
    await holdRoute.POST(
      new Request("http://localhost/api/bookings/hold", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ serviceId, startTime: hourIso(3 * DAY), name: "Stranger", email: `stranger2-${run}@example.com`, whatsapp: "+919876543210", whatsappOptIn: true }),
      }),
    ),
  );
  assert.equal(hold.status, 409, "past the service lookup: this time is not one of the (empty) availability rules");

  // The hold that was refused before can be paid now: one order, one payment of the service's price.
  const before = orderCalls;
  const checkout = await checkoutLib.startCheckout(heldBookingId);
  assert.equal(orderCalls, before + 1);
  assert.equal(checkout.amountMinor, 1000);
  assert.equal(await prisma.payment.count({ where: { bookingId: heldBookingId } }), 1);

  // The customer-facing pages are back to normal.
  const manageToken = signingLib.signToken(selfServiceLib.SELF_SERVICE_PURPOSE, { b: paidBookingId }, 3600);
  const manage = await manageViewLib.loadManageView(manageToken);
  assert.ok(manage.state === "ok" && manage.booking.canReschedule === true && manage.booking.hostSuspended === false);
  const pay = await payViewLib.loadPayView(signingLib.signToken(selfServiceLib.BOOKING_PAY_PURPOSE, { b: heldBookingId }, 3600));
  assert.equal(pay.state, "payable");

  // The request can be approved.
  const approved = await approvalLib.approveRequest(influencerId, requestedBookingId);
  assert.ok(approved.payBy instanceof Date);
  assert.equal((await prisma.booking.findUniqueOrThrow({ where: { id: requestedBookingId } })).status, "HELD");

  // A payout can be created.
  const payout = await payoutsLib.createPayout(influencerId, "INR", emailY);
  assert.equal(payout.status, "PENDING");
  assert.equal(payout.paymentCount, 1);
  const status = await asAdmin(token, () => get());
  assert.deepEqual((status.body as { impact: unknown }).impact, { upcomingPaidBookings: 1, pendingPayouts: 1 });
});

test("checkout waits for a suspension that is already in flight, then refuses (the host row is share-locked)", { skip }, async () => {
  const sleep = (ms: number) => new Promise<"waiting">((resolve) => setTimeout(() => resolve("waiting"), ms));
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  let updated!: () => void;
  const updatedFirst = new Promise<void>((resolve) => (updated = resolve));
  // A suspension that has changed the host row but not committed yet. Without the share lock, checkout would read the old row, see
  // "not suspended" and go on to create the order.
  const suspender = prisma.$transaction(
    async (tx) => {
      await tx.influencer.update({ where: { id: influencerId }, data: { suspendedAt: new Date(), suspendedReason: "Race check reason", suspendedByEmail: emailY } });
      updated();
      await gate;
    },
    { timeout: 60_000 },
  );
  await updatedFirst;
  const calls = orderCalls;
  const outcome = checkoutLib.startCheckout(heldBookingId).then(
    () => "paid" as const,
    (e: unknown) => e,
  );
  assert.equal(await Promise.race([outcome, sleep(2500)]), "waiting", "checkout is held back by the suspension in flight");
  release();
  await suspender;
  const result = await outcome;
  assert.ok(result instanceof checkoutLib.NotPayableError, `checkout refused once the suspension committed (got ${String(result)})`);
  assert.equal(orderCalls, calls, "no order was created");
  await prisma.influencer.update({ where: { id: influencerId }, data: { suspendedAt: null, suspendedReason: null, suspendedByEmail: null } });
});

test("approveRequest's conditional update refuses a suspension that landed after the up-front check", { skip }, async () => {
  const request = await holdsLib.createHold(holdInput(approvalServiceId, 9 * DAY, `race-${run}@example.com`, true));
  await prisma.influencer.update({ where: { id: influencerId }, data: { suspendedAt: new Date(), suspendedReason: "Race check reason", suspendedByEmail: emailY } });
  // Simulates the race: the check at the top of approveRequest still sees "not suspended" (the suspension commits just after it).
  // (The model delegates answer through a Proxy, so the delegate is wrapped instead of patching one method.)
  const realDelegate = prisma.influencer;
  let checks = 0;
  const stand = (value: unknown) => Object.defineProperty(prisma, "influencer", { value, configurable: true, writable: true });
  stand(
    new Proxy(realDelegate, {
      get: (target, key) => (key === "findUnique" ? async () => (checks++, { suspendedAt: null }) : Reflect.get(target, key)),
    }),
  );
  try {
    await assert.rejects(
      approvalLib.approveRequest(influencerId, request.id),
      (e: unknown) => e instanceof approvalLib.ApprovalError && e.status === 409 && /changed while you were approving/.test(e.message),
      "the update itself says no, whatever the check saw",
    );
    assert.equal(checks, 1, "the stand-in answered the check");
  } finally {
    stand(realDelegate);
    await prisma.influencer.update({ where: { id: influencerId }, data: { suspendedAt: null, suspendedReason: null, suspendedByEmail: null } });
  }
  assert.equal((await prisma.booking.findUniqueOrThrow({ where: { id: request.id } })).status, "REQUESTED", "the request was not turned into a payable hold");
});

test("payouts of a suspended influencer: approve and mark-paid need an explicit, audited 'pay anyway'; cancel stays allowed; not suspended is unchanged", { skip }, async () => {
  const tokenY = await sessionLib.createAdminSession(Y);
  const tokenX = await sessionLib.createAdminSession(X, {}, { mfaVerified: true });
  const act = (token: string, id: string, body: unknown) =>
    asAdmin(token, () => payoutRoute.POST(new Request(`http://localhost/api/admin/payouts/${id}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }), { params: Promise.resolve({ id }) }));
  const audit = (id: string, action: string) => prisma.adminAuditLog.findMany({ where: { targetType: "payout", targetId: id, action } });
  const P = await prisma.payout.findFirstOrThrow({ where: { influencerId, status: "PENDING" }, orderBy: { createdAt: "desc" } });
  const OVERRIDE = "Paying an old, finished session";

  // Not suspended: nothing changes, and a stray acknowledgement is neither needed nor recorded.
  const plain = await act(tokenX, P.id, { action: "approve", acknowledgeSuspended: true, suspendedReason: "Not needed here" });
  assert.equal(plain.status, 200);
  const plainAudit = await audit(P.id, "payout.approved");
  assert.equal(plainAudit.length, 1);
  assert.ok(!JSON.stringify(plainAudit[0].detail).includes("suspendedOverride"), "no override is recorded for an influencer in good standing");

  await moderationLib.moderateInfluencer({ adminId: Y, email: emailY }, influencerId, { action: "suspend", reason: REASON }, null);

  // The payout list says so.
  const listing = await payoutViewLib.loadAdminPayoutsView({ status: "PENDING" }, emailX);
  assert.equal(listing.rows.find((r) => r.influencer.id === influencerId)?.influencer.suspended, true);

  // Mark as paid: refused without the acknowledgement, with a code the console reacts to; 400 without a reason.
  const reference = `UTRMOD${run}`.slice(0, 40);
  const refused = await act(tokenY, P.id, { action: "paid", reference });
  assert.equal(refused.status, 409);
  assert.deepEqual(keys(refused.body), ["code", "error"]);
  assert.equal(refused.body.code, "influencer-suspended");
  assert.equal((await prisma.payout.findUniqueOrThrow({ where: { id: P.id } })).status, "PENDING");
  assert.equal((await audit(P.id, "payout.paid")).length, 0);
  assert.equal((await act(tokenY, P.id, { action: "paid", reference, acknowledgeSuspended: true })).status, 400, "the acknowledgement needs a reason");
  assert.equal((await act(tokenY, P.id, { action: "paid", reference, acknowledgeSuspended: true, suspendedReason: "no" })).status, 400, "and a real one");
  assert.equal((await prisma.payout.findUniqueOrThrow({ where: { id: P.id } })).status, "PENDING");
  const paid = await act(tokenY, P.id, { action: "paid", reference, acknowledgeSuspended: true, suspendedReason: OVERRIDE });
  assert.equal(paid.status, 200);
  assert.equal((await prisma.payout.findUniqueOrThrow({ where: { id: P.id } })).status, "PAID");
  const paidAudit = await audit(P.id, "payout.paid");
  assert.equal(paidAudit.length, 1);
  assert.equal((paidAudit[0].detail as { suspendedOverride?: string }).suspendedOverride, OVERRIDE, "the override and its reason are in the audit entry");

  // Approve: the same rule (another administrator, as four-eyes requires).
  const P2 = await prisma.payout.create({
    data: { influencerId, currency: "INR", grossMinor: 1000, refundsMinor: 0, feeBps: 0, feeMinor: 0, netMinor: 1000, paymentCount: 0, destination: "UPI mod", createdByEmail: emailY },
  });
  const refusedApprove = await act(tokenX, P2.id, { action: "approve" });
  assert.equal(refusedApprove.status, 409);
  assert.equal(refusedApprove.body.code, "influencer-suspended");
  assert.equal((await prisma.payout.findUniqueOrThrow({ where: { id: P2.id } })).approvedAt, null);
  const approved = await act(tokenX, P2.id, { action: "approve", acknowledgeSuspended: true, suspendedReason: OVERRIDE });
  assert.equal(approved.status, 200);
  const approvedAudit = await audit(P2.id, "payout.approved");
  assert.equal(approvedAudit.length, 1);
  assert.equal((approvedAudit[0].detail as { suspendedOverride?: string }).suspendedOverride, OVERRIDE);

  // Cancelling returns the money to the pool and is always allowed.
  assert.equal((await act(tokenY, P2.id, { action: "cancel", note: "Not needed" })).status, 200);

  await moderationLib.moderateInfluencer({ adminId: Y, email: emailY }, influencerId, { action: "reinstate" }, null);
});

test("approving works in advance (gate off) and with the gate on; a suspended account is not e-mailed; the reinstate wording follows the gate", { skip }, async () => {
  const token = await sessionLib.createAdminSession(Y);
  const mailsTo = (email: string) => accountEmails().filter((m) => m.to.email === email);
  sent.length = 0;

  // Gate off (the file runs with READINESS_BYPASS=true, which also turns the approval gate off in development): approving in advance works.
  const off = await asAdmin(token, () => get());
  assert.deepEqual(off.body.approval, { required: false, at: null, byEmail: null });
  const pre = await asAdmin(token, () => post({ action: "approve" }, reviewId));
  assert.equal(pre.status, 200);
  assert.deepEqual(keys(pre.body), ["emailed", "ok", "view"]);
  assert.equal(pre.body.emailed, false, "nothing was sent: it matters only once the gate is on");
  const preView = pre.body.view as { status: string; approval: { required: boolean; at: string; byEmail: string } };
  assert.deepEqual([preView.status, preView.approval.required, preView.approval.byEmail], ["active", false, emailY]);
  assert.ok(preView.approval.at);
  assert.equal((await prisma.adminAuditLog.findMany({ where: { targetType: "influencer", targetId: reviewId, action: "influencer.approved" } })).length, 1);
  assert.equal(accountEmails().length, 0);
  const preAgain = await asAdmin(token, () => post({ action: "approve" }, reviewId));
  assert.equal(preAgain.status, 409);
  assert.match(String(preAgain.body.error), /already approved/i);

  // Gate on: READINESS_REQUIRED has "approval" and the bypass is off.
  process.env.READINESS_REQUIRED = "approval";
  process.env.READINESS_BYPASS = "false";
  try {
    const on = await asAdmin(token, () => get());
    assert.equal(on.body.status, "awaiting-approval");
    assert.deepEqual(on.body.approval, { required: true, at: null, byEmail: null });

    const q = `&q=${run}`;
    const awaiting = await list(token, `?status=awaiting-approval${q}`);
    const ids = (awaiting.body.rows as { id: string; accountStatus: string }[]).filter((r) => r.accountStatus === "awaiting-approval").map((r) => r.id);
    assert.ok(ids.includes(influencerId) && ids.includes(thirdId), "finished, unapproved pages await approval");
    assert.ok(!ids.includes(reviewId), "the page approved in advance does not");
    assert.ok((awaiting.body.counts as { awaitingApproval: number }).awaitingApproval >= 2);
    assert.equal(((await list(token, `?status=live&q=${encodeURIComponent(slug)}`)).body as { total: number }).total, 0, "an unapproved page is not live");
    assert.equal(((await list(token, `?status=live&q=${encodeURIComponent(reviewSlug)}`)).body as { total: number }).total, 1, "the page approved in advance stays live");

    // A suspension outranks "awaiting approval"; approving a suspended account is allowed but announces nothing.
    await moderationLib.moderateInfluencer({ adminId: Y, email: emailY }, thirdId, { action: "suspend", reason: "Check order of statuses" }, null);
    const thirdRow = (await list(token, `?q=${encodeURIComponent(thirdSlug)}`)).body.rows as { accountStatus: string }[];
    assert.equal(thirdRow[0].accountStatus, "suspended");
    sent.length = 0;
    const quiet = await asAdmin(token, () => post({ action: "approve" }, thirdId));
    assert.equal(quiet.status, 200);
    assert.equal(quiet.body.emailed, false, "no approval e-mail to a suspended account");
    assert.equal((quiet.body.view as { status: string }).status, "suspended");
    assert.equal(mailsTo(thirdEmail).length, 0);
    // Reinstated with the page approved: it is live again, and the e-mail says so.
    await moderationLib.moderateInfluencer({ adminId: Y, email: emailY }, thirdId, { action: "reinstate" }, null);
    assert.match(mailsTo(thirdEmail)[0].text, /live again/);

    // Reinstated while the page still needs approval: the e-mail must not say it is live again.
    sent.length = 0;
    await moderationLib.moderateInfluencer({ adminId: Y, email: emailY }, influencerId, { action: "suspend", reason: "Check the wording" }, null);
    await moderationLib.moderateInfluencer({ adminId: Y, email: emailY }, influencerId, { action: "reinstate" }, null);
    const reinstated = mailsTo(influencerEmail).find((m) => /reinstated/i.test(m.subject));
    assert.ok(reinstated);
    assert.match(reinstated.text, /still offline/);
    assert.doesNotMatch(reinstated.text, /live again/);

    // Approve normally: one audit row, one e-mail that does not promise it is live.
    sent.length = 0;
    const approved = await asAdmin(token, () => post({ action: "approve" }));
    assert.equal(approved.status, 200);
    assert.equal(approved.body.emailed, true);
    const view = approved.body.view as { status: string; approval: { required: boolean; at: string; byEmail: string } };
    assert.equal(view.status, "active");
    assert.equal(view.approval.required, true);
    assert.equal(view.approval.byEmail, emailY);
    assert.ok(view.approval.at);
    assertNoSecretKeys(approved.body);
    const audit = await auditRows("influencer.approved");
    assert.equal(audit.length, 1);
    assert.equal(audit[0].adminEmail, emailY);
    const mails = mailsTo(influencerEmail);
    assert.equal(mails.length, 1);
    assert.match(mails[0].subject, /approved/i);
    assert.doesNotMatch(mails[0].text, /as soon as/);

    const again = await asAdmin(token, () => post({ action: "approve" }));
    assert.equal(again.status, 409);
    assert.match(String(again.body.error), /already approved/i);
    assert.equal((await auditRows("influencer.approved")).length, 1);

    const after = await list(token, `?status=awaiting-approval${q}`);
    const left = (after.body.rows as { id: string }[]).map((r) => r.id);
    assert.ok(!left.includes(influencerId) && !left.includes(reviewId) && !left.includes(thirdId), "nobody is waiting any more");
  } finally {
    process.env.READINESS_BYPASS = "true";
    delete process.env.READINESS_REQUIRED;
  }
});

test("finishing onboarding with the gate off approves the page, so turning the gate on later keeps it live; with the gate on it waits", { skip }, async () => {
  const onboardable = async (tag: string) => {
    const inf = await prisma.influencer.create({ data: { slug: `mod${tag}-${run}`, name: `Mod Onboard ${tag} ${run}`, email: `mod-${tag}-inf-${run}@example.com` } });
    const user = await prisma.user.create({
      data: { email: `mod-${tag}-user-${run}@example.com`, passwordHash: "not-a-real-hash", emailVerifiedAt: new Date(), termsAcceptedAt: new Date(), influencerId: inf.id },
    });
    await prisma.service.create({ data: { influencerId: inf.id, title: "Onboarding service", durationMin: 30, priceMinor: 1000 } });
    await prisma.availabilityRule.create({ data: { influencerId: inf.id, weekday: 1, startTime: "10:00", endTime: "17:00", timezone: "UTC" } });
    return { id: inf.id, cookie: await authLib.createSession(user.id) };
  };
  const finish = async (cookie: string) => {
    set({ [authLib.sessionCookieName()]: cookie });
    return answer(await onboardingRoute.POST(new Request("http://localhost/api/dashboard/onboarding", { method: "POST" })));
  };
  const live = async (id: string) => (await prisma.influencer.count({ where: { id, AND: [readinessLib.buildPublicInfluencerWhere(process.env)] } })) === 1;

  const early = await onboardable("n"); // finishes while the gate is off
  const late = await onboardable("m"); // finishes while the gate is on

  assert.equal((await finish(early.cookie)).status, 200);
  const earlyRow = await prisma.influencer.findUniqueOrThrow({ where: { id: early.id } });
  assert.ok(earlyRow.onboardedAt);
  assert.ok(earlyRow.approvedAt, "a finished page counts as approved while nothing asks for approval");
  assert.equal(earlyRow.approvedByEmail, "system:gate-off");

  process.env.READINESS_REQUIRED = "approval";
  process.env.READINESS_BYPASS = "false";
  try {
    assert.equal(await live(early.id), true, "turning the gate on does not take the page offline");
    assert.equal((await finish(late.cookie)).status, 200);
    const lateRow = await prisma.influencer.findUniqueOrThrow({ where: { id: late.id } });
    assert.ok(lateRow.onboardedAt);
    assert.equal(lateRow.approvedAt, null, "with the gate on, finishing onboarding does not approve");
    assert.equal(await live(late.id), false, "it waits for an administrator");
    const token = await sessionLib.createAdminSession(Y);
    assert.equal((await asAdmin(token, () => post({ action: "approve" }, late.id))).status, 200);
    assert.equal(await live(late.id), true);
  } finally {
    process.env.READINESS_BYPASS = "true";
    delete process.env.READINESS_REQUIRED;
  }
});

test("the e-mails escape what an administrator typed", async () => {
  const { accountSuspendedMessage, accountReinstatedMessage, accountApprovedMessage } = await import("../lib/email/account-status");
  const hostile = `<script>alert("x")</script> & "quotes"`;
  const suspended = accountSuspendedMessage("Asha <b>Rao</b>", hostile, "help@example.com");
  assert.ok(!suspended.html.includes("<script>") && !suspended.html.includes("<b>Rao"), "no markup gets through");
  assert.ok(suspended.html.includes("&lt;script&gt;") && suspended.html.includes("&amp;"));
  assert.ok(suspended.text.includes(hostile), "the plain-text part carries the reason verbatim");
  assert.ok(suspended.text.includes("help@example.com"));
  assert.match(suspended.subject, /suspended/i);
  assert.match(accountReinstatedMessage("Asha", "https://app.example/asha").html, /https:\/\/app\.example\/asha/);
  assert.match(accountApprovedMessage("Asha", "https://app.example/asha").subject, /approved/i);
  assert.ok(!accountApprovedMessage("Asha", "javascript:alert(1)").html.includes('href="javascript:'), "only http(s) links are rendered");
});
