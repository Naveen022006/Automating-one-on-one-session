import "dotenv/config";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { approveRequest, ApprovalError, declineRequest, MIN_LEAD_BEFORE_START_MS, paymentDeadline } from "../lib/booking-approval";
import { startCheckout, NotPayableError } from "../lib/checkout";
import { requestEmail } from "../lib/email/templates";
import { prisma } from "../lib/db";
import { createHold, expireStaleHolds, REQUEST_TTL_HOURS, SlotUnavailableError } from "../lib/holds";
import { buildPayUrl, BOOKING_PAY_PURPOSE, verifyPayToken } from "../lib/self-service";
import { signToken } from "../lib/signing";

test("payment deadline: 24 hours, never within 15 minutes of the session", () => {
  const now = new Date("2026-10-20T12:00:00Z");
  assert.equal(paymentDeadline(now, new Date("2026-10-30T12:00:00Z"))!.toISOString(), "2026-10-21T12:00:00.000Z");
  assert.equal(
    paymentDeadline(now, new Date("2026-10-20T20:00:00Z"))!.getTime(),
    new Date("2026-10-20T20:00:00Z").getTime() - MIN_LEAD_BEFORE_START_MS,
    "capped just before the session",
  );
  assert.equal(paymentDeadline(now, new Date("2026-10-20T12:10:00Z")), null, "no time left to pay");
  assert.equal(paymentDeadline(now, new Date("2026-10-20T12:19:00Z")), null, "under five minutes to pay is not enough");
  assert.ok(paymentDeadline(now, new Date("2026-10-20T12:21:00Z")), "a few minutes is allowed");
});

test("payment links are signed, tied to one booking, and not interchangeable with other tokens", () => {
  process.env.APP_URL ||= "http://localhost:3000";
  const url = buildPayUrl("bk_123", 3600);
  const token = decodeURIComponent(url.split("/pay/")[1]);
  assert.equal(verifyPayToken(token), "bk_123");
  assert.equal(verifyPayToken(token + "x"), null, "tampering is rejected");
  assert.equal(verifyPayToken(undefined), null);
  assert.equal(verifyPayToken(signToken(BOOKING_PAY_PURPOSE, { b: "bk_123" }, -10)), null, "expired");
  assert.equal(verifyPayToken(signToken("customer-self-service", { b: "bk_123" }, 3600)), null, "a self-service token is not a pay token");
});

test("request emails say what happens next without promising a charge", () => {
  const base = { customerName: "Asha Rao", serviceTitle: "Portfolio review", influencerName: "Sam", startTime: new Date("2026-11-02T10:00:00Z"), tz: "Asia/Kolkata" };
  const received = requestEmail("request-received", { ...base, decideWithinHours: 48 });
  assert.match(received.text, /Nothing has been charged/);
  const approved = requestEmail("request-approved", { ...base, payUrl: "https://app.example/pay/abc", payBy: new Date("2026-11-01T10:00:00Z"), amount: { amountMinor: 49900, currency: "INR" } });
  assert.match(approved.html, /https:\/\/app\.example\/pay\/abc/);
  assert.match(approved.text, /499/);
  const declined = requestEmail("request-declined", { ...base, reason: "I am away that week" });
  assert.match(declined.text, /I am away that week/);
  assert.match(declined.text, /not been charged/i);
});

// ---- Integration ----
const skip = process.env.DATABASE_URL ? false : "DATABASE_URL not set";
const run = Date.now();
let owner: string;
let stranger: string;
let serviceId: string;
let n = 0;
const DAY = 86_400_000;

async function request(startOffsetMs: number, email = `req${++n}-${run}@example.com`) {
  const start = new Date(Date.now() + startOffsetMs);
  start.setUTCMinutes(0, 0, 0);
  const booking = await createHold({
    serviceId,
    startTime: start,
    endTime: new Date(start.getTime() + 30 * 60_000),
    capacity: 1,
    customerName: "Requester",
    customerEmail: email,
    whatsappE164: "+919876543210",
    whatsappOptIn: true,
    requestApproval: true,
  });
  return { booking, start };
}

before(async () => {
  if (skip) return;
  owner = (await prisma.influencer.create({ data: { slug: `ap-${run}`, name: "Approver", email: `ap-${run}@example.com`, onboardedAt: new Date() } })).id;
  stranger = (await prisma.influencer.create({ data: { slug: `ap2-${run}`, name: "Other", email: `ap2-${run}@example.com`, onboardedAt: new Date() } })).id;
  serviceId = (await prisma.service.create({ data: { influencerId: owner, title: "Reviewed", durationMin: 30, priceMinor: 49900, requiresApproval: true } })).id;
});

after(async () => {
  if (!skip) await prisma.influencer.deleteMany({ where: { id: { in: [owner, stranger].filter(Boolean) } } });
  await prisma.$disconnect();
});

test("a request holds the seat for 48 hours and cannot be paid", { skip }, async () => {
  const { booking, start } = await request(5 * DAY);
  assert.equal(booking.status, "REQUESTED");
  const hours = (booking.holdExpiresAt!.getTime() - Date.now()) / 3_600_000;
  assert.ok(Math.abs(hours - REQUEST_TTL_HOURS) < 0.1);

  await assert.rejects(request(5 * DAY, "someone-else@example.com").then(() => null), SlotUnavailableError, "the seat is taken while the request waits");
  void start;
  await assert.rejects(startCheckout(booking.id), NotPayableError, "nothing is payable before approval");
});

test("approving makes it payable with a deadline, once, and only for the owner", { skip }, async () => {
  const { booking } = await request(6 * DAY);
  await assert.rejects(approveRequest(stranger, booking.id), (e: unknown) => e instanceof ApprovalError && e.status === 404, "another influencer cannot approve");

  const { payBy } = await approveRequest(owner, booking.id);
  const row = await prisma.booking.findUniqueOrThrow({ where: { id: booking.id } });
  assert.equal(row.status, "HELD");
  assert.equal(row.holdExpiresAt!.getTime(), payBy.getTime());
  assert.ok(row.decidedAt);
  const hours = (payBy.getTime() - Date.now()) / 3_600_000;
  assert.ok(hours > 23 && hours <= 24.01, "about 24 hours to pay");

  await assert.rejects(approveRequest(owner, booking.id), /already approved/i, "approving twice is refused");
  await assert.rejects(declineRequest(owner, booking.id, null), /not a pending request/i, "an approved request cannot be declined");
});

test("declining cancels the request, frees the seat and records the reason", { skip }, async () => {
  const { booking, start } = await request(7 * DAY);
  await assert.rejects(declineRequest(stranger, booking.id, null), (e: unknown) => e instanceof ApprovalError && e.status === 404);
  await declineRequest(owner, booking.id, "  Away that week  ");
  const row = await prisma.booking.findUniqueOrThrow({ where: { id: booking.id } });
  assert.equal(row.status, "CANCELLED");
  assert.equal(row.declineReason, "Away that week");

  const again = await createHold({
    serviceId,
    startTime: start,
    endTime: new Date(start.getTime() + 30 * 60_000),
    capacity: 1,
    customerName: "Next",
    customerEmail: `next-${run}@example.com`,
    whatsappE164: "+919876543210",
    whatsappOptIn: true,
  });
  assert.equal(again.status, "HELD", "the declined request's seat is free again");
  await prisma.booking.update({ where: { id: again.id }, data: { status: "EXPIRED" } });
});

test("an expired request cannot be approved and is tidied up by the expiry job", { skip }, async () => {
  const { booking } = await request(8 * DAY);
  await prisma.booking.update({ where: { id: booking.id }, data: { holdExpiresAt: new Date(Date.now() - 1000) } });
  await assert.rejects(approveRequest(owner, booking.id), /expired/i);
  await expireStaleHolds();
  assert.equal((await prisma.booking.findUniqueOrThrow({ where: { id: booking.id } })).status, "EXPIRED");
});

test("a session starting too soon cannot be approved", { skip }, async () => {
  const { booking } = await request(10 * 60_000);
  await assert.rejects(approveRequest(owner, booking.id), /too soon/i);
  await declineRequest(owner, booking.id, null);
});

test("approve racing approve: exactly one wins", { skip }, async () => {
  const { booking } = await request(9 * DAY);
  const results = await Promise.allSettled([approveRequest(owner, booking.id), approveRequest(owner, booking.id)]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
});
