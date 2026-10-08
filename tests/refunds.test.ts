import assert from "node:assert/strict";
import { mock, test } from "node:test";

/**
 * refundPayment with an in-memory payments table: ownership scoping, the claim that stops double refunds, the
 * release on a Razorpay error, and the REFUNDED bookkeeping. Razorpay is injected; the DB module is mocked.
 */

interface Row {
  id: string;
  bookingId: string;
  influencerId: string;
  status: string;
  providerPaymentId: string | null;
  amountMinor: number;
  needsRefund: boolean;
  refundId: string | null;
  refundStatus: string | null;
  refundAmountMinor: number | null;
  refundedAt: Date | null;
}

function makeDb(getRows: () => Row[]) {
  const match = (r: Row, where: Record<string, unknown>) => {
    if (where.id && r.id !== where.id) return false;
    if (where.status && r.status !== where.status) return false;
    if ("refundId" in where && r.refundId !== where.refundId) return false;
    const inf = (where.booking as { session?: { service?: { influencerId?: string } } } | undefined)?.session?.service?.influencerId;
    if (inf && r.influencerId !== inf) return false;
    const or = where.OR as { refundStatus: string | null }[] | undefined;
    if (or && !or.some((c) => c.refundStatus === r.refundStatus)) return false;
    return true;
  };
  return {
    payment: {
      findFirst: async ({ where }: { where: Record<string, unknown> }) => getRows().find((r) => match(r, where)) ?? null,
      updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Partial<Row> }) => {
        const hit = getRows().filter((r) => match(r, where));
        hit.forEach((r) => Object.assign(r, data));
        return { count: hit.length };
      },
      update: async ({ where, data }: { where: { id: string }; data: Partial<Row> }) => {
        const r = getRows().find((x) => x.id === where.id)!;
        Object.assign(r, data);
        return r;
      },
    },
  };
}

function row(over: Partial<Row> = {}): Row {
  return {
    id: "p1",
    bookingId: "b1",
    influencerId: "inf1",
    status: "CAPTURED",
    providerPaymentId: "pay_1",
    amountMinor: 49900,
    needsRefund: true,
    refundId: null,
    refundStatus: null,
    refundAmountMinor: null,
    refundedAt: null,
    ...over,
  };
}

// Mocked once for the file; each test swaps in its own rows.
let current: Row[] = [];
const db = makeDb(() => current);
mock.module("@/lib/db", { namedExports: { prisma: db } });
mock.module("@/lib/alerts", { namedExports: { alertInfluencer: async () => {} } });
const refunds = await import("../lib/refunds");

async function load(rows: Row[]) {
  current = rows;
  return refunds;
}

test("refunds a captured payment once and records it", async () => {
  const rows = [row()];
  const mod = await load(rows);
  const calls: unknown[] = [];
  const result = await mod.refundPayment("p1", { influencerId: "inf1" }, {
    createRefund: async (input: unknown) => {
      calls.push(input);
      return { id: "rfnd_1", payment_id: "pay_1", amount: 49900, currency: "INR", status: "processed" };
    },
  });
  assert.equal(result.refundId, "rfnd_1");
  assert.equal(calls.length, 1);
  assert.equal(rows[0].status, "REFUNDED");
  assert.equal(rows[0].needsRefund, false);
  assert.equal(rows[0].refundAmountMinor, 49900);

  await assert.rejects(mod.refundPayment("p1", { influencerId: "inf1" }, { createRefund: async () => assert.fail("must not call Razorpay twice") }), /already refunded/);
});

test("another influencer cannot refund the payment", async () => {
  const mod = await load([row()]);
  await assert.rejects(
    mod.refundPayment("p1", { influencerId: "someone-else" }, { createRefund: async () => assert.fail("no Razorpay call") }),
    /not found/,
  );
});

test("a refund already in progress is not started again; a Razorpay error releases the claim", async () => {
  const rows = [row({ refundStatus: "requested" })];
  const mod = await load(rows);
  await assert.rejects(mod.refundPayment("p1", {}, { createRefund: async () => assert.fail("no call") }), /already in progress/);

  rows[0].refundStatus = null;
  await assert.rejects(mod.refundPayment("p1", {}, { createRefund: async () => Promise.reject(new Error("BAD_REQUEST")) }), /BAD_REQUEST/);
  assert.equal(rows[0].refundStatus, null, "claim released so the influencer can retry");
  assert.equal(rows[0].status, "CAPTURED");
});

test("partial refunds are bounded by the amount paid", async () => {
  const mod = await load([row()]);
  await assert.rejects(mod.refundPayment("p1", { amountMinor: 60000 }, { createRefund: async () => assert.fail() }), /between 1 and the amount paid/);
});
