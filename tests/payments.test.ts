import "dotenv/config";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { prisma } from "../lib/db";
import { createHold } from "../lib/holds";
import { handleRazorpayEvent, type RazorpayWebhook } from "../lib/payment-webhook";

// Integration tests: need a migrated Postgres at DATABASE_URL (skipped otherwise).
const skip = process.env.DATABASE_URL ? false : "DATABASE_URL not set";
const slotStart = new Date(Date.now() + 9 * 86_400_000);
slotStart.setUTCMinutes(0, 0, 0);
const slotEnd = new Date(slotStart.getTime() + 30 * 60_000);

let influencerId: string;
let serviceId: string;
const run = Date.now();
let n = 0;

async function pendingBooking(email: string, start = slotStart) {
  const hold = await createHold({
    serviceId,
    startTime: start,
    endTime: new Date(start.getTime() + 30 * 60_000),
    capacity: 1,
    customerName: "Pay Tester",
    customerEmail: email,
    whatsappE164: "+919876543210",
    whatsappOptIn: true,
  });
  const orderId = `order_${run}_${++n}`;
  await prisma.booking.update({ where: { id: hold.id }, data: { status: "PENDING_PAYMENT" } });
  await prisma.payment.create({
    data: { bookingId: hold.id, providerOrderId: orderId, amountMinor: 49900, currency: "INR" },
  });
  return { bookingId: hold.id, orderId };
}

const captured = (orderId: string, amount = 49900): RazorpayWebhook => ({
  event: "payment.captured",
  payload: { payment: { entity: { id: `pay_${orderId}`, order_id: orderId, amount, currency: "INR" } } },
});

before(async () => {
  if (skip) return;
  const inf = await prisma.influencer.create({
    data: { slug: `pay-${run}`, name: "Pay Test", email: `pay${run}@example.com` },
  });
  influencerId = inf.id;
  serviceId = (
    await prisma.service.create({ data: { influencerId, title: "1:1", durationMin: 30, priceMinor: 49900 } })
  ).id;
});

after(async () => {
  if (!skip && influencerId) {
    await prisma.influencer.delete({ where: { id: influencerId } });
    await prisma.$executeRaw`DELETE FROM webhook_events WHERE event_id LIKE ${"evt_" + run + "%"}`;
  }
  await prisma.$disconnect();
});

test("replaying the same webhook enqueues only one meeting job", { skip }, async () => {
  const { bookingId, orderId } = await pendingBooking("replay@example.com");
  const queued: string[] = [];
  const enqueue = async (id: string) => void queued.push(id);

  const first = await handleRazorpayEvent(`evt_${run}_a`, captured(orderId), enqueue);
  const second = await handleRazorpayEvent(`evt_${run}_a`, captured(orderId), enqueue);
  // Razorpay also sends order.paid for the same payment under a different event id.
  const third = await handleRazorpayEvent(`evt_${run}_b`, { ...captured(orderId), event: "order.paid" }, enqueue);

  assert.equal(first, "processed");
  assert.equal(second, "duplicate");
  assert.equal(third, "processed");
  // A paid booking enqueues the create-meeting job exactly once. The create-meeting job (Phase 3) is
  // the sole producer of send-message, enqueueing it only after the Meet link is set.
  assert.deepEqual(queued, [bookingId]);
  const booking = await prisma.booking.findUniqueOrThrow({ where: { id: bookingId } });
  assert.equal(booking.status, "PAID");
  assert.equal((await prisma.payment.findUniqueOrThrow({ where: { providerOrderId: orderId } })).status, "CAPTURED");
});

test("a failed enqueue rolls back, so the retried webhook is processed", { skip }, async () => {
  const start = new Date(slotStart.getTime() + 3_600_000);
  const { bookingId, orderId } = await pendingBooking("rollback@example.com", start);
  await assert.rejects(
    handleRazorpayEvent(`evt_${run}_c`, captured(orderId), async () => {
      throw new Error("redis down");
    }),
  );
  assert.equal((await prisma.booking.findUniqueOrThrow({ where: { id: bookingId } })).status, "PENDING_PAYMENT");

  const queued: string[] = [];
  const out = await handleRazorpayEvent(`evt_${run}_c`, captured(orderId), async (id) => void queued.push(id));
  assert.equal(out, "processed");
  assert.deepEqual(queued, [bookingId]);
});

test("amount mismatch is not marked paid and is flagged for refund", { skip }, async () => {
  const start = new Date(slotStart.getTime() + 7_200_000);
  const { bookingId, orderId } = await pendingBooking("mismatch@example.com", start);
  const queued: string[] = [];
  await handleRazorpayEvent(`evt_${run}_d`, captured(orderId, 100), async (id) => void queued.push(id));
  assert.equal(queued.length, 0);
  assert.equal((await prisma.booking.findUniqueOrThrow({ where: { id: bookingId } })).status, "FAILED");
  assert.equal((await prisma.payment.findUniqueOrThrow({ where: { providerOrderId: orderId } })).needsRefund, true);
});

test("payment after hold expiry is refused when the slot was re-taken", { skip }, async () => {
  const start = new Date(slotStart.getTime() + 10_800_000);
  const { bookingId, orderId } = await pendingBooking("late@example.com", start);
  await prisma.booking.update({ where: { id: bookingId }, data: { status: "EXPIRED" } });
  await createHold({
    serviceId,
    startTime: start,
    endTime: new Date(start.getTime() + 30 * 60_000),
    capacity: 1,
    customerName: "Someone else",
    customerEmail: "other@example.com",
    whatsappE164: "+919876543210",
    whatsappOptIn: true,
  });
  const queued: string[] = [];
  await handleRazorpayEvent(`evt_${run}_e`, captured(orderId), async (id) => void queued.push(id));
  assert.equal(queued.length, 0);
  const p = await prisma.payment.findUniqueOrThrow({ where: { providerOrderId: orderId } });
  assert.equal(p.needsRefund, true);
});

test("payment after hold expiry is refused when the slot was re-taken, before the sweep marked the hold EXPIRED", { skip }, async () => {
  // The hold lapsed but the worker has not run yet (it sweeps every 30 s, never while it is down): the booking is still
  // PENDING_PAYMENT. Availability already treats the seat as free, so another customer can take it.
  const start = new Date(slotStart.getTime() + 14_400_000);
  const { bookingId, orderId } = await pendingBooking("late-unswept@example.com", start);
  await prisma.booking.update({ where: { id: bookingId }, data: { holdExpiresAt: new Date(Date.now() - 60_000) } });
  const other = await createHold({
    serviceId,
    startTime: start,
    endTime: new Date(start.getTime() + 30 * 60_000),
    capacity: 1,
    customerName: "Someone else",
    customerEmail: "other-unswept@example.com",
    whatsappE164: "+919876543210",
    whatsappOptIn: true,
  });
  await prisma.booking.update({ where: { id: other.id }, data: { status: "PAID", holdExpiresAt: null } });

  const queued: string[] = [];
  await handleRazorpayEvent(`evt_${run}_f`, captured(orderId), async (id) => void queued.push(id));
  assert.equal(queued.length, 0, "the late payer must not be booked into a seat someone else holds");
  assert.equal((await prisma.booking.findUniqueOrThrow({ where: { id: bookingId } })).status, "FAILED");
  assert.equal((await prisma.payment.findUniqueOrThrow({ where: { providerOrderId: orderId } })).needsRefund, true);
});

test("payment after hold expiry, before the sweep, is honoured when the seat is still free", { skip }, async () => {
  const start = new Date(slotStart.getTime() + 18_000_000);
  const { bookingId, orderId } = await pendingBooking("late-free@example.com", start);
  await prisma.booking.update({ where: { id: bookingId }, data: { holdExpiresAt: new Date(Date.now() - 60_000) } });
  const queued: string[] = [];
  await handleRazorpayEvent(`evt_${run}_g`, captured(orderId), async (id) => void queued.push(id));
  assert.deepEqual(queued, [bookingId]);
  assert.equal((await prisma.booking.findUniqueOrThrow({ where: { id: bookingId } })).status, "PAID");
});

test("a late duplicate of the capture webhook does not reopen a payment that was refunded meanwhile", { skip }, async () => {
  // payment.captured is applied; the order.paid for the same payment failed on our side and Razorpay retries it hours
  // later. In between, the booking was cancelled and refunded in full.
  const start = new Date(slotStart.getTime() + 21_600_000);
  const { bookingId, orderId } = await pendingBooking("late-dup@example.com", start);
  const queued: string[] = [];
  await handleRazorpayEvent(`evt_${run}_h`, captured(orderId), async (id) => void queued.push(id));
  assert.deepEqual(queued, [bookingId]);

  const payment = await prisma.payment.findUniqueOrThrow({ where: { providerOrderId: orderId } });
  await prisma.booking.update({ where: { id: bookingId }, data: { status: "CANCELLED" } });
  const { refundPayment } = await import("../lib/refunds");
  const refunded = await refundPayment(payment.id, { reason: "cancelled" }, {
    createRefund: async () => ({ id: `rfnd_${orderId}`, payment_id: `pay_${orderId}`, amount: 49900, currency: "INR", status: "processed" }),
  });
  assert.equal(refunded.fullyRefunded, true);

  const out = await handleRazorpayEvent(`evt_${run}_i`, { ...captured(orderId), event: "order.paid" }, async (id) => void queued.push(id));
  assert.notEqual(out, "duplicate");
  assert.deepEqual(queued, [bookingId], "nothing is queued again");
  const after = await prisma.payment.findUniqueOrThrow({ where: { providerOrderId: orderId } });
  assert.equal(after.status, "REFUNDED", "the refunded payment stays refunded");
  assert.equal(after.needsRefund, false, "and is not flagged for a second refund");
  assert.equal((await prisma.booking.findUniqueOrThrow({ where: { id: bookingId } })).status, "CANCELLED");
});
