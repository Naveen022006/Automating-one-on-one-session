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

test("Z1 interleaving: a refund that is already done when the payout is created is in its snapshot and does not block it; one that lands after blocks it", { skip }, async () => {
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
    e instanceof refundsLib.RefundNotAllowedError && e.message === "This payment is part of a payout being prepared. Try again once that payout is paid or cancelled.");
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

test("Z1 the customer-cancel auto refund on a payment in a pending payout fails closed: the payment stays flagged for the administrator", { skip }, async () => {
  const inf = await influencer();
  const { payment, booking } = await inf.payable("autocancel", { bookingStatus: "SCHEDULED", startOffsetMs: 6 * DAY, payment: { reconciledAt: null } });
  // Not payable until the session ends: put it in a pending payout by hand to model "payout created, then the booking is cancelled".
  const payout = await prisma.payout.create({ data: { influencerId: inf.id, currency: "INR", grossMinor: 100_000, refundsMinor: 0, feeBps: 0, feeMinor: 0, netMinor: 100_000, paymentCount: 1, destination: "UPI ****1234", createdByEmail: adminA } });
  await prisma.payment.update({ where: { id: payment.id }, data: { payoutId: payout.id } });
  const saved = process.env.AUTO_REFUND_ON_CANCEL;
  process.env.AUTO_REFUND_ON_CANCEL = "true";
  const alerts: string[] = [];
  const noop = async () => {};
  try {
    await manageLib.cancelBooking(booking.id, { actor: "influencer" }, {
      google: {} as never, enqueueSendMessage: noop, sendBookingEmail: noop as never, cancelReminders: noop, enqueueReminders: noop, rearmMessage: noop,
      alert: (async (_i: string, a: { kind: string }) => void alerts.push(a.kind)) as never,
    });
  } finally {
    if (saved === undefined) delete process.env.AUTO_REFUND_ON_CANCEL;
    else process.env.AUTO_REFUND_ON_CANCEL = saved;
  }
  const row = await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
  assert.deepEqual([row.status, row.needsRefund, row.refundStatus], ["CAPTURED", true, null], "not refunded, flagged for a human");
  assert.deepEqual(alerts, ["refund-failed"], "the host is told the automatic refund failed");
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

test("Z5 a booking cancelled by the platform keeps needsRefund through a partial refund and clears it when nothing is left; other payments clear it as before", { skip }, async () => {
  const inf = await influencer();
  const platform = await inf.payable("platformcancel", { bookingStatus: "CANCELLED", payment: { needsRefund: true, failureReason: `booking cancelled by the host: ${"Cancelled by the platform:"} Influencer suspended`, reconciledAt: null } });
  const partial = await refundsLib.refundPayment(platform.payment.id, { amountMinor: 40_000, reason: "influencer partial" });
  assert.equal(partial.fullyRefunded, false);
  let row = await prisma.payment.findUniqueOrThrow({ where: { id: platform.payment.id } });
  assert.deepEqual([row.status, row.needsRefund, row.refundAmountMinor], ["CAPTURED", true, 40_000], "still in the attention list: the customer was promised the full refund");
  const rest = await refundsLib.refundPayment(platform.payment.id, { reason: "the rest" });
  assert.equal(rest.fullyRefunded, true);
  row = await prisma.payment.findUniqueOrThrow({ where: { id: platform.payment.id } });
  assert.deepEqual([row.status, row.needsRefund], ["REFUNDED", false]);
  // An influencer's own cancellation (no platform mark): a partial refund clears the flag as before.
  const own = await inf.payable("owncancel", { bookingStatus: "CANCELLED", payment: { needsRefund: true, failureReason: "booking cancelled by the host", reconciledAt: null } });
  await refundsLib.refundPayment(own.payment.id, { amountMinor: 40_000, reason: "partial" });
  assert.equal((await prisma.payment.findUniqueOrThrow({ where: { id: own.payment.id } })).needsRefund, false);
  // The constant the platform cancel writes is the one this check looks for.
  assert.equal(refundsLib.PLATFORM_CANCEL_MARK, "Cancelled by the platform:");
});
