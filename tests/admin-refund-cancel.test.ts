// WP-B B2 / B3 / B4: the admin refund of a captured payment, the cancellation of a booking on the platform's behalf, and the booking search.
//
// MONEY: nothing here may reach Razorpay, Google or a mailbox. Razorpay is replaced with `mock.module("@/lib/payments")` (createRefund and
// listRefunds are stand-ins that record their input), `cancelBooking` with `mock.module("@/lib/manage")` (the real one sends e-mail),
// and the influencer alert goes to a stand-in sender. The pure part needs no database. The database part (needs DATABASE_URL,
// TOKEN_ENCRYPTION_KEY, APP_SECRET; skipped otherwise) pins the eligibility rules against real rows, the order of the audit entries
// against the money call, the claim that lets only one of two simultaneous refunds through, and the routes' gate, validation and answers.
import "dotenv/config";
import assert from "node:assert/strict";
import { after, before, mock, test } from "node:test";
import { hashPassword } from "../lib/auth/password";
import { hashToken, randomToken } from "../lib/auth/tokens";
import { prisma } from "../lib/db";
import { matchRouteRule } from "../lib/rate-limit/policies";
import { assertNoSecretKeys } from "./helpers/assert-no-secret-keys";

const skip = process.env.DATABASE_URL && process.env.TOKEN_ENCRYPTION_KEY && process.env.APP_SECRET ? false : "DATABASE_URL / TOKEN_ENCRYPTION_KEY / APP_SECRET not set";
const run = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
const PASSWORD = "correct-horse-battery-9";
const emailX = `rc-x-${run}@example.com`; // administrator with two-factor
const emailY = `rc-y-${run}@example.com`; // administrator without
const slug = `rc-${run}`;
const slug2 = `rc2-${run}`; // the influencer of the payout / refund race tests (its own payable payments)
const DAY = 86_400_000;
const keys = (o: unknown) => Object.keys(o as object).sort();

type RefundInput = { providerPaymentId: string; amountMinor?: number; receipt?: string; notes?: Record<string, string> };
type Rfnd = { id: string; payment_id: string; amount: number; currency: string; status: string };
const razorpayCalls: RefundInput[] = [];
/** What the stand-in Razorpay does next; each test sets it. */
let razorpay: (input: RefundInput) => Promise<Rfnd> = async () => {
  throw new Error("a test forgot to set the Razorpay stand-in");
};
const cancelCalls: { id: string; opts: unknown }[] = [];
let cancelStandIn: (id: string, opts: unknown) => Promise<unknown> = async () => {
  throw new Error("a test forgot to set the cancel stand-in");
};
const alerts: { influencerId: string; kind: string; detail: string; bookingId?: string }[] = [];

const jar = new Map<string, string>();
type Handler = (req: Request, ctx: { params: Promise<{ id: string }> }) => Promise<Response>;
let refundRoute: Handler;
let cancelRoute: Handler;
let bookingsRoute: (req: Request) => Promise<Response>;
let sessionLib: typeof import("../lib/admin/session");
let refundLib: typeof import("../lib/admin/refund");
let cancelLib: typeof import("../lib/admin/cancel");
let paymentsView: typeof import("../lib/views/admin-payments");
let bookingsView: typeof import("../lib/views/admin-bookings");
let RazorpayHttpError: typeof import("../lib/payments").RazorpayHttpError;
let setAlertSender: typeof import("../lib/alerts").setAlertSender;
let previousSender: ReturnType<typeof import("../lib/alerts").setAlertSender> | undefined;
let realCancelBooking: typeof import("../lib/manage").cancelBooking;
let X = "";
let Y = "";
let influencerId = "";
let serviceId = "";
let pendingPayoutId = "";
let paidPayoutId = "";
const savedEnv: Record<string, string | undefined> = {};
const ENV_NAMES = ["RATE_LIMIT_STORE", "REDIS_URL", "ADMIN_REQUIRE_2FA", "AUTO_REFUND_ON_CANCEL"];

async function passwordOnlySession(adminId: string): Promise<string> {
  const token = randomToken();
  await prisma.adminSession.create({ data: { tokenHash: hashToken(token), adminId, expiresAt: new Date(Date.now() + 3_600_000) } });
  return token;
}

async function post(handler: Handler, id: string, body: unknown, cookie?: string) {
  jar.clear();
  if (cookie !== undefined) jar.set(sessionLib.adminCookieName(), cookie);
  const res = await handler(
    new Request(`http://localhost/api/admin/x/${id}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body) }),
    { params: Promise.resolve({ id }) },
  );
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

let counter = 0;
/** A payment on a booking on a session `startOffsetMs` from now. Returns the ids. */
async function seedPayment(
  kind: string,
  o: { bookingStatus?: string; startOffsetMs?: number; payment?: Record<string, unknown>; refunds?: { amountMinor: number; status: string }[] } = {},
) {
  const start = new Date(Date.now() + (o.startOffsetMs ?? -3 * DAY) + counter++ * 60_000);
  const session = await prisma.session.create({ data: { serviceId, startTime: start, endTime: new Date(start.getTime() + 30 * 60_000) } });
  const booking = await prisma.booking.create({
    data: {
      sessionId: session.id,
      status: (o.bookingStatus ?? "COMPLETED") as never,
      customerName: `RC ${kind} ${run}`,
      customerEmail: `rc-${kind}-${run}@example.com`,
      whatsappE164: "+910000000000",
    },
  });
  const payment = await prisma.payment.create({
    data: {
      bookingId: booking.id,
      providerOrderId: `order_${run}_${kind}`,
      providerPaymentId: `pay_${run}_${kind}`,
      amountMinor: 100_000,
      currency: "INR",
      status: "CAPTURED",
      ...o.payment,
    },
  });
  for (const [i, r] of (o.refunds ?? []).entries()) {
    await prisma.refund.create({ data: { paymentId: payment.id, providerRefundId: `rfnd_${run}_${kind}_${i}`, amountMinor: r.amountMinor, status: r.status } });
  }
  return { paymentId: payment.id, bookingId: booking.id, sessionId: session.id };
}

/** A second captured payment on a booking (what a real double payment looks like). */
async function addPayment(bookingId: string, kind: string) {
  return prisma.payment.create({ data: { bookingId, providerOrderId: `order_${run}_${kind}`, providerPaymentId: `pay_${run}_${kind}`, amountMinor: 100_000, currency: "INR", status: "CAPTURED" } });
}

const auditOf = async (targetType: string, targetId: string) =>
  (await prisma.adminAuditLog.findMany({ where: { targetType, targetId }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] })).map((a) => ({ action: a.action, detail: a.detail as Record<string, unknown>, ip: a.ip, email: a.adminEmail }));

let refundSeq = 0;
/** Razorpay's refund ids are unique (the refunds table is keyed by them), so every stand-in answer gets a new one. */
const ok = (over: Partial<Rfnd> = {}) => async (input: RefundInput): Promise<Rfnd> => ({
  id: `rfnd_${run}_new${++refundSeq}`,
  payment_id: input.providerPaymentId,
  amount: input.amountMinor ?? 0,
  currency: "INR",
  status: "processed",
  ...over,
});

/* ---------- pure: eligibility ---------- */

const NOW = new Date("2026-10-11T12:00:00Z");
const PAST = new Date("2026-10-01T10:00:00Z");
const FUTURE = new Date("2026-10-20T10:00:00Z");
const base = (over: Record<string, unknown> = {}) => ({
  status: "CAPTURED",
  providerPaymentId: "pay_1",
  amountMinor: 100_000,
  refundAmountMinor: null as number | null,
  refundStatus: null as string | null,
  updatedAt: new Date("2026-10-10T00:00:00Z"),
  needsRefund: false,
  hasOtherCapturedPayment: false,
  booking: { status: "COMPLETED", startTime: PAST },
  payoutStatus: null as string | null,
  ...over,
});

test("adminRefundEligibility: every branch, in the plan's words", () => {
  const e = (over: Record<string, unknown> = {}, now = NOW) => refundLib.adminRefundEligibility(base(over) as never, now);
  assert.deepEqual(e(), { allowed: true, remainingMinor: 100_000 });
  assert.deepEqual(e({ refundAmountMinor: 30_000 }), { allowed: true, remainingMinor: 70_000 }, "the remainder of a partly refunded payment");
  // 1. captured with a Razorpay payment id
  for (const [over, reason] of [
    [{ status: "CREATED" }, "Only captured payments can be refunded."],
    [{ status: "FAILED" }, "Only captured payments can be refunded."],
    [{ providerPaymentId: null }, "Only captured payments can be refunded."],
    [{ status: "REFUNDED", refundAmountMinor: 100_000 }, "This payment was already refunded in full."],
  ] as [Record<string, unknown>, string][]) {
    const r = e(over);
    assert.equal(r.allowed, false, JSON.stringify(over));
    assert.equal(!r.allowed && r.reason, reason, JSON.stringify(over));
  }
  // 2. something left
  for (const refundAmountMinor of [100_000, 100_001]) {
    const r = e({ refundAmountMinor });
    assert.deepEqual([r.allowed, !r.allowed && r.reason, r.remainingMinor], [false, "This payment was already refunded in full.", 0]);
  }
  // 3. a refund in progress blocks for 10 minutes, then it is settled against Razorpay by refundPayment itself
  const claimed = (ago: number) => e({ refundStatus: "requested", updatedAt: new Date(NOW.getTime() - ago) });
  assert.equal(!claimed(60_000).allowed && (claimed(60_000) as { reason: string }).reason, "A refund is already in progress.");
  assert.equal(!claimed(9 * 60_000 + 59_000).allowed, true);
  assert.equal(claimed(10 * 60_000).allowed, true, "a claim older than CLAIM_STALE_MS no longer blocks (refundPayment reconciles it first)");
  assert.equal(e({ refundStatus: "pending" }).allowed, true, "a pending (not requested) earlier refund does not block another one for what is left");
  assert.equal(e({ refundStatus: "failed" }).allowed, true);
  // 4. an upcoming live booking
  const live = (status: string, startTime: Date, needsRefund = false, dup = false) => e({ booking: { status, startTime }, needsRefund, hasOtherCapturedPayment: dup });
  for (const status of ["PAID", "SCHEDULED"]) {
    const r = live(status, FUTURE);
    assert.equal(!r.allowed && r.reason, "Cancel the booking first (Bookings > Cancel).", status);
    assert.equal(live(status, FUTURE, true, true).allowed, true, `${status}: flagged and another captured payment on the booking (a real duplicate) may be refunded`);
    assert.equal(live(status, FUTURE, true, false).allowed, false, `${status}: the flag alone (a failed refund sets it too) is not enough`);
    assert.equal(live(status, FUTURE, false, true).allowed, false, `${status}: another payment without the flag is not enough`);
    assert.equal(live(status, PAST).allowed, true, `${status}: a session in the past`);
    assert.equal(live(status, NOW).allowed, true, `${status}: starting exactly now is not upcoming`);
  }
  for (const status of ["CANCELLED", "COMPLETED", "FAILED", "EXPIRED", "HELD", "PENDING_PAYMENT", "REQUESTED"]) assert.equal(live(status, FUTURE).allowed, true, `${status}: not a live booking`);
  // 5. a payout
  const pending = e({ payoutStatus: "PENDING" });
  assert.equal(!pending.allowed && pending.reason, "This payment is in a pending payout. Cancel that payout first.");
  assert.equal(e({ payoutStatus: "PAID" }).allowed, true, "a payment in a PAID payout may be refunded (the payout page then shows it as money to recover)");
  assert.equal(e({ payoutStatus: "CANCELLED" }).allowed, true);
  // The first rule that fails is the one reported.
  const many = e({ status: "CREATED", payoutStatus: "PENDING", booking: { status: "PAID", startTime: FUTURE } });
  assert.equal(!many.allowed && many.reason, "Only captured payments can be refunded.");
});

test("adminCancelEligibility: paid or scheduled before the start, or failed; nothing else", () => {
  const e = (status: string, startTime: Date) => cancelLib.adminCancelEligibility({ status, startTime }, NOW);
  assert.deepEqual(e("PAID", FUTURE), { allowed: true });
  assert.deepEqual(e("SCHEDULED", FUTURE), { allowed: true });
  assert.deepEqual(e("FAILED", FUTURE), { allowed: true });
  assert.deepEqual(e("FAILED", PAST), { allowed: true }, "a failed booking has no session to attend; cancelBooking accepts it");
  for (const status of ["PAID", "SCHEDULED", "COMPLETED"]) {
    assert.deepEqual(e(status, PAST), { allowed: false, reason: "This session has already taken place; refund the payment instead." }, status);
  }
  assert.equal(e("SCHEDULED", NOW).allowed, false, "starting exactly now has started");
  assert.deepEqual(e("CANCELLED", FUTURE), { allowed: false, reason: "This booking is already cancelled." });
  for (const status of ["HELD", "PENDING_PAYMENT", "REQUESTED", "EXPIRED"]) assert.deepEqual(e(status, FUTURE), { allowed: false, reason: "Only paid or scheduled bookings can be cancelled." }, status);
});

test("the refund and cancel actions share the tight money rate rule", () => {
  for (const [path, name] of [
    ["/api/admin/payments/abc/refund", "admin-money"],
    ["/api/admin/bookings/abc/cancel", "admin-money"],
    ["/api/admin/payments/abc/unreconcile", "admin-money"],
    ["/api/admin/payouts/abc", "admin-money"],
  ] as const) {
    const rule = matchRouteRule("POST", path);
    assert.equal(rule?.name, name, path);
    assert.equal(rule?.limit, 60);
  }
  assert.equal(matchRouteRule("POST", "/api/admin/payments/reconcile")?.name, "admin-reconcile");
  assert.equal(matchRouteRule("GET", "/api/admin/bookings")?.name, "admin");
});

/* ---------- database part ---------- */

before(async () => {
  for (const name of ENV_NAMES) savedEnv[name] = process.env[name];
  process.env.RATE_LIMIT_STORE = "memory";
  delete process.env.REDIS_URL;
  process.env.ADMIN_REQUIRE_2FA = "false";
  process.env.AUTO_REFUND_ON_CANCEL = "false";
  mock.module("next/headers", {
    namedExports: {
      cookies: async () => ({ get: (name: string) => (jar.has(name) ? { name, value: jar.get(name) } : undefined) }),
      headers: async () => new Headers(),
    },
  });
  // Razorpay first: every module that imports it from here on gets the stand-in. Nothing above loads lib/refunds or lib/manage.
  const realPayments = await import("../lib/payments");
  RazorpayHttpError = realPayments.RazorpayHttpError;
  mock.module("@/lib/payments", {
    namedExports: {
      ...realPayments,
      createRefund: async (input: RefundInput) => {
        razorpayCalls.push(input);
        return razorpay(input);
      },
      listRefunds: async () => {
        throw new Error("listRefunds must not be reached in these tests");
      },
    },
  });
  const realManage = await import("../lib/manage");
  realCancelBooking = realManage.cancelBooking;
  mock.module("@/lib/manage", {
    namedExports: {
      ...realManage,
      cancelBooking: async (id: string, opts: unknown) => {
        cancelCalls.push({ id, opts });
        return cancelStandIn(id, opts);
      },
    },
  });
  const alertsLib = await import("../lib/alerts");
  setAlertSender = alertsLib.setAlertSender;
  previousSender = setAlertSender(async (to, alert) => {
    alerts.push({ influencerId: to.id, kind: alert.kind, detail: alert.detail, bookingId: alert.bookingId });
  });
  sessionLib = await import("../lib/admin/session");
  refundLib = await import("../lib/admin/refund");
  cancelLib = await import("../lib/admin/cancel");
  paymentsView = await import("../lib/views/admin-payments");
  bookingsView = await import("../lib/views/admin-bookings");
  refundRoute = (await import("../app/api/admin/payments/[id]/refund/route")).POST as Handler;
  cancelRoute = (await import("../app/api/admin/bookings/[id]/cancel/route")).POST as Handler;
  bookingsRoute = (await import("../app/api/admin/bookings/route")).GET;
  if (skip) return;

  const influencer = await prisma.influencer.create({ data: { slug, name: `RC Owner ${run}`, email: `rc-owner-${run}@example.com`, notifyByEmail: false, timezone: "Asia/Kolkata" } });
  influencerId = influencer.id;
  serviceId = (await prisma.service.create({ data: { influencerId, title: `RC call ${run}`, durationMin: 30, priceMinor: 100_000 } })).id;
  const base = { influencerId, currency: "INR", grossMinor: 100_000, refundsMinor: 0, feeBps: 1000, feeMinor: 10_000, netMinor: 90_000, paymentCount: 1, destination: "UPI ****1234", createdByEmail: emailY };
  pendingPayoutId = (await prisma.payout.create({ data: { ...base, status: "PENDING" } })).id;
  paidPayoutId = (await prisma.payout.create({ data: { ...base, status: "PAID", reference: `UTR${run}`, paidAt: new Date(), paidByEmail: emailX } })).id;

  const hash = await hashPassword(PASSWORD);
  X = (await prisma.adminUser.create({ data: { email: emailX, name: "RC Admin X", passwordHash: hash } })).id;
  Y = (await prisma.adminUser.create({ data: { email: emailY, name: "RC Admin Y", passwordHash: hash } })).id;
  const mfa = await import("../lib/admin/mfa");
  const totp = await import("../lib/admin/totp");
  const past = Date.now() - 60_000;
  const s = (await mfa.startTotpEnrollment(X)).secret;
  assert.ok((await mfa.confirmTotpEnrollment(X, totp.totpAt(s, past), null, past)).ok);
});

after(async () => {
  try {
    if (!skip) {
      const steps: [string, () => Promise<unknown>][] = [
        ["payouts", () => prisma.payout.deleteMany({ where: { influencer: { slug: { in: [slug, slug2] } } } })],
        ["influencer", () => prisma.influencer.deleteMany({ where: { slug: { in: [slug, slug2] } } })],
        ["audit", () => prisma.adminAuditLog.deleteMany({ where: { adminEmail: { in: [emailX, emailY] } } })],
        ["admins", () => prisma.adminUser.deleteMany({ where: { email: { in: [emailX, emailY] } } })],
      ];
      for (const [name, step] of steps) {
        for (let attempt = 1; attempt <= 2; attempt++) {
          try {
            await step();
            break;
          } catch (e) {
            if (attempt === 2) console.error(`[admin-refund-cancel cleanup] ${name} failed:`, e instanceof Error ? e.message : e);
          }
        }
      }
    }
  } finally {
    if (previousSender) setAlertSender(previousSender);
    for (const [name, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await prisma.$disconnect().catch(() => {});
  }
});

const actor = () => ({ adminId: Y, email: emailY });

test("refund: the audit entry is written BEFORE Razorpay is called, the amount is the remainder, the receipt is the deterministic one", { skip }, async () => {
  const { paymentId } = await seedPayment("order", { payment: { refundAmountMinor: 30_000, refundStatus: "processed" }, refunds: [{ amountMinor: 30_000, status: "processed" }] });
  const events: string[] = [];
  const audit = async (a: unknown, entry: { action: string; detail?: unknown }) => {
    events.push(`audit:${entry.action}`);
    const { recordAudit } = await import("../lib/admin/audit");
    await recordAudit(a as never, entry as never);
  };
  razorpayCalls.length = 0;
  razorpay = async (input) => {
    events.push("razorpay");
    return ok()(input);
  };
  const out = await refundLib.adminRefundPayment(paymentId, actor(), "Customer was charged twice", "203.0.113.9", { audit: audit as never });
  assert.deepEqual(out, { kind: "ok", status: "processed", amountMinor: 70_000, fullyRefunded: true });
  assert.deepEqual(events, ["audit:payment.refund_requested", "razorpay", "audit:payment.refunded"]);
  assert.equal(razorpayCalls.length, 1);
  assert.equal(razorpayCalls[0].amountMinor, 70_000, "what was left, computed from the row");
  assert.equal(razorpayCalls[0].providerPaymentId, `pay_${run}_order`);
  assert.equal(razorpayCalls[0].receipt, `rf_${paymentId}_100000`, "rf_<paymentId>_<cumulative refunded amount>: Razorpay refuses a duplicate");
  assert.equal(razorpayCalls[0].notes?.reason, "Customer was charged twice");
  const trail = await auditOf("payment", paymentId);
  assert.deepEqual(trail.map((t) => t.action), ["payment.refund_requested", "payment.refunded"]);
  assert.deepEqual(trail[0].detail, { remainingMinor: 70_000, currency: "INR", reason: "Customer was charged twice" });
  assert.deepEqual(trail[1].detail, { amountMinor: 70_000, currency: "INR", status: "processed", fullyRefunded: true });
  assert.deepEqual([trail[0].email, trail[0].ip], [emailY, "203.0.113.9"]);
  const row = await prisma.payment.findUniqueOrThrow({ where: { id: paymentId } });
  assert.deepEqual([row.status, row.refundAmountMinor, row.needsRefund], ["REFUNDED", 100_000, false]);
});

test("refund: if the audit entry cannot be written, Razorpay is never called", { skip }, async () => {
  const { paymentId } = await seedPayment("auditdown");
  razorpayCalls.length = 0;
  razorpay = ok();
  await assert.rejects(
    refundLib.adminRefundPayment(paymentId, actor(), "Reason is long enough", null, {
      audit: (async () => {
        throw new Error("audit store down");
      }) as never,
    }),
    /audit store down/,
  );
  assert.equal(razorpayCalls.length, 0);
  const row = await prisma.payment.findUniqueOrThrow({ where: { id: paymentId } });
  assert.deepEqual([row.status, row.refundStatus, row.refundAmountMinor], ["CAPTURED", null, null], "untouched");
});

test("refund: an audit entry that fails AFTER the money moved does not hide the result", { skip }, async () => {
  const { paymentId } = await seedPayment("auditlate");
  razorpayCalls.length = 0;
  razorpay = ok();
  let n = 0;
  const { recordAudit } = await import("../lib/admin/audit");
  const out = await refundLib.adminRefundPayment(paymentId, actor(), "Reason is long enough", null, {
    audit: (async (a: never, e: never) => {
      if (++n > 1) throw new Error("audit store down");
      await recordAudit(a, e);
    }) as never,
  });
  assert.equal(out.kind, "ok");
  assert.equal(razorpayCalls.length, 1);
});

test("refund: two at once, and a double click: only one reaches Razorpay (the claim), the others are refused", { skip }, async () => {
  const { paymentId } = await seedPayment("race");
  razorpayCalls.length = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  razorpay = async (input) => {
    await gate; // the first caller is parked inside Razorpay while the others try
    return ok()(input);
  };
  const first = refundLib.adminRefundPayment(paymentId, actor(), "Customer asked for it", null);
  const second = refundLib.adminRefundPayment(paymentId, actor(), "Customer asked for it", null);
  const third = refundLib.adminRefundPayment(paymentId, actor(), "Customer asked for it", null);
  setTimeout(release, 1500);
  const results = await Promise.all([first, second, third]);
  assert.equal(results.filter((r) => r.kind === "ok").length, 1, "exactly one refund");
  for (const r of results.filter((r) => r.kind !== "ok")) {
    assert.equal(r.kind, "not-allowed");
    assert.match((r as { reason: string }).reason, /already (in progress|refunded in full)/);
  }
  assert.equal(razorpayCalls.length, 1, "Razorpay was called once");
  // A click after it finished: refused as already refunded; still one call.
  const late = await refundLib.adminRefundPayment(paymentId, actor(), "Customer asked for it", null);
  assert.deepEqual(late, { kind: "not-allowed", reason: "This payment was already refunded in full." });
  assert.equal(razorpayCalls.length, 1);
  const actions = (await auditOf("payment", paymentId)).map((t) => t.action);
  assert.equal(actions.filter((a) => a === "payment.refunded").length, 1);
  assert.ok(actions.filter((a) => a === "payment.refund_requested").length >= 1, "the winner was audited before the call");
});

test("refund: a definite Razorpay rejection is a 502-kind result, audited as refund_failed, and the claim is released so it can be retried", { skip }, async () => {
  const { paymentId } = await seedPayment("rejected");
  razorpayCalls.length = 0;
  razorpay = async () => {
    throw new RazorpayHttpError(400, "Razorpay refund failed (400): The payment id is invalid");
  };
  const out = await refundLib.adminRefundPayment(paymentId, actor(), "Reason is long enough", null);
  assert.deepEqual(out, { kind: "failed", message: "Razorpay refund failed (400): The payment id is invalid" });
  const row = await prisma.payment.findUniqueOrThrow({ where: { id: paymentId } });
  assert.deepEqual([row.status, row.refundStatus, row.refundAmountMinor], ["CAPTURED", null, null], "nothing refunded, claim released");
  const trail = await auditOf("payment", paymentId);
  assert.deepEqual(trail.map((t) => t.action), ["payment.refund_requested", "payment.refund_failed"]);
  // And a retry goes through.
  razorpay = ok();
  assert.equal((await refundLib.adminRefundPayment(paymentId, actor(), "Reason is long enough", null)).kind, "ok");
});

test("refund: an unconfirmed Razorpay answer keeps the payment locked (pending), audited as refund_pending, and a second try is refused", { skip }, async () => {
  const { paymentId } = await seedPayment("timeout");
  razorpayCalls.length = 0;
  razorpay = async () => {
    throw new Error("fetch failed: timed out");
  };
  assert.deepEqual(await refundLib.adminRefundPayment(paymentId, actor(), "Reason is long enough", null), { kind: "pending" });
  assert.deepEqual((await auditOf("payment", paymentId)).map((t) => t.action), ["payment.refund_requested", "payment.refund_pending"]);
  const row = await prisma.payment.findUniqueOrThrow({ where: { id: paymentId } });
  assert.equal(row.refundStatus, "requested");
  razorpay = ok();
  const again = await refundLib.adminRefundPayment(paymentId, actor(), "Reason is long enough", null);
  assert.equal(again.kind, "not-allowed");
  assert.equal(razorpayCalls.length, 1, "the second attempt never reached Razorpay");
});

test("refund: eligibility against real rows (upcoming live booking, flagged double payment, pending / paid payout, refunded, not captured, unknown)", { skip }, async () => {
  razorpayCalls.length = 0;
  razorpay = ok();
  const refuse = async (paymentId: string, reason: RegExp) => {
    const out = await refundLib.adminRefundPayment(paymentId, actor(), "Reason is long enough", null);
    assert.equal(out.kind, "not-allowed");
    assert.match((out as { reason: string }).reason, reason);
  };
  const upcoming = await seedPayment("upcoming", { bookingStatus: "SCHEDULED", startOffsetMs: 5 * DAY });
  await refuse(upcoming.paymentId, /Cancel the booking first/);
  const paidNoLink = await seedPayment("upcomingpaid", { bookingStatus: "PAID", startOffsetMs: 5 * DAY });
  await refuse(paidNoLink.paymentId, /Cancel the booking first/);
  const inPending = await seedPayment("inpending", { payment: { payoutId: pendingPayoutId } });
  await refuse(inPending.paymentId, /pending payout/);
  const fullyRefunded = await seedPayment("done", { payment: { status: "REFUNDED", refundAmountMinor: 100_000, refundStatus: "processed" }, refunds: [{ amountMinor: 100_000, status: "processed" }] });
  await refuse(fullyRefunded.paymentId, /already refunded in full/);
  const unpaid = await seedPayment("unpaid", { payment: { status: "CREATED", providerPaymentId: null } });
  await refuse(unpaid.paymentId, /Only captured payments/);
  const inProgress = await seedPayment("inprogress", { payment: { refundStatus: "requested" } });
  await refuse(inProgress.paymentId, /already in progress/);
  assert.deepEqual(await refundLib.adminRefundPayment("does-not-exist", actor(), "Reason is long enough", null), { kind: "not-found" });
  assert.equal(razorpayCalls.length, 0, "none of the refusals reached Razorpay");
  for (const id of [upcoming.paymentId, inPending.paymentId, fullyRefunded.paymentId]) assert.deepEqual(await auditOf("payment", id), [], "a refusal before the money call writes no audit entry");

  // Allowed: a double payment flagged on a live booking, and a payment in a PAID payout.
  // The flag alone on a live booking (a failed partial refund sets it) is refused; with a second captured payment on the booking it is a real duplicate.
  const flaggedOnly = await seedPayment("flaggedonly", { bookingStatus: "SCHEDULED", startOffsetMs: 5 * DAY, payment: { needsRefund: true } });
  await refuse(flaggedOnly.paymentId, /Cancel the booking first/);
  const flagged = await seedPayment("flagged", { bookingStatus: "SCHEDULED", startOffsetMs: 5 * DAY, payment: { needsRefund: true } });
  await addPayment(flagged.bookingId, "flaggeddup");
  assert.equal((await refundLib.adminRefundPayment(flagged.paymentId, actor(), "Paid twice", null)).kind, "ok");
  const inPaid = await seedPayment("inpaid", { payment: { payoutId: paidPayoutId } });
  assert.equal((await refundLib.adminRefundPayment(inPaid.paymentId, actor(), "Dispute resolved", null)).kind, "ok");
  assert.equal(razorpayCalls.length, 2);
  assert.equal((await prisma.payment.findUniqueOrThrow({ where: { id: inPaid.paymentId } })).payoutId, paidPayoutId, "the payout link is untouched");
});

test("refund route: the gate (401, 403 enroll, 403 verify), the body (confirm and reason), the id, and the exact answers", { skip }, async () => {
  const plain = await sessionLib.createAdminSession(Y);
  const stale = await passwordOnlySession(X);
  const verified = await sessionLib.createAdminSession(X, {}, { mfaVerified: true });
  razorpayCalls.length = 0;
  razorpay = ok();
  const good = { reason: "Customer was charged twice", confirm: true, expectedRemainingMinor: 100_000 };
  const { paymentId } = await seedPayment("route");

  for (const cookie of [undefined, "", "not-a-real-admin-session-token"]) {
    const out = await post(refundRoute, paymentId, good, cookie);
    assert.equal(out.status, 401);
    assert.deepEqual(keys(out.body), ["error"]);
  }
  const verify = await post(refundRoute, paymentId, good, stale);
  assert.equal(verify.status, 403);
  assert.deepEqual([verify.body.mfaRequired, verify.body.mfaAction], [true, "verify"]);
  process.env.ADMIN_REQUIRE_2FA = "true";
  try {
    const enroll = await post(refundRoute, paymentId, good, plain);
    assert.equal(enroll.status, 403);
    assert.deepEqual([enroll.body.mfaRequired, enroll.body.mfaAction], [true, "enroll"]);
    assert.equal((await post(refundRoute, paymentId, good, stale)).body.mfaAction, "verify");
  } finally {
    process.env.ADMIN_REQUIRE_2FA = "false";
  }
  assert.equal(razorpayCalls.length, 0, "a denied caller never reaches Razorpay");

  // Body validation: nothing is refunded for any of these.
  for (const [body, label] of [
    [{ reason: "Customer was charged twice" }, "confirm and expected amount missing"],
    [{ reason: "Customer was charged twice", confirm: true }, "expectedRemainingMinor missing"],
    [{ ...good, expectedRemainingMinor: 0 }, "expected amount zero"],
    [{ ...good, expectedRemainingMinor: -5 }, "expected amount negative"],
    [{ ...good, expectedRemainingMinor: 10.5 }, "expected amount fractional"],
    [{ ...good, expectedRemainingMinor: "100000" }, "expected amount as a string"],
    [{ ...good, confirm: false }, "confirm false"],
    [{ ...good, confirm: "true" }, "confirm as a string"],
    [{ ...good, confirm: 1 }, "confirm as a number"],
    [{ confirm: true, expectedRemainingMinor: 100_000 }, "reason missing"],
    [{ ...good, reason: "    " }, "reason blank"],
    [{ ...good, reason: "abcd" }, "reason too short"],
    [{ ...good, reason: "x".repeat(301) }, "reason too long"],
    [{ ...good, reason: 12345678 }, "reason not text"],
    [{ ...good, reason: "Customer was charged twice\u0000" }, "NUL in the reason"],
    [{}, "empty"],
    [[], "array"],
    ["not json", "not JSON"],
  ] as [unknown, string][]) {
    const out = await post(refundRoute, paymentId, body, plain);
    assert.equal(out.status, 400, label);
    assertNoSecretKeys(out.body);
  }
  assert.equal(razorpayCalls.length, 0);
  assert.deepEqual(await auditOf("payment", paymentId), [], "a rejected body writes no audit entry");

  // Unknown ids.
  for (const id of ["nope", "x".repeat(65), "a b", "a.b"]) {
    const out = await post(refundRoute, id, good, plain);
    assert.equal(out.status, 404, id);
    assert.deepEqual(keys(out.body), ["error"]);
  }

  // The amount is never read from the request: an `amountMinor` in the body is ignored, the remainder is refunded.
  const out = await post(refundRoute, paymentId, { ...good, amountMinor: 1, amount: 1, fullyRefunded: false }, plain);
  assert.equal(out.status, 200);
  assert.deepEqual(keys(out.body), ["amountMinor", "fullyRefunded", "ok", "status"]);
  assert.deepEqual(out.body, { ok: true, status: "processed", amountMinor: 100_000, fullyRefunded: true });
  assertNoSecretKeys(out.body);
  assert.equal(razorpayCalls.length, 1);
  assert.equal(razorpayCalls[0].amountMinor, 100_000);
  // Second click: 409 with the reason, Razorpay not called again.
  const again = await post(refundRoute, paymentId, good, plain);
  assert.equal(again.status, 409);
  assert.deepEqual(again.body, { error: "This payment was already refunded in full." });
  assert.equal(razorpayCalls.length, 1);

  // 409 for an upcoming live booking, 502 for a rejection, 202 for an unconfirmed answer.
  const upcoming = await seedPayment("routeupcoming", { bookingStatus: "SCHEDULED", startOffsetMs: 4 * DAY });
  const blocked = await post(refundRoute, upcoming.paymentId, good, verified);
  assert.equal(blocked.status, 409);
  assert.match(blocked.body.error as string, /Cancel the booking first/);
  const rejected = await seedPayment("routerejected");
  razorpay = async () => {
    throw new RazorpayHttpError(400, "Razorpay refund failed (400): bad request");
  };
  const r502 = await post(refundRoute, rejected.paymentId, good, plain);
  assert.equal(r502.status, 502);
  assert.deepEqual(r502.body, { error: "Razorpay refund failed (400): bad request" });
  const unclear = await seedPayment("routeunclear");
  razorpay = async () => {
    throw new Error("socket hang up");
  };
  const r202 = await post(refundRoute, unclear.paymentId, good, plain);
  assert.equal(r202.status, 202);
  assert.deepEqual(r202.body, { ok: true, status: "pending" });
});

test("cancel: the audit entry comes first, the cancel is the influencer's (full refund decision) with the reason, the influencer is alerted, the answer carries the refund outcome", { skip }, async () => {
  const { bookingId } = await seedPayment("cancel", { bookingStatus: "SCHEDULED", startOffsetMs: 6 * DAY });
  const events: string[] = [];
  const { recordAudit } = await import("../lib/admin/audit");
  const audit = async (a: never, e: { action: string }) => {
    events.push(`audit:${e.action}`);
    await recordAudit(a, e as never);
  };
  cancelCalls.length = 0;
  alerts.length = 0;
  cancelStandIn = async () => {
    events.push("cancel");
    return { refund: { eligible: true, reason: "cancelled by the host", issued: "no" }, warning: "Calendar not updated" };
  };
  const out = await cancelLib.adminCancelBooking(bookingId, actor(), "Influencer suspended", "203.0.113.9", { audit: audit as never });
  assert.deepEqual(out, { kind: "ok", refund: { eligible: true, reason: "cancelled by the host", issued: "no" }, warning: "Calendar not updated" });
  assert.deepEqual(events, ["audit:booking.cancel_requested", "cancel", "audit:booking.cancelled_by_admin"]);
  assert.deepEqual(cancelCalls, [{ id: bookingId, opts: { actor: "influencer", byPlatform: true, reason: "Cancelled by the platform: Influencer suspended" } }]);
  const trail = await auditOf("booking", bookingId);
  assert.deepEqual(trail.map((t) => t.action), ["booking.cancel_requested", "booking.cancelled_by_admin"]);
  assert.deepEqual(trail[0].detail, { reason: "Influencer suspended", status: "SCHEDULED" });
  assert.deepEqual(trail[1].detail, { refund: "no", refundDue: true, warning: true });
  assert.equal(trail[0].ip, "203.0.113.9");
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].influencerId, influencerId);
  assert.equal(alerts[0].kind, "platform-cancelled");
  assert.equal(alerts[0].bookingId, bookingId);
  assert.match(alerts[0].detail, new RegExp(`RC call ${run}`));
  assert.match(alerts[0].detail, new RegExp(`RC cancel ${run}`));
  assert.match(alerts[0].detail, /Influencer suspended/);
  assert.match(alerts[0].detail, /IST|GMT\+5:30/, "the time is in the influencer's own zone");
});

test("cancel: refused for a past session, a cancelled or unpaid booking, or an unknown id; a failed booking is allowed; audit failure stops it; a race with another cancel is a refusal", { skip }, async () => {
  cancelCalls.length = 0;
  alerts.length = 0;
  cancelStandIn = async () => ({ refund: { eligible: false, reason: "x", issued: "no" } });
  const past = await seedPayment("pastsession", { bookingStatus: "SCHEDULED", startOffsetMs: -2 * DAY });
  assert.deepEqual(await cancelLib.adminCancelBooking(past.bookingId, actor(), "Reason is long enough", null), { kind: "not-allowed", reason: "This session has already taken place; refund the payment instead." });
  const done = await seedPayment("completed", { bookingStatus: "COMPLETED", startOffsetMs: 2 * DAY });
  assert.equal((await cancelLib.adminCancelBooking(done.bookingId, actor(), "Reason is long enough", null)).kind, "not-allowed");
  const cancelled = await seedPayment("alreadycancelled", { bookingStatus: "CANCELLED", startOffsetMs: 2 * DAY });
  assert.deepEqual(await cancelLib.adminCancelBooking(cancelled.bookingId, actor(), "Reason is long enough", null), { kind: "not-allowed", reason: "This booking is already cancelled." });
  const held = await seedPayment("pendingpay", { bookingStatus: "PENDING_PAYMENT", startOffsetMs: 2 * DAY });
  assert.equal((await cancelLib.adminCancelBooking(held.bookingId, actor(), "Reason is long enough", null)).kind, "not-allowed");
  assert.deepEqual(await cancelLib.adminCancelBooking("does-not-exist", actor(), "Reason is long enough", null), { kind: "not-found" });
  assert.equal(cancelCalls.length, 0, "no refusal reached cancelBooking");
  assert.equal(alerts.length, 0);
  for (const id of [past.bookingId, done.bookingId, cancelled.bookingId, held.bookingId]) assert.deepEqual(await auditOf("booking", id), [], "a refusal writes no audit entry");

  const failed = await seedPayment("failedbooking", { bookingStatus: "FAILED", startOffsetMs: -2 * DAY });
  assert.equal((await cancelLib.adminCancelBooking(failed.bookingId, actor(), "Reason is long enough", null)).kind, "ok");
  assert.equal(cancelCalls.length, 1);

  // The audit entry cannot be written: the booking is not cancelled.
  const keep = await seedPayment("auditfail", { bookingStatus: "SCHEDULED", startOffsetMs: 3 * DAY });
  await assert.rejects(
    cancelLib.adminCancelBooking(keep.bookingId, actor(), "Reason is long enough", null, { audit: (async () => { throw new Error("audit store down"); }) as never }),
    /audit store down/,
  );
  assert.equal(cancelCalls.length, 1, "cancelBooking was not called");

  // The booking changed between the read and the cancel (another administrator, the customer): cancelBooking refuses, we report a 409-kind result.
  const { BookingNotManageableError } = await import("../lib/manage");
  const raced = await seedPayment("raced", { bookingStatus: "SCHEDULED", startOffsetMs: 3 * DAY });
  cancelStandIn = async () => {
    throw new BookingNotManageableError("Booking cannot be cancelled while it is CANCELLED");
  };
  assert.deepEqual(await cancelLib.adminCancelBooking(raced.bookingId, actor(), "Reason is long enough", null), { kind: "not-allowed", reason: "Booking cannot be cancelled while it is CANCELLED" });
  assert.deepEqual((await auditOf("booking", raced.bookingId)).map((t) => t.action), ["booking.cancel_requested", "booking.cancel_refused"]);
  assert.equal(alerts.length, 1, "only the successful failed-booking cancel alerted");

  // An unexpected failure is audited and rethrown (a 500); no alert.
  const broken = await seedPayment("broken", { bookingStatus: "SCHEDULED", startOffsetMs: 3 * DAY });
  cancelStandIn = async () => {
    throw new Error("database exploded");
  };
  await assert.rejects(cancelLib.adminCancelBooking(broken.bookingId, actor(), "Reason is long enough", null), /database exploded/);
  assert.deepEqual((await auditOf("booking", broken.bookingId)).map((t) => t.action), ["booking.cancel_requested", "booking.cancel_error"]);
  assert.equal(alerts.length, 1);
});

test("cancel route: the gate, the body, the ids, and the exact answers", { skip }, async () => {
  const plain = await sessionLib.createAdminSession(Y);
  const stale = await passwordOnlySession(X);
  const good = { reason: "Influencer suspended", confirm: true };
  const { bookingId } = await seedPayment("cancelroute", { bookingStatus: "SCHEDULED", startOffsetMs: 6 * DAY });
  cancelCalls.length = 0;
  alerts.length = 0;
  cancelStandIn = async () => ({ refund: { eligible: true, reason: "cancelled by the host", issued: "no" } });

  for (const cookie of [undefined, "", "not-a-real-admin-session-token"]) {
    const out = await post(cancelRoute, bookingId, good, cookie);
    assert.equal(out.status, 401);
    assert.deepEqual(keys(out.body), ["error"]);
  }
  assert.equal((await post(cancelRoute, bookingId, good, stale)).body.mfaAction, "verify");
  process.env.ADMIN_REQUIRE_2FA = "true";
  try {
    assert.equal((await post(cancelRoute, bookingId, good, plain)).body.mfaAction, "enroll");
  } finally {
    process.env.ADMIN_REQUIRE_2FA = "false";
  }
  for (const [body, label] of [
    [{ reason: "Influencer suspended" }, "confirm missing"],
    [{ reason: "Influencer suspended", confirm: false }, "confirm false"],
    [{ confirm: true }, "reason missing"],
    [{ reason: "abcd", confirm: true }, "reason too short"],
    [{ reason: "x".repeat(501), confirm: true }, "reason too long"],
    [{ reason: "Influencer suspended\u0000", confirm: true }, "NUL"],
    ["not json", "not JSON"],
  ] as [unknown, string][]) {
    const out = await post(cancelRoute, bookingId, body, plain);
    assert.equal(out.status, 400, label);
  }
  for (const id of ["nope", "x".repeat(65), "a b"]) assert.equal((await post(cancelRoute, id, good, plain)).status, 404, id);
  assert.equal(cancelCalls.length, 0);
  assert.deepEqual(await auditOf("booking", bookingId), []);

  const done = await post(cancelRoute, bookingId, { ...good, extra: "ignored" }, plain);
  assert.equal(done.status, 200);
  assert.deepEqual(keys(done.body), ["ok", "refund", "warning"]);
  assert.deepEqual(done.body, { ok: true, refund: { eligible: true, issued: "no" }, warning: null });
  assert.deepEqual(keys(done.body.refund), ["eligible", "issued"]);
  assertNoSecretKeys(done.body);
  assert.equal(cancelCalls.length, 1);
  assert.equal(alerts.length, 1);

  const past = await seedPayment("cancelroutepast", { bookingStatus: "SCHEDULED", startOffsetMs: -2 * DAY });
  const refused = await post(cancelRoute, past.bookingId, good, plain);
  assert.equal(refused.status, 409);
  assert.deepEqual(refused.body, { error: "This session has already taken place; refund the payment instead." });
  assert.equal((await post(cancelRoute, "does-not-exist", good, plain)).status, 404);
  assert.equal(cancelCalls.length, 1);
});

/** Pages of a view until `done`, one at a time (other people's rows share the database and are newer or older). */
async function findRows<R extends { id: string }>(load: (page: string) => Promise<{ rows: R[]; pageCount: number }>, want: (r: R) => boolean, count: number) {
  const found = new Map<string, R>();
  for (let page = 1; page <= 12; page++) {
    const data = await load(String(page));
    for (const r of data.rows) if (want(r)) found.set(r.id, r);
    if (found.size >= count || page >= data.pageCount) break;
  }
  return found;
}

test("payments view: each row says whether a refund is offered, why not, and how much; exactly the hand-picked keys", { skip }, async () => {
  const ok1 = await seedPayment("viewok", { payment: { needsRefund: true } });
  const partial = await seedPayment("viewpartial", { payment: { refundAmountMinor: 30_000, refundStatus: "processed" }, refunds: [{ amountMinor: 30_000, status: "processed" }] });
  const live = await seedPayment("viewlive", { bookingStatus: "SCHEDULED", startOffsetMs: 4 * DAY, payment: { needsRefund: true } });
  await addPayment(live.bookingId, "viewlivedup");
  const liveFlagOnly = await seedPayment("viewliveflag", { bookingStatus: "SCHEDULED", startOffsetMs: 4 * DAY, payment: { needsRefund: true } });
  const livePlain = await seedPayment("viewliveplain", { bookingStatus: "SCHEDULED", startOffsetMs: 4 * DAY });
  const inPending = await seedPayment("viewpending", { payment: { payoutId: pendingPayoutId, needsRefund: true } });
  const inPaid = await seedPayment("viewpaid", { payment: { payoutId: paidPayoutId } });
  const unpaid = await seedPayment("viewunpaid", { payment: { status: "CREATED", providerPaymentId: null } });
  const mine = new Set([ok1, partial, live, liveFlagOnly, livePlain, inPending, inPaid, unpaid].map((s) => s.paymentId));
  const dupId = (await prisma.payment.findUniqueOrThrow({ where: { providerOrderId: `order_${run}_viewlivedup` } })).id;
  mine.add(dupId);
  const rows = await findRows(async (page) => paymentsView.loadAdminPaymentsView({ view: "all", page }), (r) => mine.has(r.id), mine.size);
  assert.equal(rows.size, mine.size, "all rows were found");
  const row = (s: { paymentId: string }) => rows.get(s.paymentId)!;
  for (const r of rows.values()) {
    assert.deepEqual(keys(r.refund), ["allowed", "reason", "remainingMinor"]);
    assert.deepEqual(keys(r), ["amountMinor", "booking", "createdAt", "currency", "id", "inPayout", "influencer", "mismatch", "needsRefund", "razorpayId", "reconciled", "refund", "refundAmountMinor", "refundStatus", "service", "status"]);
    assertNoSecretKeys(r);
  }
  assert.deepEqual(row(ok1).refund, { allowed: true, reason: null, remainingMinor: 100_000 });
  assert.deepEqual(row(partial).refund, { allowed: true, reason: null, remainingMinor: 70_000 });
  assert.deepEqual(row(live).refund, { allowed: true, reason: null, remainingMinor: 100_000 }, "a flagged double payment (another captured payment on the booking) on a live booking");
  assert.deepEqual(row(liveFlagOnly).refund, { allowed: false, reason: "Cancel the booking first (Bookings > Cancel).", remainingMinor: 100_000 }, "the flag alone is not a duplicate");
  assert.deepEqual(row(livePlain).refund, { allowed: false, reason: "Cancel the booking first (Bookings > Cancel).", remainingMinor: 100_000 });
  assert.deepEqual(row(inPending).refund, { allowed: false, reason: "This payment is in a pending payout. Cancel that payout first.", remainingMinor: 100_000 });
  assert.deepEqual(row(inPaid).refund, { allowed: true, reason: null, remainingMinor: 100_000 });
  assert.equal(row(inPaid).inPayout, true);
  assert.deepEqual(row(unpaid).refund, { allowed: false, reason: "Only captured payments can be refunded.", remainingMinor: 100_000 });
});

test("bookings view: `cancel` on each row, and the search (`q`) by booking id, e-mail (any case, part of it) or name", { skip }, async () => {
  const a = await seedPayment("searcha", { bookingStatus: "SCHEDULED", startOffsetMs: 5 * DAY });
  const b = await seedPayment("searchb", { bookingStatus: "COMPLETED", startOffsetMs: -5 * DAY });
  const c = await seedPayment("searchc", { bookingStatus: "FAILED", startOffsetMs: -5 * DAY });
  const load = (q: string | null, status: string | null = null) => bookingsView.loadAdminBookingsView({ q, status, page: "1" });
  const idsOf = (v: { rows: { id: string }[] }) => v.rows.map((r) => r.id).sort();

  // By e-mail: the whole address, an upper-case copy, a part of it. Each is one booking.
  for (const q of [`rc-searcha-${run}@example.com`, `RC-SEARCHA-${run}@EXAMPLE.COM`, `searcha-${run}`]) {
    const v = await load(q);
    assert.deepEqual(idsOf(v), [a.bookingId], q);
    assert.equal(v.q, q.trim());
    assert.deepEqual(keys(v), ["page", "pageCount", "q", "rows", "status", "total"]);
    assert.deepEqual(keys(v.rows[0]), ["cancel", "currency", "customerName", "id", "influencer", "lastError", "paidMinor", "serviceTitle", "startTime", "status"]);
    assertNoSecretKeys(v);
  }
  // By name (any case) and by booking id (exactly).
  assert.deepEqual(idsOf(await load(`rc searchb ${run}`)), [b.bookingId]);
  assert.deepEqual(idsOf(await load(`RC SEARCHB ${run}`)), [b.bookingId]);
  assert.deepEqual(idsOf(await load(c.bookingId)), [c.bookingId], "a booking id");
  assert.deepEqual(idsOf(await load(`  ${c.bookingId}  `)), [c.bookingId], "trimmed");
  assert.deepEqual(idsOf(await load(c.bookingId.slice(0, -2))), [], "a part of an id is not an id");
  // Together with a status tab; and everything of this run.
  assert.deepEqual(idsOf(await load(`searchc-${run}`, "FAILED")), [c.bookingId]);
  assert.deepEqual(idsOf(await load(`searchc-${run}`, "SCHEDULED")), [], "the search and the tab both apply");
  assert.deepEqual(idsOf(await load(`searcha-${run}`, "SCHEDULED")), [a.bookingId]);
  assert.ok((await load(`-${run}@example.com`)).total >= 3, "everything of this run matches its own e-mail suffix");
  // Odd text is just a search: nothing found, no error; the echo is trimmed and cut to 120 characters.
  for (const q of ["%", "_", "\\", "' OR 1=1 --", "<script>", "a".repeat(500), "%" + "_".repeat(100)]) {
    const v = await load(q);
    assert.ok(Array.isArray(v.rows), q);
    assert.ok(v.q.length <= 120);
  }
  assert.equal((await load("   ")).q, "");
  assert.equal((await load(null)).q, "");
  assert.equal((await load("x".repeat(300))).q.length, 120);

  // The Cancel button's decision, per row.
  const rowOf = async (kind: string) => (await load(`${kind}-${run}`)).rows[0];
  assert.deepEqual((await rowOf("searcha")).cancel, { allowed: true, reason: null });
  assert.deepEqual((await rowOf("searchb")).cancel, { allowed: false, reason: "This session has already taken place; refund the payment instead." });
  assert.deepEqual((await rowOf("searchc")).cancel, { allowed: true, reason: null });
  assert.equal((await rowOf("searcha")).paidMinor, 100_000);
});

test("bookings endpoint: `q` reaches the view (and nothing else changes: still behind the full admin gate)", { skip }, async () => {
  const a = await seedPayment("endpointq", { bookingStatus: "SCHEDULED", startOffsetMs: 5 * DAY });
  const get = async (query: string, cookie?: string) => {
    jar.clear();
    if (cookie !== undefined) jar.set(sessionLib.adminCookieName(), cookie);
    const res = await bookingsRoute(new Request(`http://localhost/api/admin/bookings${query}`));
    return { status: res.status, body: (await res.json()) as Record<string, unknown>, headers: res.headers };
  };
  assert.equal((await get(`?q=${encodeURIComponent(a.bookingId)}`)).status, 401);
  assert.equal((await get(`?q=x`, await passwordOnlySession(X))).status, 403);
  const plain = await sessionLib.createAdminSession(Y);
  const out = await get(`?q=${encodeURIComponent(`rc-endpointq-${run}@EXAMPLE.com`)}`, plain);
  assert.equal(out.status, 200);
  assert.equal(out.headers.get("cache-control"), "private, no-store");
  assert.equal(out.body.q, `rc-endpointq-${run}@EXAMPLE.com`);
  assert.deepEqual((out.body.rows as { id: string }[]).map((r) => r.id), [a.bookingId]);
  assertNoSecretKeys(out.body);
});

/* ---------- review fixes: payout / refund race, amount check, unknown outcome, platform cancel, submitted ---------- */

/** An influencer of its own with verified payout details, so createPayout can run without touching the payments of the other tests. */
async function seedPayableInfluencer() {
  const inf = await prisma.influencer.create({ data: { slug: slug2, name: `RC Two ${run}`, email: `rc-two-${run}@example.com`, notifyByEmail: false } });
  const svc = await prisma.service.create({ data: { influencerId: inf.id, title: `RC two call ${run}`, durationMin: 30, priceMinor: 100_000 } });
  await prisma.payoutAccount.create({ data: { influencerId: inf.id, method: "UPI", accountHolderName: "RC Two", upiIdMasked: "****1234", status: "VERIFIED" } });
  let n = 0;
  /** A payment that is payable now: reconciled, captured, a session that ended well over the hold period ago. */
  const payable = async (kind: string) => {
    const start = new Date(Date.now() - (12 + n++) * DAY);
    const session = await prisma.session.create({ data: { serviceId: svc.id, startTime: start, endTime: new Date(start.getTime() + 30 * 60_000) } });
    const booking = await prisma.booking.create({ data: { sessionId: session.id, status: "COMPLETED", customerName: `RC2 ${kind} ${run}`, customerEmail: `rc2-${kind}-${run}@example.com`, whatsappE164: "+910000000000" } });
    return prisma.payment.create({
      data: { bookingId: booking.id, providerOrderId: `order_${run}_rc2${kind}`, providerPaymentId: `pay_${run}_rc2${kind}`, amountMinor: 100_000, currency: "INR", status: "CAPTURED", reconciledAt: new Date(), reconciledByEmail: emailY },
    });
  };
  return { influencerId: inf.id, payable };
}

test("race, refund second: a payout locks the payment AFTER the refund's eligibility read; the claim refuses and nothing reaches Razorpay", { skip }, async () => {
  const two = await seedPayableInfluencer();
  const payment = await two.payable("a");
  const { createPayout } = await import("../lib/payouts");
  const { refundPayment } = await import("../lib/refunds");
  razorpayCalls.length = 0;
  razorpay = ok();
  let payoutId = "";
  // The administrator's eligibility read passed (no payout yet); then another administrator creates the payout; then the claim is taken.
  const out = await refundLib.adminRefundPayment(payment.id, actor(), "Customer asked for it", null, {
    refund: async (id, opts) => {
      payoutId = (await createPayout(two.influencerId, "INR", emailX)).id;
      return refundPayment(id, opts);
    },
  });
  assert.deepEqual(out, { kind: "not-allowed", reason: "This payment is in a pending payout. Cancel that payout first." });
  assert.equal(razorpayCalls.length, 0, "Razorpay was never called");
  const row = await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
  assert.deepEqual([row.payoutId, row.refundStatus, row.refundAmountMinor, row.status], [payoutId, null, null, "CAPTURED"], "the payout keeps the payment; no refund claim was left behind");
  assert.deepEqual((await auditOf("payment", payment.id)).map((t) => t.action), ["payment.refund_requested", "payment.refund_refused"]);
  // Other callers of refundPayment (the influencer's dashboard, auto refund on cancel) are unchanged: no option, no new check.
  const influencerRefund = await refundPayment(payment.id, { reason: "influencer path" });
  assert.equal(influencerRefund.fullyRefunded, true);
  assert.equal(razorpayCalls.length, 1);
});

test("race, payout second: a refund is claimed AFTER the payout read the payment; the payout's claim finds it changed and fails with 409, nothing is locked", { skip }, async () => {
  const two = await seedPayableInfluencer().catch(async () => ({ influencerId: (await prisma.influencer.findUniqueOrThrow({ where: { slug: slug2 } })).id, payable: null as never }));
  const { createPayout, PayoutError } = await import("../lib/payouts");
  const { refundPayment } = await import("../lib/refunds");
  const mk = async (kind: string) => {
    const svc = await prisma.service.findFirstOrThrow({ where: { influencerId: two.influencerId } });
    const start = new Date(Date.now() - (30 + counter++) * DAY);
    const session = await prisma.session.create({ data: { serviceId: svc.id, startTime: start, endTime: new Date(start.getTime() + 30 * 60_000) } });
    const booking = await prisma.booking.create({ data: { sessionId: session.id, status: "COMPLETED", customerName: `RC2 ${kind} ${run}`, customerEmail: `rc2-${kind}-${run}@example.com`, whatsappE164: "+910000000000" } });
    return prisma.payment.create({
      data: { bookingId: booking.id, providerOrderId: `order_${run}_rc2${kind}`, providerPaymentId: `pay_${run}_rc2${kind}`, amountMinor: 100_000, currency: "INR", status: "CAPTURED", reconciledAt: new Date(), reconciledByEmail: emailY },
    });
  };
  razorpayCalls.length = 0;
  razorpay = ok();
  const payoutsBefore = await prisma.payout.count({ where: { influencerId: two.influencerId } }); // the one the first race test left

  // (1) The administrator's claim lands between the payout's read and its claim and the refund is still in flight.
  const inFlight = await mk("inflight");
  await assert.rejects(
    createPayout(two.influencerId, "INR", emailX, new Date(), {
      afterRead: async () => {
        await prisma.payment.updateMany({ where: { id: inFlight.id }, data: { refundStatus: "requested" } });
      },
    }),
    (e: unknown) => e instanceof PayoutError && (e as { status: number }).status === 409,
  );
  const stuck = await prisma.payment.findUniqueOrThrow({ where: { id: inFlight.id } });
  assert.equal(stuck.payoutId, null, "not locked into a payout");
  assert.equal(await prisma.payout.count({ where: { influencerId: two.influencerId } }), payoutsBefore, "the payout was rolled back");
  await prisma.payment.update({ where: { id: inFlight.id }, data: { refundStatus: null } });

  // (2) The whole refund goes through between the read and the claim: the refund total changed.
  await assert.rejects(
    createPayout(two.influencerId, "INR", emailX, new Date(), {
      afterRead: async () => {
        await refundPayment(inFlight.id, { reason: "interleaved" });
      },
    }),
    (e: unknown) => e instanceof PayoutError && (e as { status: number }).status === 409,
  );
  assert.equal(razorpayCalls.length, 1, "the interleaved refund did go to the stand-in once");
  assert.equal((await prisma.payment.findUniqueOrThrow({ where: { id: inFlight.id } })).payoutId, null);
  assert.equal(await prisma.payout.count({ where: { influencerId: two.influencerId } }), payoutsBefore);

  // (3) A partial refund between read and claim changes the total too (a snapshot of the old refunds would be wrong).
  const partial = await mk("partialrace");
  await assert.rejects(
    createPayout(two.influencerId, "INR", emailX, new Date(), {
      afterRead: async () => {
        await refundPayment(partial.id, { amountMinor: 30_000, reason: "interleaved partial" });
      },
    }),
    (e: unknown) => e instanceof PayoutError && (e as { status: number }).status === 409,
  );
  assert.equal((await prisma.payment.findUniqueOrThrow({ where: { id: partial.id } })).payoutId, null);

  // Without any interleaving the payout is created and includes the partly refunded payment net of its refund (the claim does not break normal use).
  const done = await createPayout(two.influencerId, "INR", emailX);
  assert.equal(done.paymentCount, 1, "only the partly refunded payment is payable now (the other is fully refunded)");
  assert.equal(done.refundsMinor, 30_000);
  assert.equal((await prisma.payment.findUniqueOrThrow({ where: { id: partial.id } })).payoutId, done.id);
});

test("amount check: expectedRemainingMinor is only a check, never the amount; a different amount is 'amount-changed' and nothing is sent", { skip }, async () => {
  const { paymentId } = await seedPayment("expect", { payment: { refundAmountMinor: 30_000, refundStatus: "processed" }, refunds: [{ amountMinor: 30_000, status: "processed" }] });
  razorpayCalls.length = 0;
  razorpay = ok();
  // The page showed the whole 100,000 but 30,000 was refunded since: refused before the audit entry and Razorpay.
  assert.deepEqual(await refundLib.adminRefundPayment(paymentId, actor(), "Reason is long enough", null, {}, new Date(), 100_000), { kind: "amount-changed" });
  assert.equal(razorpayCalls.length, 0);
  assert.deepEqual(await auditOf("payment", paymentId), []);
  // The same check inside refundPayment (another refund lands between the page's read and the click's read).
  const out = await refundLib.adminRefundPayment(paymentId, actor(), "Reason is long enough", null, {
    refund: async (id, opts) => {
      await prisma.payment.update({ where: { id }, data: { refundAmountMinor: 50_000 } });
      const { refundPayment } = await import("../lib/refunds");
      return refundPayment(id, opts);
    },
  }, new Date(), 70_000);
  assert.deepEqual(out, { kind: "amount-changed" });
  assert.equal(razorpayCalls.length, 0);
  assert.deepEqual((await auditOf("payment", paymentId)).map((t) => t.action), ["payment.refund_requested", "payment.refund_refused"]);
  assert.equal((await prisma.payment.findUniqueOrThrow({ where: { id: paymentId } })).refundStatus, "processed", "no claim left behind");
  await prisma.payment.update({ where: { id: paymentId }, data: { refundAmountMinor: 30_000 } });
  // Right amount: refunds exactly what is left (70,000), whatever else the body said.
  assert.equal((await refundLib.adminRefundPayment(paymentId, actor(), "Reason is long enough", null, {}, new Date(), 70_000)).kind, "ok");
  assert.equal(razorpayCalls[0].amountMinor, 70_000);
});

test("refund route: a wrong expected amount is 409 amount-changed; an unexpected fault after the claim is a JSON 500 'outcome-unknown' and the payment stays locked", { skip }, async () => {
  const plain = await sessionLib.createAdminSession(Y);
  razorpayCalls.length = 0;
  razorpay = ok();
  const a = await seedPayment("routeexpect");
  const wrong = await post(refundRoute, a.paymentId, { reason: "Reason is long enough", confirm: true, expectedRemainingMinor: 99_999 }, plain);
  assert.equal(wrong.status, 409);
  assert.deepEqual(wrong.body, { error: "The amount left to refund changed. Reload the page and check it again.", code: "amount-changed" });
  assert.equal(razorpayCalls.length, 0);

  // A fault after the money call (here: Razorpay's answer carries no refund id, so recording it fails): Razorpay may have the refund.
  const b = await seedPayment("routeunknown");
  razorpay = async (input) => ({ id: null as never, payment_id: input.providerPaymentId, amount: input.amountMinor ?? 0, currency: "INR", status: "processed" });
  const out = await post(refundRoute, b.paymentId, { reason: "Reason is long enough", confirm: true, expectedRemainingMinor: 100_000 }, plain);
  assert.equal(out.status, 500);
  assert.deepEqual(out.body, { error: "outcome-unknown" });
  assert.equal(razorpayCalls.length, 1, "Razorpay was called once");
  assert.equal((await prisma.payment.findUniqueOrThrow({ where: { id: b.paymentId } })).refundStatus, "requested", "locked until it is checked");
  assert.deepEqual((await auditOf("payment", b.paymentId)).map((t) => t.action), ["payment.refund_requested", "payment.refund_unconfirmed"]);
  const again = await post(refundRoute, b.paymentId, { reason: "Reason is long enough", confirm: true, expectedRemainingMinor: 100_000 }, plain);
  assert.equal(again.status, 409, "a retry is refused while it is unconfirmed");
  assert.equal(razorpayCalls.length, 1);
});

test("refund failure text: a 5xx is 'Outcome unknown' (with or without a body), 502 and 409 keep their sentence, amount-changed says to check again", async () => {
  const { refundFailureMessage } = await import("../web/src/components/admin/RefundAction");
  assert.match(refundFailureMessage(500, {}), /^Outcome unknown: check this payment before retrying/);
  assert.match(refundFailureMessage(500, { error: "outcome-unknown" }), /^Outcome unknown/);
  assert.match(refundFailureMessage(503, {}), /^Outcome unknown/);
  assert.equal(refundFailureMessage(502, { error: "Razorpay refund failed (400): bad" }), "Razorpay refund failed (400): bad");
  assert.equal(refundFailureMessage(409, { error: "This payment was already refunded in full." }), "This payment was already refunded in full.");
  assert.match(refundFailureMessage(409, { code: "amount-changed", error: "x" }), /amount left to refund changed/);
  assert.equal(refundFailureMessage(400, {}), "The refund did not go through.");
});

test("audit: a refund Razorpay has only accepted (status pending) is recorded as payment.refund_submitted, a processed one as payment.refunded", { skip }, async () => {
  const a = await seedPayment("submitted");
  const b = await seedPayment("processedone");
  const fake = (status: string) => async (id: string) => ({ refundId: "rfnd_x", status, amountMinor: 100_000, fullyRefunded: true }) as never;
  await refundLib.adminRefundPayment(a.paymentId, actor(), "Reason is long enough", null, { refund: fake("pending") });
  await refundLib.adminRefundPayment(b.paymentId, actor(), "Reason is long enough", null, { refund: fake("processed") });
  assert.deepEqual((await auditOf("payment", a.paymentId)).map((t) => t.action), ["payment.refund_requested", "payment.refund_submitted"]);
  assert.deepEqual((await auditOf("payment", b.paymentId)).map((t) => t.action), ["payment.refund_requested", "payment.refunded"]);
});

test("platform cancel with the REAL cancelBooking (Google, e-mail, queue and Razorpay stand-ins): one alert only, a correct refund note, the payment flagged", { skip }, async () => {
  const sent: { kind: string; opts: { refundNote?: string | null } | undefined }[] = [];
  const queued: string[] = [];
  const hostAlerts: { kind: string; detail: string }[] = [];
  const refunds: string[] = [];
  const deps = (refundImpl?: () => Promise<unknown>) => ({
    google: {} as never,
    enqueueSendMessage: async (id: string) => void queued.push(id),
    sendBookingEmail: (async (_id: string, kind: string, opts?: { refundNote?: string | null }) => void sent.push({ kind, opts })) as never,
    alert: (async (_inf: string, a: { kind: string; detail: string }) => void hostAlerts.push({ kind: a.kind, detail: a.detail })) as never,
    cancelReminders: async () => {},
    enqueueReminders: async () => {},
    rearmMessage: async () => {},
    refundPayment: (async (id: string) => {
      refunds.push(id);
      return refundImpl ? refundImpl() : { refundId: "rfnd_x", status: "processed" };
    }) as never,
  });
  const run1 = async (kind: string, refundImpl?: () => Promise<unknown>) => {
    const s = await seedPayment(kind, { bookingStatus: "SCHEDULED", startOffsetMs: 6 * DAY });
    sent.length = 0; queued.length = 0; hostAlerts.length = 0; refunds.length = 0;
    const d = deps(refundImpl);
    const out = await cancelLib.adminCancelBooking(s.bookingId, actor(), "Influencer suspended", null, { cancel: (id, opts) => realCancelBooking(id, opts, d), alert: d.alert });
    return { s, out };
  };

  // AUTO_REFUND_ON_CANCEL=false: the payment is flagged for the administrator; the host is told only that the platform cancelled.
  process.env.AUTO_REFUND_ON_CANCEL = "false";
  const manual = await run1("realcancel1");
  assert.equal(manual.out.kind, "ok");
  assert.deepEqual(hostAlerts.map((a) => a.kind), ["platform-cancelled"], "no 'refund-needed' alert: the host is not asked to refund");
  assert.match(hostAlerts[0].detail, /The platform will refund the customer; you do not need to do anything/);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].kind, "booking-cancelled");
  assert.equal(sent[0].opts?.refundNote, "You are due a full refund. We will issue it to your original payment method.", "the customer is not told the host will refund");
  assert.equal(refunds.length, 0);
  const row = await prisma.payment.findUniqueOrThrow({ where: { id: manual.s.paymentId } });
  assert.equal(row.needsRefund, true, "flagged for the administrator's refund");
  assert.match(row.failureReason ?? "", /Cancelled by the platform: Influencer suspended/);
  assert.equal((await prisma.booking.findUniqueOrThrow({ where: { id: manual.s.bookingId } })).status, "CANCELLED");
  assert.equal(manual.out.kind === "ok" && manual.out.refund.issued, "no");

  // AUTO_REFUND_ON_CANCEL=true: refunded at once, the customer is told so, still one alert for the host.
  process.env.AUTO_REFUND_ON_CANCEL = "true";
  const auto = await run1("realcancel2");
  assert.deepEqual(hostAlerts.map((a) => a.kind), ["platform-cancelled"]);
  assert.deepEqual(refunds, [auto.s.paymentId]);
  assert.match(sent[0].opts?.refundNote ?? "", /Your refund has been issued/);
  assert.equal(auto.out.kind === "ok" && auto.out.refund.issued, "yes");

  // An automatic refund that fails: no 'refund-failed' alert to the host either (the payment stays flagged for the administrator).
  const failing = await run1("realcancel3", async () => {
    throw new Error("Razorpay refund failed (400): bad");
  });
  assert.deepEqual(hostAlerts.map((a) => a.kind), ["platform-cancelled"]);
  assert.equal(failing.out.kind === "ok" && failing.out.refund.issued, "no");
  assert.equal((await prisma.payment.findUniqueOrThrow({ where: { id: failing.s.paymentId } })).needsRefund, true);

  // The influencer's own cancel is unchanged: the host is asked to refund and the customer is told the host will.
  process.env.AUTO_REFUND_ON_CANCEL = "false";
  const own = await seedPayment("realcancel4", { bookingStatus: "SCHEDULED", startOffsetMs: 6 * DAY });
  sent.length = 0; hostAlerts.length = 0;
  await realCancelBooking(own.bookingId, { actor: "influencer" }, deps());
  assert.deepEqual(hostAlerts.map((a) => a.kind), ["refund-needed"]);
  assert.match(sent[0].opts?.refundNote ?? "", /The host has been notified and will issue it/);
});
