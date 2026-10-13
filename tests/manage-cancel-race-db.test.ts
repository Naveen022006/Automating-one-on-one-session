// Two cancels of one booking at the same moment (host and customer, or a double submit), against a migrated Postgres
// (skipped without DATABASE_URL / TOKEN_ENCRYPTION_KEY). Google and every side effect are injected; only the database is real.
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
  influencerId = (await prisma.influencer.create({ data: { slug: `mcr-${run}`, name: "MCR", email: `mcr-${run}@example.com` } })).id;
  serviceId = (
    await prisma.service.create({ data: { influencerId, title: "Call", type: "ONE_TO_ONE", capacity: 1, durationMin: 30, priceMinor: 50_000, refundPolicy: "NONE" } })
  ).id;
});

after(async () => {
  if (!skip) await prisma.influencer.delete({ where: { id: influencerId } });
  await prisma.$disconnect();
});

function effects() {
  const calls = { emails: 0, notices: 0, alerts: [] as string[] };
  const deps = {
    google: {} as GoogleClient,
    alert: async (_i: string, a: { kind: string }) => void calls.alerts.push(a.kind),
    cancelReminders: async () => {},
    enqueueSendMessage: async () => void calls.notices++,
    sendBookingEmail: async () => void calls.emails++,
    rearmMessage: async () => {},
    refundPayment: async () => ({}),
  };
  return { calls, deps };
}

async function paidBooking() {
  const start = new Date(Date.now() + (10 + n++) * 86_400_000);
  const session = await prisma.session.create({ data: { serviceId, startTime: start, endTime: new Date(start.getTime() + 1_800_000) } });
  const booking = await prisma.booking.create({
    data: { sessionId: session.id, status: "SCHEDULED", refundPolicy: "NONE", customerName: "C", customerEmail: `c${n}-${run}@example.com`, whatsappE164: "+919876543210" },
  });
  const pay = await prisma.payment.create({
    data: { bookingId: booking.id, providerOrderId: `order_mcr_${run}_${n}`, providerPaymentId: `pay_mcr_${run}_${n}`, amountMinor: 50_000, currency: "INR", status: "CAPTURED" },
  });
  return { booking, pay };
}

test("host and customer cancel at the same moment: one cancel wins, and its refund decision is the one recorded", { skip }, async () => {
  for (let round = 0; round < 5; round++) {
    const { booking, pay } = await paidBooking();
    const host = effects();
    const customer = effects();
    const [h, c] = await Promise.allSettled([
      cancelBooking(booking.id, { actor: "influencer", reason: "host is ill" }, host.deps),
      cancelBooking(booking.id, { actor: "customer" }, customer.deps),
    ]);
    const won = [h, c].filter((r) => r.status === "fulfilled");
    assert.equal(won.length, 1, `round ${round}: exactly one cancel goes through (got ${won.length})`);
    const loser = [h, c].find((r) => r.status === "rejected") as PromiseRejectedResult;
    assert.ok(loser.reason instanceof BookingNotManageableError, String(loser.reason));
    assert.equal(host.calls.emails + customer.calls.emails, 1, "the customer is told once");

    const p = await prisma.payment.findUniqueOrThrow({ where: { id: pay.id } });
    // The host's cancel promises a full refund (and alerts the host to issue it); the customer's under NONE does not.
    assert.equal(p.needsRefund, h.status === "fulfilled", `round ${round}: the payment flag matches the cancel that won`);
  }
});
