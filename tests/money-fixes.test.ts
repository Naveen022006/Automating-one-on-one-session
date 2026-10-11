// Integration-review money fixes (mk/z-money-fixes), against the database with Razorpay and mail replaced by stand-ins:
//   Z1 a payout cannot be approved or marked paid after a refund touched one of its payments (in flight, made by the influencer, or applied by a
//      webhook), and refundPayment refuses a payment in a PENDING payout for every caller (opt-out aside);
//   Z2 the suspension is part of the approve / mark-paid claim itself; Z3 a customer cannot reschedule with a suspended host (cancel stays);
//   Z4 the old signed-in cancel / reschedule routes are gone; Z5 a platform-cancelled booking keeps `needsRefund` until nothing is left.
// Needs DATABASE_URL, TOKEN_ENCRYPTION_KEY and APP_SECRET (skipped otherwise). Nothing here reaches Razorpay, Google or a mailbox.
import "dotenv/config";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import path from "node:path";
import { after, before, mock, test } from "node:test";
import { prisma } from "../lib/db";

const skip = process.env.DATABASE_URL && process.env.TOKEN_ENCRYPTION_KEY && process.env.APP_SECRET ? false : "DATABASE_URL / TOKEN_ENCRYPTION_KEY / APP_SECRET not set";
const run = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
const DAY = 86_400_000;
const adminA = `zf-a-${run}@example.com`;
const adminB = `zf-b-${run}@example.com`;
const NO_FOUR_EYES = { PAYOUT_FOUR_EYES: "false" } as unknown as NodeJS.ProcessEnv;

type RefundInput = { providerPaymentId: string; amountMinor?: number; receipt?: string };
const razorpayCalls: RefundInput[] = [];
let refundSeq = 0;
let payoutsLib: typeof import("../lib/payouts");
let refundsLib: typeof import("../lib/refunds");
let manageLib: typeof import("../lib/manage");
let setAlertSender: typeof import("../lib/alerts").setAlertSender;
let previousSender: ReturnType<typeof import("../lib/alerts").setAlertSender> | undefined;
let counter = 0;

before(async () => {
  const realPayments = await import("../lib/payments");
  mock.module("@/lib/payments", {
    namedExports: {
      ...realPayments,
      createRefund: async (input: RefundInput) => {
        razorpayCalls.push(input);
        return { id: `rfnd_zf_${run}_${++refundSeq}`, payment_id: input.providerPaymentId, amount: input.amountMinor ?? 0, currency: "INR", status: "processed" };
      },
      listRefunds: async () => {
        throw new Error("listRefunds must not be reached");
      },
    },
  });
  payoutsLib = await import("../lib/payouts");
  refundsLib = await import("../lib/refunds");
  manageLib = await import("../lib/manage");
  const alertsLib = await import("../lib/alerts");
  setAlertSender = alertsLib.setAlertSender;
  previousSender = setAlertSender(async () => {});
});

after(async () => {
  try {
    if (!skip) {
      const where = { influencer: { slug: { startsWith: `zf-${run}` } } };
      for (const [name, step] of [
        ["payouts", () => prisma.payout.deleteMany({ where })],
        ["influencers", () => prisma.influencer.deleteMany({ where: { slug: { startsWith: `zf-${run}` } } })],
      ] as [string, () => Promise<unknown>][]) {
        for (let attempt = 1; attempt <= 2; attempt++) {
          try {
            await step();
            break;
          } catch (e) {
            if (attempt === 2) console.error(`[money-fixes cleanup] ${name} failed:`, e instanceof Error ? e.message : e);
          }
        }
      }
    }
  } finally {
    if (previousSender) setAlertSender(previousSender);
    await prisma.$disconnect().catch(() => {});
  }
});

/** An influencer of its own with verified payout details, so a payout touches only the payments of one test. */
async function influencer() {
  const n = ++counter;
  const inf = await prisma.influencer.create({ data: { slug: `zf-${run}-${n}`, name: `ZF ${n} ${run}`, email: `zf-${n}-${run}@example.com`, notifyByEmail: false } });
  const svc = await prisma.service.create({ data: { influencerId: inf.id, title: `ZF call ${n} ${run}`, durationMin: 30, priceMinor: 100_000 } });
  await prisma.payoutAccount.create({ data: { influencerId: inf.id, method: "UPI", accountHolderName: "ZF", upiIdMasked: "****1234", status: "VERIFIED" } });
  let k = 0;
  /** A payment that is payable now (reconciled, captured, session ended long ago). */
  const payable = async (kind: string, o: { bookingStatus?: string; startOffsetMs?: number; payment?: Record<string, unknown> } = {}) => {
    const start = new Date(Date.now() + (o.startOffsetMs ?? -(12 + k++) * DAY));
    const session = await prisma.session.create({ data: { serviceId: svc.id, startTime: start, endTime: new Date(start.getTime() + 30 * 60_000) } });
    const booking = await prisma.booking.create({
      data: { sessionId: session.id, status: (o.bookingStatus ?? "COMPLETED") as never, customerName: `ZF ${kind} ${run}`, customerEmail: `zf-${kind}-${run}@example.com`, whatsappE164: "+910000000000" },
    });
    const payment = await prisma.payment.create({
      data: {
        bookingId: booking.id,
        providerOrderId: `order_zf_${run}_${kind}`,
        providerPaymentId: `pay_zf_${run}_${kind}`,
        amountMinor: 100_000,
        currency: "INR",
        status: "CAPTURED",
        reconciledAt: new Date(),
        reconciledByEmail: adminA,
        ...o.payment,
      },
    });
    return { payment, booking, session };
  };
  return { id: inf.id, payable };
}

const refuseWith = (code: string, status = 409) => (e: unknown) => e instanceof payoutsLib.PayoutError && e.status === status && e.code === code;

test("Z1 mark paid / approve are refused with 409 refund-in-flight when a payment of the payout has a refund in flight", { skip }, async () => {
  const inf = await influencer();
  const { payment } = await inf.payable("inflight");
  const payout = await payoutsLib.createPayout(inf.id, "INR", adminA);
  // A refund claimed after the payout was created (an in-flight claim, e.g. a webhook-side or older code path that did not check the payout).
  await prisma.payment.update({ where: { id: payment.id }, data: { refundStatus: "requested" } });
  await assert.rejects(payoutsLib.markPayoutPaid(payout.id, "UTR123456", adminB, NO_FOUR_EYES), refuseWith("refund-in-flight"));
  await assert.rejects(payoutsLib.approvePayout(payout.id, adminB), refuseWith("refund-in-flight"));
  await prisma.payment.update({ where: { id: payment.id }, data: { refundStatus: "pending" } });
  await assert.rejects(payoutsLib.markPayoutPaid(payout.id, "UTR123456", adminB, NO_FOUR_EYES), refuseWith("refund-in-flight"));
  const still = await prisma.payout.findUniqueOrThrow({ where: { id: payout.id } });
  assert.deepEqual([still.status, still.approvedAt], ["PENDING", null], "nothing changed");
  // Settled again: the same payout goes through.
  await prisma.payment.update({ where: { id: payment.id }, data: { refundStatus: null } });
  assert.equal((await payoutsLib.approvePayout(payout.id, adminB)).approvedByEmail, adminB);
  assert.equal((await payoutsLib.markPayoutPaid(payout.id, "UTR123456", adminB, NO_FOUR_EYES)).status, "PAID");
});

test("Z1 mark paid / approve are refused when the refund total of the payout's payments no longer matches the payout (a refund applied by webhook)", { skip }, async () => {
  const inf = await influencer();
  const { payment } = await inf.payable("webhook");
  const payout = await payoutsLib.createPayout(inf.id, "INR", adminA);
  assert.equal(payout.refundsMinor, 0);
  // A refund made in the Razorpay dashboard arrives by webhook after the payout was created.
  const applied = await refundsLib.applyRefundWebhook("refund.processed", { id: `rfnd_dash_${run}_1`, payment_id: payment.providerPaymentId!, amount: 30_000 }, async () => {});
  assert.equal(applied, true);
  assert.equal((await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } })).refundAmountMinor, 30_000);
  await assert.rejects(payoutsLib.approvePayout(payout.id, adminB), refuseWith("refund-in-flight"));
  await assert.rejects(payoutsLib.markPayoutPaid(payout.id, "UTR123456", adminB, NO_FOUR_EYES), refuseWith("refund-in-flight"));
  assert.equal((await prisma.payout.findUniqueOrThrow({ where: { id: payout.id } })).status, "PENDING");
  // The administrator cancels and creates the payout again: now it carries the refund and can be paid.
  await payoutsLib.cancelPayout(payout.id, "refunded since");
  const again = await payoutsLib.createPayout(inf.id, "INR", adminA);
  assert.equal(again.refundsMinor, 30_000);
  assert.equal((await payoutsLib.markPayoutPaid(again.id, "UTR654321", adminB, NO_FOUR_EYES)).status, "PAID");
});

test("Z1 a refund that is already done when the payout is created is in its snapshot and does not block it (the interleavings with a refund landing later are the Y5 lock tests)", { skip }, async () => {
  const inf = await influencer();
  const { payment } = await inf.payable("snap");
  await refundsLib.refundPayment(payment.id, { amountMinor: 20_000, reason: "before the payout" });
  const payout = await payoutsLib.createPayout(inf.id, "INR", adminA);
  assert.equal(payout.refundsMinor, 20_000);
  assert.equal((await payoutsLib.markPayoutPaid(payout.id, "UTR111222", adminB, NO_FOUR_EYES)).status, "PAID", "snapshot and payments agree");
});

test("Z1 refundPayment refuses a payment in a PENDING payout for EVERY caller (the influencer's route too); a PAID payout does not block; opt-out exists", { skip }, async () => {
  const inf = await influencer();
  const { payment } = await inf.payable("pendingblock");
  const payout = await payoutsLib.createPayout(inf.id, "INR", adminA);
  razorpayCalls.length = 0;
  // The influencer's own route: ownership scoped, no extra option.
  await assert.rejects(refundsLib.refundPayment(payment.id, { influencerId: inf.id, reason: "from Sessions" }), (e: unknown) =>
    e instanceof refundsLib.RefundNotAllowedError && /part of a payout the platform is preparing/.test(e.message));
  // No option at all (the auto refund on cancel).
  await assert.rejects(refundsLib.refundPayment(payment.id, { reason: "auto" }), refundsLib.RefundNotAllowedError);
  assert.equal(razorpayCalls.length, 0, "nothing reached Razorpay");
  const row = await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
  assert.deepEqual([row.refundStatus, row.refundAmountMinor, row.payoutId], [null, null, payout.id]);
  // The admin message for the admin path is unchanged.
  await assert.rejects(refundsLib.refundPayment(payment.id, { blockPendingPayout: true }), /pending payout\. Cancel that payout first/);
  // Once the payout is paid, the refund is allowed (and shows as money to recover).
  await payoutsLib.markPayoutPaid(payout.id, "UTR333444", adminB, NO_FOUR_EYES);
  const done = await refundsLib.refundPayment(payment.id, { influencerId: inf.id, reason: "after payment" });
  assert.equal(done.fullyRefunded, true);
  assert.equal(await payoutsLib.postPayoutRefunds(payout.id), 100_000);
  // The explicit opt-out for an internal caller that must refund regardless.
  const other = await influencer();
  const o = await other.payable("optout");
  await payoutsLib.createPayout(other.id, "INR", adminA);
  assert.equal((await refundsLib.refundPayment(o.payment.id, { blockPendingPayout: false })).fullyRefunded, true);
});

test("Y1 an influencer cancel with automatic refunds while the payment is in a pending payout: the refund waits, the flag stays, the messages are true, and the payout cannot be approved or paid until recreated", { skip }, async () => {
  const inf = await influencer();
  const { payment, booking } = await inf.payable("autocancel", { bookingStatus: "SCHEDULED", startOffsetMs: 6 * DAY, payment: { reconciledAt: null } });
  // Not payable until the session ends: put it in a pending payout by hand to model "payout created, then the booking is cancelled".
  const payout = await prisma.payout.create({ data: { influencerId: inf.id, currency: "INR", grossMinor: 100_000, refundsMinor: 0, feeBps: 0, feeMinor: 0, netMinor: 100_000, paymentCount: 1, destination: "UPI ****1234", createdByEmail: adminA } });
  await prisma.payment.update({ where: { id: payment.id }, data: { payoutId: payout.id } });
  const saved = process.env.AUTO_REFUND_ON_CANCEL;
  process.env.AUTO_REFUND_ON_CANCEL = "true";
  const alerts: { kind: string; title?: string; detail: string }[] = [];
  const sent: (string | null | undefined)[] = [];
  const noop = async () => {};
  razorpayCalls.length = 0;
  try {
    const result = await manageLib.cancelBooking(booking.id, { actor: "influencer" }, {
      google: {} as never, enqueueSendMessage: noop, cancelReminders: noop, enqueueReminders: noop, rearmMessage: noop,
      sendBookingEmail: (async (_i: string, _k: string, o?: { refundNote?: string | null }) => void sent.push(o?.refundNote)) as never,
      alert: (async (_i: string, a: { kind: string; title?: string; detail: string }) => void alerts.push(a)) as never,
    });
    assert.equal(result.refund.issued, "no");
  } finally {
    if (saved === undefined) delete process.env.AUTO_REFUND_ON_CANCEL;
    else process.env.AUTO_REFUND_ON_CANCEL = saved;
  }
  const row = await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
  assert.deepEqual([row.status, row.needsRefund, row.refundStatus, row.payoutId], ["CAPTURED", true, null, payout.id], "not refunded, still flagged (the Payments page lists it)");
  assert.equal(razorpayCalls.length, 0);
  // The host is told only what is true (it cannot cancel a payout), and the customer is not promised the host's refund.
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].kind, "refund-needed");
  assert.match(alerts[0].detail, /the platform will process the refund once that payout is settled/);
  assert.ok(!/cancel that payout/i.test(alerts[0].detail) && !/Automatic refund failed/.test(alerts[0].detail));
  assert.match(sent[0] ?? "", /The platform will process it to your original payment method as soon as the host's pending payout is settled/);
  assert.ok(!/host has been notified/.test(sent[0] ?? ""));
  // The payout would pay the host for money owed back: it cannot be approved or paid.
  await assert.rejects(payoutsLib.approvePayout(payout.id, adminB), refuseWith("flagged-payment"));
  await assert.rejects(payoutsLib.markPayoutPaid(payout.id, "UTR123456", adminB, NO_FOUR_EYES), refuseWith("flagged-payment"));
  assert.equal((await prisma.payout.findUniqueOrThrow({ where: { id: payout.id } })).status, "PENDING");
  // Cancel and recreate: the flagged payment is left out of the new payout (nothing else is payable here).
  await payoutsLib.cancelPayout(payout.id, "booking cancelled");
  await assert.rejects(payoutsLib.createPayout(inf.id, "INR", adminA), (e: unknown) => e instanceof payoutsLib.PayoutError && /Nothing is payable/.test(e.message));
  // The administrator can now refund it from Payments (no payout blocks it).
  const refunded = await refundsLib.refundPayment(payment.id, { blockPendingPayout: true, reason: "admin" });
  assert.equal(refunded.fullyRefunded, true);
});

test("Y1 a payment flagged for a refund, or on a cancelled booking, is never payable and never lets a payout be approved or paid", { skip }, async () => {
  const inf = await influencer();
  assert.equal(payoutsLib.payoutBlocker({ id: "p", status: "CAPTURED", amountMinor: 100, currency: "INR", refundedMinor: 0, refundStatus: null, reconciledAt: new Date(0), payoutId: null, bookingStatus: "COMPLETED", sessionEnd: new Date(0), needsRefund: true }, new Date(), 2), "flagged-for-refund");
  const flagged = await inf.payable("flaggedpay", { payment: { needsRefund: true } });
  await assert.rejects(payoutsLib.createPayout(inf.id, "INR", adminA), (e: unknown) => e instanceof payoutsLib.PayoutError && /Nothing is payable/.test(e.message), "a flagged payment is not payable");
  await prisma.payment.update({ where: { id: flagged.payment.id }, data: { needsRefund: false } });
  const payout = await payoutsLib.createPayout(inf.id, "INR", adminA);
  // Flagged after the payout was created (a failed refund webhook, a double payment found later).
  await prisma.payment.update({ where: { id: flagged.payment.id }, data: { needsRefund: true } });
  await assert.rejects(payoutsLib.markPayoutPaid(payout.id, "UTR123456", adminB, NO_FOUR_EYES), refuseWith("flagged-payment"));
  await prisma.payment.update({ where: { id: flagged.payment.id }, data: { needsRefund: false } });
  // The booking cancelled after the payout was created.
  await prisma.booking.update({ where: { id: flagged.booking.id }, data: { status: "CANCELLED" } });
  await assert.rejects(payoutsLib.approvePayout(payout.id, adminB), refuseWith("flagged-payment"));
  await prisma.booking.update({ where: { id: flagged.booking.id }, data: { status: "COMPLETED" } });
  assert.equal((await payoutsLib.markPayoutPaid(payout.id, "UTR123456", adminB, NO_FOUR_EYES)).status, "PAID", "settled again: it goes through");
});

/* ---------- Z2 ---------- */

test("Z2 a suspension that lands after the read stops approve / mark paid at the claim (no override); with the override it goes through", { skip }, async () => {
  const inf = await influencer();
  await inf.payable("susp");
  const payout = await payoutsLib.createPayout(inf.id, "INR", adminA);
  // The pre-check read still sees the influencer as active (a suspension committed right after it), the claim sees the truth.
  await prisma.influencer.update({ where: { id: inf.id }, data: { suspendedAt: new Date(), suspendedReason: "test", suspendedByEmail: adminA } });
  const delegate = prisma.influencer as unknown as { findUnique: (a: unknown) => Promise<unknown> };
  const real = delegate.findUnique.bind(delegate);
  delegate.findUnique = async (a: unknown) => (JSON.stringify(a).includes("suspendedAt") ? { suspendedAt: null } : real(a));
  try {
    await assert.rejects(payoutsLib.approvePayout(payout.id, adminB), (e: unknown) => e instanceof payoutsLib.PayoutError && e.status === 409);
    await assert.rejects(payoutsLib.markPayoutPaid(payout.id, "UTR123456", adminB, NO_FOUR_EYES), (e: unknown) => e instanceof payoutsLib.PayoutError && e.status === 409);
  } finally {
    delegate.findUnique = real;
  }
  const still = await prisma.payout.findUniqueOrThrow({ where: { id: payout.id } });
  assert.deepEqual([still.status, still.approvedAt], ["PENDING", null], "nothing changed");
  // Without the stand-in the plain refusal is the suspension one; the acknowledged override pays.
  await assert.rejects(payoutsLib.markPayoutPaid(payout.id, "UTR123456", adminB, NO_FOUR_EYES), refuseWith("influencer-suspended"));
  const paid = await payoutsLib.markPayoutPaid(payout.id, "UTR123456", adminB, NO_FOUR_EYES, { reason: "paid anyway (test)" });
  assert.equal(paid.status, "PAID");
});

/* ---------- Z3 ---------- */

test("Z3 a customer cannot reschedule while the host is suspended (409-kind refusal); cancelling stays allowed", { skip }, async () => {
  const inf = await influencer();
  const { booking } = await inf.payable("resched", { bookingStatus: "SCHEDULED", startOffsetMs: 10 * DAY });
  await prisma.influencer.update({ where: { id: inf.id }, data: { suspendedAt: new Date(), suspendedReason: "test", suspendedByEmail: adminA } });
  const noop = async () => {};
  const deps = { google: {} as never, enqueueSendMessage: noop, sendBookingEmail: noop as never, cancelReminders: noop, enqueueReminders: noop, rearmMessage: noop, alert: noop as never };
  await assert.rejects(
    manageLib.rescheduleBooking(booking.id, new Date(Date.now() + 11 * DAY), deps, { actor: "customer" }),
    (e: unknown) => e instanceof manageLib.BookingNotManageableError && /cannot be moved online\. You can still cancel it/.test(e.message),
  );
  const unchanged = await prisma.booking.findUniqueOrThrow({ where: { id: booking.id }, include: { session: true } });
  assert.equal(unchanged.status, "SCHEDULED");
  const result = await manageLib.cancelBooking(booking.id, { actor: "customer" }, deps);
  assert.equal(result.refund.eligible, true, "the customer can still cancel");
  assert.equal((await prisma.booking.findUniqueOrThrow({ where: { id: booking.id } })).status, "CANCELLED");
});

/* ---------- Z4 ---------- */

test("Z4 the old signed-in cancel / reschedule routes (no activity trail, unused by the SPA) are gone; the dashboard routes remain", () => {
  const root = path.resolve(__dirname, "..");
  for (const rel of ["app/api/bookings/[id]/cancel/route.ts", "app/api/bookings/[id]/reschedule/route.ts"]) assert.equal(existsSync(path.join(root, rel)), false, rel);
  for (const rel of ["app/api/dashboard/bookings/[id]/route.ts", "app/api/dashboard/bookings/[id]/refund/route.ts", "app/api/manage/[token]/route.ts"]) assert.ok(existsSync(path.join(root, rel)), rel);
});

/* ---------- Z5 ---------- */

test("Z5/Y3 a booking cancelled by the platform keeps needsRefund through a partial refund; a host typing the same words gets no platform semantics", { skip }, async () => {
  const noop = async () => {};
  const deps = { google: {} as never, enqueueSendMessage: noop, sendBookingEmail: noop as never, cancelReminders: noop, enqueueReminders: noop, rearmMessage: noop, alert: noop as never };
  const inf = await influencer();
  const platform = await inf.payable("platformcancel", { bookingStatus: "SCHEDULED", startOffsetMs: 6 * DAY, payment: { reconciledAt: null } });
  await manageLib.cancelBooking(platform.booking.id, { actor: "influencer", byPlatform: true, reason: "Cancelled by the platform: Influencer suspended" }, deps);
  let row = await prisma.payment.findUniqueOrThrow({ where: { id: platform.payment.id } });
  assert.ok((row.failureReason ?? "").startsWith(refundsLib.PLATFORM_CANCEL_PREFIX), "the system's own marker, at the start");
  assert.equal(row.needsRefund, true);
  const partial = await refundsLib.refundPayment(platform.payment.id, { amountMinor: 40_000, reason: "influencer partial" });
  assert.equal(partial.fullyRefunded, false);
  row = await prisma.payment.findUniqueOrThrow({ where: { id: platform.payment.id } });
  assert.deepEqual([row.status, row.needsRefund, row.refundAmountMinor], ["CAPTURED", true, 40_000], "still in the attention list: the customer was promised the full refund");
  const rest = await refundsLib.refundPayment(platform.payment.id, { reason: "the rest" });
  assert.equal(rest.fullyRefunded, true);
  row = await prisma.payment.findUniqueOrThrow({ where: { id: platform.payment.id } });
  assert.deepEqual([row.status, row.needsRefund], ["REFUNDED", false]);

  // A host who types the very same words as the reason of their own cancel gets nothing special: a partial refund clears the flag as before.
  const typed = await inf.payable("typedreason", { bookingStatus: "SCHEDULED", startOffsetMs: 6 * DAY, payment: { reconciledAt: null } });
  await manageLib.cancelBooking(typed.booking.id, { actor: "influencer", reason: "Cancelled by the platform: x" }, deps);
  row = await prisma.payment.findUniqueOrThrow({ where: { id: typed.payment.id } });
  assert.ok(!(row.failureReason ?? "").startsWith(refundsLib.PLATFORM_CANCEL_PREFIX), "not marked");
  assert.match(row.failureReason ?? "", /Cancelled by the platform: x/, "the reason is still recorded as text");
  await refundsLib.refundPayment(typed.payment.id, { amountMinor: 40_000, reason: "partial" });
  assert.equal((await prisma.payment.findUniqueOrThrow({ where: { id: typed.payment.id } })).needsRefund, false);
  // Even the sentinel itself typed by a host cannot lead the field: the stored text always starts with "booking ".
  const sneaky = await inf.payable("sneaky", { bookingStatus: "SCHEDULED", startOffsetMs: 6 * DAY, payment: { reconciledAt: null } });
  await manageLib.cancelBooking(sneaky.booking.id, { actor: "influencer", reason: `${refundsLib.PLATFORM_CANCEL_PREFIX}x` }, deps);
  row = await prisma.payment.findUniqueOrThrow({ where: { id: sneaky.payment.id } });
  assert.ok(!(row.failureReason ?? "").startsWith(refundsLib.PLATFORM_CANCEL_PREFIX));
});

/* ---------- Y2 / Y5: lock order and real lock holding ---------- */

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Polls (from inside the transaction that holds a lock, so no extra connection is needed) until another backend is BLOCKED BY this one
 * (pg_blocking_pids). True when it showed up: proof that the other side really queued behind the lock instead of racing past it. (The
 * pooler hides the waiting statement's text, so the blocking relation is what is checked.)
 */
async function waiterSeen(tx: { $queryRaw: <T>(q: TemplateStringsArray, ...v: unknown[]) => Promise<T> }): Promise<boolean> {
  for (let i = 0; i < 200; i++) {
    const rows = await tx.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM pg_stat_activity WHERE pg_backend_pid() = ANY(pg_blocking_pids(pid))`;
    if (rows[0].n > 0) return true;
    await sleep(250);
  }
  return false;
}

for (const action of ["approve", "pay"] as const) {
  test(`Y5 ${action}: while another connection holds a payment row lock (a refund claim / webhook mid-write), the action WAITS, and then sees what the writer committed`, { skip }, async () => {
    const inf = await influencer();
    const { payment } = await inf.payable(`lock${action}`);
    const payout = await payoutsLib.createPayout(inf.id, "INR", adminA);
    let locked!: () => void;
    const lockedP = new Promise<void>((r) => (locked = r));
    let queued = false;
    const holder = prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM payments WHERE id = ${payment.id} FOR UPDATE`;
        locked();
        // Hold the lock until the action's statement is seen WAITING for it (without FOR UPDATE it never queues, this times out and the test fails).
        queued = await waiterSeen(tx);
        // The writer's own change, committed with the lock: a refund of 30,000 lands on the payment.
        await tx.payment.update({ where: { id: payment.id }, data: { refundAmountMinor: 30_000, refundStatus: "processed" } });
      },
      { timeout: 90_000 },
    );
    await lockedP;
    const acting = (action === "approve" ? payoutsLib.approvePayout(payout.id, adminB) : payoutsLib.markPayoutPaid(payout.id, "UTR123456", adminB, NO_FOUR_EYES)).then(
      () => "done" as const,
      (e: unknown) => e,
    );
    await holder;
    assert.equal(queued, true, `${action} queued behind the payment row lock instead of reading past it`);
    const out = await acting;
    assert.ok(out instanceof payoutsLib.PayoutError && out.status === 409 && out.code === "refund-in-flight", `${action}: refused after the refund committed (${String(out)})`);
    const after = await prisma.payout.findUniqueOrThrow({ where: { id: payout.id } });
    assert.deepEqual([after.status, after.approvedAt], ["PENDING", null], "nothing was approved or paid");
  });

  test(`Y2 ${action}: a concurrent cancel (payout row first, then its payments) does not deadlock with it; the loser gets a correct 409`, { skip }, async () => {
    const inf = await influencer();
    await inf.payable(`order${action}`);
    const payout = await payoutsLib.createPayout(inf.id, "INR", adminA);
    let locked!: () => void;
    const lockedP = new Promise<void>((r) => (locked = r));
    let queued = false;
    // The cancel holds the payout row (status already CANCELLED, uncommitted) and has not released the payments yet. It keeps holding until the
    // action's FIRST lock statement (the payout row) is seen waiting; with the old order the action locked the payments first and deadlocked here.
    const cancelling = payoutsLib.cancelPayout(payout.id, "cancelled by an administrator", {
      afterPayoutLocked: async (tx) => {
        locked();
        queued = await waiterSeen(tx as never);
      },
    });
    await lockedP;
    const acting = (action === "approve" ? payoutsLib.approvePayout(payout.id, adminB) : payoutsLib.markPayoutPaid(payout.id, "UTR123456", adminB, NO_FOUR_EYES)).then(
      () => "done" as const,
      (e: unknown) => e,
    );
    await cancelling; // with the old lock order this transaction was the deadlock victim or hung
    assert.equal(queued, true, "the action queued on the payout row first (not on the payments)");
    const out = await acting;
    assert.ok(out instanceof payoutsLib.PayoutError && out.status === 409, `a PayoutError 409, not a server error (${String(out)})`);
    assert.notEqual(out.code, "refund-in-flight", "the cancelled payout is not reported as a refund problem");
    assert.match(out.message, action === "approve" ? /Only a pending payout can be approved/ : /not pending/);
    const after = await prisma.payout.findUniqueOrThrow({ where: { id: payout.id } });
    assert.equal(after.status, "CANCELLED");
  });
}

test("Y2 a deadlock or serialization failure inside a payout transaction is a 409 try-again, other errors pass through", { skip }, async () => {
  // guardConflicts is internal; exercise it through cancelPayout with a hook that raises what Postgres raises.
  const inf = await influencer();
  await inf.payable("guard");
  const payout = await payoutsLib.createPayout(inf.id, "INR", adminA);
  for (const e of [Object.assign(new Error("deadlock detected"), { code: "40P01" }), Object.assign(new Error("x"), { cause: { originalCode: "40001" } }), Object.assign(new Error("Transaction failed due to a write conflict"), { code: "P2034" })]) {
    await assert.rejects(
      payoutsLib.cancelPayout(payout.id, null, { afterPayoutLocked: async () => { throw e; } }),
      (err: unknown) => err instanceof payoutsLib.PayoutError && err.status === 409 && err.code === "try-again",
    );
  }
  await assert.rejects(payoutsLib.cancelPayout(payout.id, null, { afterPayoutLocked: async () => { throw new Error("boom"); } }), /boom/);
  assert.equal((await prisma.payout.findUniqueOrThrow({ where: { id: payout.id } })).status, "PENDING", "every failed attempt rolled back");
});

/* ---------- round 3: M1 / M2 / M3 / M4 / M6 ---------- */

type Sent = { alerts: { kind: string; title?: string; detail: string }[]; notes: (string | null | undefined)[] };
const stubs = (log: Sent) => {
  const noop = async () => {};
  return {
    google: {} as never,
    enqueueSendMessage: noop,
    cancelReminders: noop,
    enqueueReminders: noop,
    rearmMessage: noop,
    sendBookingEmail: (async (_i: string, _k: string, o?: { refundNote?: string | null }) => void log.notes.push(o?.refundNote)) as never,
    alert: (async (_i: string, a: { kind: string; title?: string; detail: string }) => void log.alerts.push(a)) as never,
  };
};
/** A PENDING payout made by hand around the given payments (they are not payable by the rules yet, or their booking was cancelled since). */
async function handPayout(influencerId: string, paymentIds: string[]) {
  const payout = await prisma.payout.create({ data: { influencerId, currency: "INR", grossMinor: 100_000 * paymentIds.length, refundsMinor: 0, feeBps: 0, feeMinor: 0, netMinor: 100_000 * paymentIds.length, paymentCount: paymentIds.length, destination: "UPI ****1234", createdByEmail: adminA } });
  await prisma.payment.updateMany({ where: { id: { in: paymentIds } }, data: { payoutId: payout.id } });
  return payout;
}

for (const auto of [false, true]) {
  test(`M1 host cancel after the session, automatic refunds ${auto ? "ON" : "OFF"}: a payment in a pending payout is not sent to the host to refund; the payout is flagged and cannot be paid`, { skip }, async () => {
    const inf = await influencer();
    // A session in the past that was never marked COMPLETED: the host can still cancel it.
    const { payment, booking } = await inf.payable(`m1${auto}`, { bookingStatus: "SCHEDULED", startOffsetMs: -3 * DAY });
    const payout = await handPayout(inf.id, [payment.id]);
    const saved = process.env.AUTO_REFUND_ON_CANCEL;
    process.env.AUTO_REFUND_ON_CANCEL = auto ? "true" : "false";
    const log: Sent = { alerts: [], notes: [] };
    razorpayCalls.length = 0;
    try {
      const result = await manageLib.cancelBooking(booking.id, { actor: "influencer" }, stubs(log));
      assert.equal(result.refund.issued, "no");
      assert.equal(result.refund.eligible, true);
    } finally {
      if (saved === undefined) delete process.env.AUTO_REFUND_ON_CANCEL;
      else process.env.AUTO_REFUND_ON_CANCEL = saved;
    }
    // The host is told what is true; nobody tells it to refund something it cannot refund.
    assert.equal(log.alerts.length, 1);
    assert.equal(log.alerts[0].title, "A refund is waiting for a payout");
    assert.ok(!/Issue the refund/.test(log.alerts[0].detail) && /the platform will process the refund once that payout is settled/.test(log.alerts[0].detail));
    assert.match(log.notes[0] ?? "", /The platform will process it to your original payment method as soon as the host's pending payout is settled/);
    assert.ok(!/host has been notified/.test(log.notes[0] ?? ""));
    assert.equal(razorpayCalls.length, 0);
    // The admin-facing signal: still flagged (Payments lists it), the payout page flags the payout, approve / pay are refused.
    const row = await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
    assert.deepEqual([row.needsRefund, row.refundStatus, row.payoutId], [true, null, payout.id]);
    assert.equal((await payoutsLib.flaggedPaymentCounts([payout.id])).get(payout.id), 1);
    await assert.rejects(payoutsLib.markPayoutPaid(payout.id, "UTR123456", adminB, NO_FOUR_EYES), refuseWith("flagged-payment"));
    // The host's own refund attempt is refused with a sentence that does not send it round in circles.
    await assert.rejects(refundsLib.refundPayment(payment.id, { influencerId: inf.id }), (e: unknown) =>
      e instanceof refundsLib.RefundBlockedByPayoutError && /platform is preparing/.test(e.message) && /you do not need to retry/.test(e.message) && !/Try again/.test(e.message));
  });
}

test("M6 a booking with two payments, one held by a pending payout and one refunded: the customer is not told 'issued' alone", { skip }, async () => {
  const inf = await influencer();
  const main = await inf.payable("m6main", { bookingStatus: "SCHEDULED", startOffsetMs: -3 * DAY });
  const dup = await prisma.payment.create({
    data: { bookingId: main.booking.id, providerOrderId: `order_zf_${run}_m6dup`, providerPaymentId: `pay_zf_${run}_m6dup`, amountMinor: 100_000, currency: "INR", status: "CAPTURED" },
  });
  await handPayout(inf.id, [main.payment.id]);
  const saved = process.env.AUTO_REFUND_ON_CANCEL;
  process.env.AUTO_REFUND_ON_CANCEL = "true";
  const log: Sent = { alerts: [], notes: [] };
  razorpayCalls.length = 0;
  try {
    const result = await manageLib.cancelBooking(main.booking.id, { actor: "influencer" }, { ...stubs(log), refundPayment: async (id: string) => refundsLib.refundPayment(id, { reason: "auto" }) } as never);
    assert.equal(result.refund.issued, "yes", "the duplicate was refunded");
  } finally {
    if (saved === undefined) delete process.env.AUTO_REFUND_ON_CANCEL;
    else process.env.AUTO_REFUND_ON_CANCEL = saved;
  }
  assert.equal(razorpayCalls.length, 1, "only the free payment went to Razorpay");
  assert.equal((await prisma.payment.findUniqueOrThrow({ where: { id: dup.id } })).status, "REFUNDED");
  assert.match(log.notes[0] ?? "", /^Part of your refund has been sent to your original payment method\. The rest is due as well\. The platform will process it/);
  assert.ok(!/^Your refund has been issued/.test(log.notes[0] ?? ""));
  assert.equal((await prisma.payment.findUniqueOrThrow({ where: { id: main.payment.id } })).needsRefund, true);
});

test("M2 cancelling a payout returns the flagged payments it released (and none when nothing is flagged)", { skip }, async () => {
  const inf = await influencer();
  const clean = await inf.payable("m2clean", { bookingStatus: "COMPLETED" });
  const flagged = await inf.payable("m2flag", { bookingStatus: "COMPLETED", payment: { needsRefund: true } });
  const cancelledBooking = await inf.payable("m2cancelled", { bookingStatus: "CANCELLED" });
  const payout = await handPayout(inf.id, [clean.payment.id, flagged.payment.id, cancelledBooking.payment.id]);
  assert.equal((await payoutsLib.flaggedPaymentCounts([payout.id])).get(payout.id), 2);
  const out = await payoutsLib.cancelPayout(payout.id, "test");
  assert.deepEqual([...out.flaggedPaymentIds].sort(), [flagged.payment.id, cancelledBooking.payment.id].sort());
  assert.equal((await prisma.payment.findUniqueOrThrow({ where: { id: flagged.payment.id } })).payoutId, null, "released");
  // A payout of unflagged payments reports none.
  const other = await influencer();
  await other.payable("m2ok");
  const fine = await payoutsLib.createPayout(other.id, "INR", adminA);
  assert.deepEqual((await payoutsLib.cancelPayout(fine.id, null)).flaggedPaymentIds, []);
  assert.equal((await payoutsLib.flaggedPaymentCounts([])).size, 0);
});

test("M2 the flagged-payment refusal tells the administrator what to do", { skip }, async () => {
  const inf = await influencer();
  const f = await inf.payable("m2msg", { bookingStatus: "COMPLETED" });
  const payout = await payoutsLib.createPayout(inf.id, "INR", adminA);
  await prisma.payment.update({ where: { id: f.payment.id }, data: { needsRefund: true } });
  await assert.rejects(payoutsLib.markPayoutPaid(payout.id, "UTR123456", adminB, NO_FOUR_EYES), (e: unknown) =>
    e instanceof payoutsLib.PayoutError && e.code === "flagged-payment" && /Cancel this payout, refund the flagged payment from Payments \(Needs refund tab\), then create the payout again/.test(e.message));
});

test("M3 a cancel that lands between createPayout's read and its claim keeps the payment out: 409 and nothing locked", { skip }, async () => {
  const inf = await influencer();
  const p = await inf.payable("m3");
  await assert.rejects(
    payoutsLib.createPayout(inf.id, "INR", adminA, new Date(), {
      afterRead: async () => {
        // What a cancel does: the booking is cancelled and the payment flagged.
        await prisma.booking.update({ where: { id: p.booking.id }, data: { status: "CANCELLED" } });
        await prisma.payment.update({ where: { id: p.payment.id }, data: { needsRefund: true } });
      },
    }),
    (e: unknown) => e instanceof payoutsLib.PayoutError && e.status === 409,
  );
  assert.equal((await prisma.payment.findUniqueOrThrow({ where: { id: p.payment.id } })).payoutId, null);
  assert.equal(await prisma.payout.count({ where: { influencerId: inf.id } }), 0, "rolled back");
  // Each half alone is enough: only the booking status ...
  const q = await inf.payable("m3b");
  await assert.rejects(
    payoutsLib.createPayout(inf.id, "INR", adminA, new Date(), { afterRead: async () => void (await prisma.booking.update({ where: { id: q.booking.id }, data: { status: "CANCELLED" } })) }),
    (e: unknown) => e instanceof payoutsLib.PayoutError && e.status === 409,
  );
  // ... or only the flag.
  await prisma.booking.update({ where: { id: q.booking.id }, data: { status: "COMPLETED" } });
  await assert.rejects(
    payoutsLib.createPayout(inf.id, "INR", adminA, new Date(), { afterRead: async () => void (await prisma.payment.update({ where: { id: q.payment.id }, data: { needsRefund: true } })) }),
    (e: unknown) => e instanceof payoutsLib.PayoutError && e.status === 409,
  );
});

test("M4 the host's booking detail never shows the platform-cancel marker (the rest of the reason stays)", { skip }, async () => {
  const inf = await influencer();
  const p = await inf.payable("m4", { bookingStatus: "SCHEDULED", startOffsetMs: 6 * DAY, payment: { reconciledAt: null } });
  await manageLib.cancelBooking(p.booking.id, { actor: "influencer", byPlatform: true, reason: "Cancelled by the platform: Influencer suspended" }, stubs({ alerts: [], notes: [] }));
  assert.ok(((await prisma.payment.findUniqueOrThrow({ where: { id: p.payment.id } })).failureReason ?? "").startsWith(refundsLib.PLATFORM_CANCEL_PREFIX), "stored with the marker");
  const { getBookingDetail } = await import("../lib/dashboard-data");
  const detail = await getBookingDetail(inf.id, p.booking.id);
  const reason = detail!.payments[0].failureReason ?? "";
  assert.ok(!reason.includes("[platform-cancel]") && !reason.startsWith(refundsLib.PLATFORM_CANCEL_PREFIX), reason);
  assert.match(reason, /^booking .*Cancelled by the platform: Influencer suspended/);
});
