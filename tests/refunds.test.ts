import assert from "node:assert/strict";
import { mock, test } from "node:test";

/**
 * Refunds against an in-memory payments + refunds store (the DB module is mocked once for the file; Razorpay is
 * injected): ownership scoping, the claim that prevents double refunds, partial refunds, ambiguous Razorpay
 * failures that must keep the claim, and webhooks that can never undo a newer refund.
 */

interface PaymentRow {
  id: string;
  bookingId: string;
  influencerId: string;
  status: string;
  providerPaymentId: string | null;
  amountMinor: number;
  needsRefund: boolean;
  refundStatus: string | null;
  refundAmountMinor: number | null;
  refundedAt: Date | null;
  updatedAt: Date;
}
interface RefundRow {
  paymentId: string;
  providerRefundId: string;
  amountMinor: number;
  status: string;
  createdAt: Date;
}

const state = { payments: [] as PaymentRow[], refunds: [] as RefundRow[] };

function matchPayment(r: PaymentRow, where: Record<string, unknown>): boolean {
  if (where.id && r.id !== where.id) return false;
  if (where.status && r.status !== where.status) return false;
  if (where.providerPaymentId && r.providerPaymentId !== where.providerPaymentId) return false;
  if ("refundStatus" in where && r.refundStatus !== where.refundStatus) return false;
  const inf = (where.booking as { session?: { service?: { influencerId?: string } } } | undefined)?.session?.service?.influencerId;
  if (inf && r.influencerId !== inf) return false;
  const or = where.OR as { refundStatus: string | null | { in: string[] } }[] | undefined;
  if (or && !or.some((c) => (c.refundStatus && typeof c.refundStatus === "object" ? c.refundStatus.in.includes(r.refundStatus ?? "") : c.refundStatus === r.refundStatus))) {
    return false;
  }
  return true;
}
function withRelations(p: PaymentRow) {
  return {
    ...p,
    booking: { id: p.bookingId, session: { service: { influencerId: p.influencerId } } },
    refunds: state.refunds
      .filter((r) => r.paymentId === p.id)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()),
  };
}
const touch = (p: PaymentRow, data: Partial<PaymentRow>) => Object.assign(p, data, { updatedAt: new Date() });

const db = {
  payment: {
    findFirst: async ({ where }: { where: Record<string, unknown> }) => {
      const p = state.payments.find((r) => matchPayment(r, where));
      return p ? withRelations(p) : null;
    },
    findUnique: async ({ where }: { where: { id: string } }) => {
      const p = state.payments.find((r) => r.id === where.id);
      return p ? withRelations(p) : null;
    },
    findUniqueOrThrow: async ({ where }: { where: { id: string } }) => withRelations(state.payments.find((r) => r.id === where.id)!),
    update: async ({ where, data }: { where: { id: string }; data: Partial<PaymentRow> }) => touch(state.payments.find((r) => r.id === where.id)!, data),
    updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Partial<PaymentRow> }) => {
      const hit = state.payments.filter((r) => matchPayment(r, where));
      hit.forEach((r) => touch(r, data));
      return { count: hit.length };
    },
  },
  refund: {
    findUnique: async ({ where }: { where: { providerRefundId: string } }) => state.refunds.find((r) => r.providerRefundId === where.providerRefundId) ?? null,
    create: async ({ data }: { data: Omit<RefundRow, "createdAt"> }) => {
      const row = { ...data, createdAt: new Date() };
      state.refunds.push(row);
      return row;
    },
    update: async ({ where, data }: { where: { providerRefundId: string }; data: Partial<RefundRow> }) =>
      Object.assign(state.refunds.find((r) => r.providerRefundId === where.providerRefundId)!, data),
    upsert: async ({ where, create, update }: { where: { providerRefundId: string }; create: Omit<RefundRow, "createdAt">; update: Partial<RefundRow> }) => {
      const found = state.refunds.find((r) => r.providerRefundId === where.providerRefundId);
      if (found) return Object.assign(found, update);
      const row = { ...create, createdAt: new Date(Date.now() + state.refunds.length) };
      state.refunds.push(row);
      return row;
    },
  },
};

mock.module("@/lib/db", { namedExports: { prisma: db } });
mock.module("@/lib/alerts", { namedExports: { alertInfluencer: async () => {} } });
const { refundPayment, applyRefundWebhook, RefundPendingError, CLAIM_STALE_MS } = await import("../lib/refunds");
const { RazorpayHttpError } = await import("../lib/payments");

function reset(over: Partial<PaymentRow> = {}) {
  state.refunds = [];
  state.payments = [
    {
      id: "p1",
      bookingId: "b1",
      influencerId: "inf1",
      status: "CAPTURED",
      providerPaymentId: "pay_1",
      amountMinor: 50000,
      needsRefund: true,
      refundStatus: null,
      refundAmountMinor: null,
      refundedAt: null,
      updatedAt: new Date(),
      ...over,
    },
  ];
  return state.payments[0];
}
const ok = (id: string, amount: number, status = "processed") => async () => ({ id, payment_id: "pay_1", amount, currency: "INR", status });
const noRazorpay = { createRefund: async () => assert.fail("Razorpay must not be called"), listRefunds: async () => [] };

test("a full refund is issued once, recorded, and closes the payment", async () => {
  const p = reset();
  const r = await refundPayment("p1", { influencerId: "inf1" }, { createRefund: ok("rf_1", 50000) });
  assert.equal(r.fullyRefunded, true);
  assert.equal(p.status, "REFUNDED");
  assert.equal(p.needsRefund, false);
  assert.equal(p.refundAmountMinor, 50000);
  assert.equal(state.refunds.length, 1);
  await assert.rejects(refundPayment("p1", {}, noRazorpay), /already refunded in full/);
});

test("another influencer cannot refund the payment", async () => {
  reset();
  await assert.rejects(refundPayment("p1", { influencerId: "someone-else" }, noRazorpay), /not found/);
});

test("partial refunds add up and the rest can still be refunded", async () => {
  const p = reset();
  await refundPayment("p1", { amountMinor: 20000 }, { createRefund: ok("rf_a", 20000) });
  assert.equal(p.status, "CAPTURED", "still captured after a partial refund");
  assert.equal(p.refundAmountMinor, 20000);
  await assert.rejects(refundPayment("p1", { amountMinor: 40000 }, noRazorpay), /not yet refunded/);
  const rest = await refundPayment("p1", {}, { createRefund: ok("rf_b", 30000) });
  assert.equal(rest.amountMinor, 30000);
  assert.equal(p.status, "REFUNDED");
  assert.equal(p.refundAmountMinor, 50000);
});

test("a definite Razorpay rejection releases the claim; an unclear outcome keeps it", async () => {
  const p = reset();
  await assert.rejects(
    refundPayment("p1", {}, { createRefund: async () => Promise.reject(new RazorpayHttpError(400, "BAD_REQUEST")) }),
    /BAD_REQUEST/,
  );
  assert.equal(p.refundStatus, null, "rejected: the influencer can retry");

  await assert.rejects(refundPayment("p1", {}, { createRefund: async () => Promise.reject(new Error("The operation was aborted due to timeout")) }), (e) => e instanceof RefundPendingError);
  assert.equal(p.refundStatus, "requested", "timeout: the claim stays so nobody refunds twice");
  await assert.rejects(refundPayment("p1", {}, noRazorpay), /already in progress/);
});

test("a stale unconfirmed claim is reconciled against Razorpay before any new refund", async () => {
  const p = reset({ refundStatus: "requested", updatedAt: new Date(Date.now() - CLAIM_STALE_MS - 1000) });
  // Razorpay did take the earlier refund: reconciliation records it and nothing is refunded twice.
  await assert.rejects(
    refundPayment("p1", {}, {
      createRefund: async () => assert.fail("must not refund again"),
      listRefunds: async () => [{ id: "rf_lost", payment_id: "pay_1", amount: 50000, currency: "INR", status: "processed" }],
    }),
    /already refunded in full/,
  );
  assert.equal(p.status, "REFUNDED");
  assert.equal(state.refunds[0].providerRefundId, "rf_lost");
});

test("webhooks: a late failure of an older refund never undoes a newer successful one", async () => {
  const p = reset();
  // Refund A failed; the influencer retried and refund B succeeded.
  state.refunds.push({ paymentId: "p1", providerRefundId: "rf_A", amountMinor: 50000, status: "failed", createdAt: new Date(Date.now() - 60_000) });
  await refundPayment("p1", {}, { createRefund: ok("rf_B", 50000) });
  assert.equal(p.status, "REFUNDED");

  // Razorpay redelivers A's failure: only A's own row is touched (already failed), B stands.
  await applyRefundWebhook("refund.failed", { id: "rf_A", payment_id: "pay_1", amount: 50000 }, async () => {}, db as never);
  assert.equal(p.status, "REFUNDED");
  assert.equal(p.refundAmountMinor, 50000);

  // A real failure of B re-opens the payment and flags it.
  await applyRefundWebhook("refund.failed", { id: "rf_B", payment_id: "pay_1", amount: 50000 }, async () => {}, db as never);
  assert.equal(p.status, "CAPTURED");
  assert.equal(p.needsRefund, true);
  assert.equal(p.refundAmountMinor, null);
});

test("webhooks record refunds issued outside the app and settle an unconfirmed claim", async () => {
  const p = reset({ refundStatus: "requested" });
  await applyRefundWebhook("refund.processed", { id: "rf_dash", payment_id: "pay_1", amount: 50000 }, async () => {}, db as never);
  assert.equal(p.status, "REFUNDED");
  assert.equal(p.refundStatus, "processed");
});
