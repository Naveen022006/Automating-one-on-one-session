// cancelBooking against a migrated Postgres (skipped without DATABASE_URL / TOKEN_ENCRYPTION_KEY): what happens to the
// money of a booking the platform could not honour. Google and every side effect are injected; only the database is real.
import "dotenv/config";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { prisma } from "../lib/db";
import type { GoogleClient } from "../lib/google";
import { BookingNotManageableError, cancelBooking } from "../lib/manage";

const skip = process.env.DATABASE_URL && process.env.TOKEN_ENCRYPTION_KEY ? false : "DATABASE_URL / TOKEN_ENCRYPTION_KEY not set";
const run = Date.now();
let influencerId = "";
let serviceId = "";
let n = 0;

before(async () => {
  if (skip) return;
  influencerId = (await prisma.influencer.create({ data: { slug: `mc-${run}`, name: "MC", email: `mc-${run}@example.com` } })).id;
  serviceId = (
    await prisma.service.create({ data: { influencerId, title: "Call", type: "ONE_TO_ONE", capacity: 1, durationMin: 30, priceMinor: 50_000, refundPolicy: "NONE" } })
  ).id;
});

after(async () => {
  if (!skip) await prisma.influencer.delete({ where: { id: influencerId } });
  await prisma.$disconnect();
});

const deps = {
  google: {} as GoogleClient,
  alert: async () => {},
  cancelReminders: async () => {},
  enqueueSendMessage: async () => {},
  sendBookingEmail: async () => {},
  rearmMessage: async () => {},
  refundPayment: async () => ({}),
};

/** A future booking on the no-refund service with a captured payment. */
async function paidBooking(status: "SCHEDULED" | "FAILED", payment: { needsRefund?: boolean; failureReason?: string } = {}) {
  const start = new Date(Date.now() + (10 + n++) * 86_400_000);
  const session = await prisma.session.create({ data: { serviceId, startTime: start, endTime: new Date(start.getTime() + 1_800_000) } });
  const booking = await prisma.booking.create({
    data: { sessionId: session.id, status, refundPolicy: "NONE", customerName: "C", customerEmail: `c${n}-${run}@example.com`, whatsappE164: "+919876543210" },
  });
  const pay = await prisma.payment.create({
    data: {
      bookingId: booking.id,
      providerOrderId: `order_mc_${run}_${n}`,
      providerPaymentId: `pay_mc_${run}_${n}`,
      amountMinor: 50_000,
      currency: "INR",
      status: "CAPTURED",
      needsRefund: payment.needsRefund ?? false,
      failureReason: payment.failureReason ?? null,
    },
  });
  return { booking, pay };
}

test("a customer cannot cancel a booking that FAILED: the refund owed for it is not forfeited under the no-refund policy", { skip }, async () => {
  // The capture arrived after the slot was taken: the money is owed back whatever the service's policy says.
  const { booking, pay } = await paidBooking("FAILED", { needsRefund: true, failureReason: "paid after the hold expired and the slot was taken" });

  await assert.rejects(cancelBooking(booking.id, { actor: "customer" }, deps), BookingNotManageableError);

  const p = await prisma.payment.findUniqueOrThrow({ where: { id: pay.id } });
  assert.equal(p.needsRefund, true, "still flagged for refund");
  assert.equal((await prisma.booking.findUniqueOrThrow({ where: { id: booking.id } })).status, "FAILED");
});

test("a FAILED booking whose Meet link Google refused: a customer cancel does not record 'no refund due'", { skip }, async () => {
  const { booking, pay } = await paidBooking("FAILED");
  await assert.rejects(cancelBooking(booking.id, { actor: "customer" }, deps), BookingNotManageableError);
  assert.equal((await prisma.payment.findUniqueOrThrow({ where: { id: pay.id } })).failureReason, null);
});

test("the host (and the platform) can still cancel a FAILED booking, which refunds it", { skip }, async () => {
  const { booking, pay } = await paidBooking("FAILED");
  const result = await cancelBooking(booking.id, { actor: "influencer" }, deps);
  assert.equal(result.refund.eligible, true);
  assert.equal((await prisma.payment.findUniqueOrThrow({ where: { id: pay.id } })).needsRefund, true);
});
