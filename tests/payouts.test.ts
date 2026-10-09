import "dotenv/config";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { prisma } from "../lib/db";
import {
  BLOCKER_LABEL,
  buildPayoutTotals,
  cancelPayout,
  checkAgainstRazorpay,
  computeFee,
  createPayout,
  defaultFeeBps,
  effectiveFeeBps,
  influencerPayoutSummary,
  markPayoutPaid,
  payoutBlocker,
  payoutHoldDays,
  postPayoutRefunds,
  reconcilePayments,
  summariseCurrencies,
  loadPayable,
  type PayablePayment,
} from "../lib/payouts";

const NOW = new Date("2026-10-20T12:00:00Z");
const base: PayablePayment = {
  id: "p1",
  status: "CAPTURED",
  amountMinor: 50_000,
  currency: "INR",
  refundedMinor: 0,
  refundStatus: null,
  reconciledAt: new Date("2026-10-10T00:00:00Z"),
  payoutId: null,
  bookingStatus: "SCHEDULED",
  sessionEnd: new Date("2026-10-15T10:00:00Z"),
};

test("a reconciled, finished, unrefunded payment is payable", () => {
  assert.equal(payoutBlocker(base, NOW, 2), null);
});

test("each blocker is reported, in a stable order", () => {
  const b = (patch: Partial<PayablePayment>) => payoutBlocker({ ...base, ...patch }, NOW, 2);
  assert.equal(b({ status: "CREATED" }), "not-paid");
  assert.equal(b({ status: "REFUNDED", refundedMinor: 50_000 }), "fully-refunded");
  assert.equal(b({ payoutId: "po1" }), "in-payout");
  assert.equal(b({ refundStatus: "requested" }), "refund-in-flight");
  assert.equal(b({ refundStatus: "pending" }), "refund-in-flight");
  assert.equal(b({ reconciledAt: null }), "not-reconciled");
  assert.equal(b({ bookingStatus: "PAID" }), "booking-not-held", "paid but the meeting was never created");
  assert.equal(b({ bookingStatus: "CANCELLED" }), "booking-not-held");
  assert.equal(b({ sessionEnd: new Date("2026-10-21T10:00:00Z") }), "session-not-finished", "session is in the future");
  assert.equal(b({ sessionEnd: new Date("2026-10-19T10:00:00Z") }), "session-not-finished", "still inside the 2-day hold");
  assert.equal(b({ sessionEnd: new Date("2026-10-18T11:59:00Z") }), null, "hold period over");
  assert.equal(b({ status: "REFUNDED", refundedMinor: 20_000, refundStatus: "processed" }), null, "partly refunded is still payable (net)");
  for (const label of Object.values(BLOCKER_LABEL)) assert.ok(label.length > 5);
});

test("the fee is floored, applied to the amount after refunds, and never negative", () => {
  assert.equal(computeFee(50_000, 1000), 5_000);
  assert.equal(computeFee(49_999, 1000), 4_999, "fractions of a paisa are not charged");
  assert.equal(computeFee(1, 1000), 0);
  assert.equal(computeFee(50_000, 0), 0);
  const t = buildPayoutTotals(
    [
      { amountMinor: 50_000, refundedMinor: 0 },
      { amountMinor: 20_000, refundedMinor: 5_000 },
    ],
    1000,
  );
  assert.deepEqual(t, { grossMinor: 70_000, refundsMinor: 5_000, feeMinor: 6_500, netMinor: 58_500 });
  assert.equal(t.netMinor + t.feeMinor + t.refundsMinor, t.grossMinor, "every paisa is accounted for");
});

test("configuration: defaults, overrides and out-of-range values", () => {
  assert.equal(payoutHoldDays({} as NodeJS.ProcessEnv), 2);
  assert.equal(payoutHoldDays({ PAYOUT_HOLD_DAYS: "0" } as unknown as NodeJS.ProcessEnv), 0);
  assert.equal(payoutHoldDays({ PAYOUT_HOLD_DAYS: "999" } as unknown as NodeJS.ProcessEnv), 2);
  assert.equal(defaultFeeBps({} as NodeJS.ProcessEnv), 0);
  assert.equal(defaultFeeBps({ PLATFORM_FEE_BPS: "1500" } as unknown as NodeJS.ProcessEnv), 1500);
  assert.equal(defaultFeeBps({ PLATFORM_FEE_BPS: "-5" } as unknown as NodeJS.ProcessEnv), 0);
  assert.equal(effectiveFeeBps(250, { PLATFORM_FEE_BPS: "1000" } as unknown as NodeJS.ProcessEnv), 250, "per-influencer override wins");
  assert.equal(effectiveFeeBps(null, { PLATFORM_FEE_BPS: "1000" } as unknown as NodeJS.ProcessEnv), 1000);
  assert.equal(effectiveFeeBps(0, { PLATFORM_FEE_BPS: "1000" } as unknown as NodeJS.ProcessEnv), 0, "an explicit 0% is respected");
});

test("Razorpay reconciliation compares id, order, amount, currency and status", () => {
  const local = { providerPaymentId: "pay_1", providerOrderId: "order_1", amountMinor: 50_000, currency: "INR" };
  const remote = { id: "pay_1", order_id: "order_1", amount: 50_000, currency: "INR", status: "captured" };
  assert.equal(checkAgainstRazorpay(local, remote).ok, true);
  assert.equal(checkAgainstRazorpay(local, { ...remote, status: "refunded" }).ok, true);
  assert.equal(checkAgainstRazorpay(local, { ...remote, status: "authorized" }).ok, false);
  assert.equal(checkAgainstRazorpay(local, { ...remote, amount: 49_900 }).ok, false);
  assert.equal(checkAgainstRazorpay(local, { ...remote, order_id: "order_2" }).ok, false);
  assert.equal(checkAgainstRazorpay(local, { ...remote, currency: "USD" }).ok, false);
  assert.equal(checkAgainstRazorpay({ ...local, providerPaymentId: null }, remote).ok, false);
});

test("per-currency summary separates ready money from waiting money", () => {
  const row = (patch: Partial<PayablePayment>) => {
    const p = { ...base, ...patch };
    return { ...p, providerPaymentId: "x", providerOrderId: "y", customerName: "c", serviceTitle: "s", sessionStart: p.sessionEnd, blocker: payoutBlocker(p, NOW, 2) };
  };
  const [inr] = summariseCurrencies([row({ id: "a" }), row({ id: "b", reconciledAt: null }), row({ id: "c", amountMinor: 10_000 })], 1000);
  assert.equal(inr.readyCount, 2);
  assert.equal(inr.readyGrossMinor, 60_000);
  assert.equal(inr.readyFeeMinor, 6_000);
  assert.equal(inr.readyMinor, 54_000);
  assert.equal(inr.waitingCount, 1);
  assert.equal(inr.waitingByReason["not-reconciled"], 1);
});

// ---- Integration: the ledger against a real database (skipped without DATABASE_URL) ----
const skip = process.env.DATABASE_URL && process.env.TOKEN_ENCRYPTION_KEY ? false : "DATABASE_URL / TOKEN_ENCRYPTION_KEY not set";
const run = Date.now();
let influencerId: string;
let serviceId: string;
const paymentIds: string[] = [];

async function seedPayment(i: number, patch: { reconciled?: boolean; bookingStatus?: "SCHEDULED" | "PAID"; amount?: number } = {}) {
  const start = new Date(Date.now() - (10 + i) * 86_400_000);
  const session = await prisma.session.create({ data: { serviceId, startTime: start, endTime: new Date(start.getTime() + 30 * 60_000) } });
  const booking = await prisma.booking.create({
    data: {
      sessionId: session.id,
      status: patch.bookingStatus ?? "SCHEDULED",
      customerName: `C${i}`,
      customerEmail: `c${i}-${run}@example.com`,
      whatsappE164: "+919876543210",
    },
  });
  const payment = await prisma.payment.create({
    data: {
      bookingId: booking.id,
      providerOrderId: `order_${run}_${i}`,
      providerPaymentId: `pay_${run}_${i}`,
      amountMinor: patch.amount ?? 50_000,
      currency: "INR",
      status: "CAPTURED",
      reconciledAt: patch.reconciled === false ? null : new Date(),
    },
  });
  paymentIds.push(payment.id);
  return payment;
}

before(async () => {
  if (skip) return;
  const inf = await prisma.influencer.create({ data: { slug: `pl-${run}`, name: "Ledger", email: `pl-${run}@example.com`, platformFeeBps: 1000 } });
  influencerId = inf.id;
  serviceId = (await prisma.service.create({ data: { influencerId, title: "S", durationMin: 30, priceMinor: 50_000 } })).id;
});

after(async () => {
  if (!skip && influencerId) {
    await prisma.payment.updateMany({ where: { id: { in: paymentIds } }, data: { payoutId: null } });
    await prisma.payout.deleteMany({ where: { influencerId } });
    await prisma.influencer.delete({ where: { id: influencerId } });
  }
  await prisma.$disconnect();
});

test("a payout needs verified payout details", { skip }, async () => {
  await seedPayment(1);
  await assert.rejects(createPayout(influencerId, "INR", "admin@example.com"), /payout details/i);
  await prisma.payoutAccount.create({
    data: {
      influencerId,
      accountHolderName: "Ledger",
      bankName: "HDFC Bank",
      ifsc: "HDFC0001234",
      accountNumberEnc: "x",
      accountNumberMasked: "XXXXXXXX9012",
      status: "PENDING_REVIEW",
    },
  });
  await assert.rejects(createPayout(influencerId, "INR", "admin@example.com"), /Verify/i);
  await prisma.payoutAccount.update({ where: { influencerId }, data: { status: "VERIFIED" } });
});

test("only reconciled, finished payments go into a payout; the rest wait", { skip }, async () => {
  await seedPayment(2, { reconciled: false });
  await seedPayment(3, { bookingStatus: "PAID" });
  const rows = await loadPayable(influencerId);
  const byReason = Object.fromEntries(rows.map((r) => [r.blocker ?? "ready", true]));
  assert.ok(byReason["not-reconciled"] && byReason["booking-not-held"] && byReason.ready);

  const payout = await createPayout(influencerId, "INR", "admin@example.com");
  assert.equal(payout.status, "PENDING");
  assert.equal(payout.paymentCount, 1, "only the one ready payment is included");
  assert.equal(payout.grossMinor, 50_000);
  assert.equal(payout.feeMinor, 5_000);
  assert.equal(payout.netMinor, 45_000);
  assert.equal(payout.destination, "HDFC Bank XXXXXXXX9012");
  assert.equal(await prisma.payment.count({ where: { payoutId: payout.id } }), 1);
});

test("the same payments cannot be paid out twice, even concurrently", { skip }, async () => {
  await assert.rejects(createPayout(influencerId, "INR", "admin@example.com"), /Nothing is payable/);
  await seedPayment(4);
  await seedPayment(5);
  const attempts = await Promise.allSettled([createPayout(influencerId, "INR", "a@example.com"), createPayout(influencerId, "INR", "b@example.com")]);
  assert.equal(attempts.filter((a) => a.status === "fulfilled").length, 1, "exactly one payout wins");
  const locked = await prisma.payment.count({ where: { id: { in: paymentIds }, payoutId: { not: null } } });
  assert.equal(locked, 3, "payments 1, 4 and 5 are each in exactly one payout");
});

test("mark paid needs a reference, works once, and cancel releases the payments", { skip }, async () => {
  const pending = await prisma.payout.findFirstOrThrow({ where: { influencerId, status: "PENDING" }, orderBy: { createdAt: "desc" } });
  await assert.rejects(markPayoutPaid(pending.id, "123", "admin@example.com"), /reference/i);
  const paid = await markPayoutPaid(pending.id, "UTR1234567890", "admin@example.com");
  assert.equal(paid.status, "PAID");
  assert.equal(paid.reference, "UTR1234567890");
  await assert.rejects(markPayoutPaid(pending.id, "UTR1234567890", "admin@example.com"), /not pending/);
  await assert.rejects(cancelPayout(pending.id, null), /pending/i);

  await seedPayment(6);
  const second = await createPayout(influencerId, "INR", "admin@example.com");
  await cancelPayout(second.id, "created by mistake");
  assert.equal(await prisma.payment.count({ where: { payoutId: second.id } }), 0, "payments are released");
  assert.equal((await prisma.payout.findUniqueOrThrow({ where: { id: second.id } })).status, "CANCELLED");
  const again = await createPayout(influencerId, "INR", "admin@example.com");
  assert.equal(again.paymentCount, 1, "released payments are payable again");
});

test("a refund made after the payout was paid is reported as money owed back", { skip }, async () => {
  const paid = await prisma.payout.findFirstOrThrow({ where: { influencerId, status: "PAID" } });
  assert.equal(await postPayoutRefunds(paid.id), 0);
  const p = await prisma.payment.findFirstOrThrow({ where: { payoutId: paid.id } });
  await prisma.payment.update({ where: { id: p.id }, data: { refundAmountMinor: 20_000, refundStatus: "processed" } });
  assert.equal(await postPayoutRefunds(paid.id), 20_000);
});

test("influencer summary totals paid, pending, ready and waiting money", { skip }, async () => {
  const s = await influencerPayoutSummary(influencerId);
  assert.equal(s.feeBps, 1000);
  const inr = s.currencies.find((c) => c.currency === "INR");
  assert.ok(inr && inr.paidOutMinor > 0 && inr.pendingMinor > 0);
  assert.ok(s.history.length >= 3);
});

test("reconciliation confirms with Razorpay and refuses mismatches", { skip }, async () => {
  const p = await seedPayment(7, { reconciled: false });
  const remote = (over = {}) => async () => ({ id: `pay_${run}_7`, order_id: `order_${run}_7`, amount: 50_000, currency: "INR", status: "captured", ...over });
  const bad = await reconcilePayments([p.id], "admin@example.com", { fetchPayment: remote({ amount: 1 }) });
  assert.equal(bad[0].ok, false);
  assert.equal((await prisma.payment.findUniqueOrThrow({ where: { id: p.id } })).reconciledAt, null);

  const down = await reconcilePayments([p.id], "admin@example.com", { fetchPayment: async () => { throw new Error("network down"); } });
  assert.equal(down[0].ok, false);

  const good = await reconcilePayments([p.id, p.id], "admin@example.com", { fetchPayment: remote() });
  assert.equal(good.length, 1, "duplicate ids are processed once");
  assert.equal(good[0].ok, true);
  const row = await prisma.payment.findUniqueOrThrow({ where: { id: p.id } });
  assert.ok(row.reconciledAt);
  assert.equal(row.reconciledByEmail, "admin@example.com");
});
