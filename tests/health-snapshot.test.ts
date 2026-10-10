import "dotenv/config";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { prisma } from "../lib/db";
import { createHold } from "../lib/holds";
import {
  DEFAULT_THRESHOLDS as T,
  HealthKv,
  collectSnapshot,
  evaluateHealth,
  failedConfirmationsWhere,
  stuckMeetingsWhere,
  unrecoveredPaymentsWhere,
  unsweptHoldsWhere,
} from "../lib/health";
import { listRecoveredPayments } from "../lib/admin/health-data";
import { RECOVERY_ACTOR } from "../lib/payment-recovery";

/**
 * The database side of the health snapshot: which rows count as "stuck". The where-clauses are checked against rows
 * this test creates (scoped to its own influencer, so other data in the database cannot change the answers), and
 * collectSnapshot is checked end to end with a fake Redis and fake queue counts.
 */

const skip = process.env.DATABASE_URL ? false : "DATABASE_URL not set";
const run = Date.now();
const MIN = 60_000;
let influencerId: string;
let serviceId: string;
let n = 0;
const base = new Date(Date.now() + 40 * 86_400_000);
base.setUTCMinutes(0, 0, 0);

async function booking(status: "PAID" | "SCHEDULED" | "HELD" | "PENDING_PAYMENT" | "EXPIRED", extra: { updatedMinutesAgo?: number; holdExpiredMinutesAgo?: number | null } = {}) {
  const idx = ++n;
  const start = new Date(base.getTime() + idx * 3_600_000);
  const hold = await createHold({
    serviceId,
    startTime: start,
    endTime: new Date(start.getTime() + 30 * MIN),
    capacity: 1,
    customerName: "Health Tester",
    customerEmail: `health${run}_${idx}@example.com`,
    whatsappE164: "+919876543210",
    whatsappOptIn: true,
  });
  await prisma.booking.update({
    where: { id: hold.id },
    data: {
      status,
      holdExpiresAt: extra.holdExpiredMinutesAgo == null ? null : new Date(Date.now() - extra.holdExpiredMinutesAgo * MIN),
    },
  });
  if (extra.updatedMinutesAgo !== undefined) {
    await prisma.$executeRaw`UPDATE bookings SET updated_at = ${new Date(Date.now() - extra.updatedMinutesAgo * MIN)} WHERE id = ${hold.id}`;
  }
  return hold.id;
}

const inScope = { session: { service: { influencerId: "" } } };
const scoped = <W extends object>(where: W) => ({ AND: [where, { session: { service: { influencerId } } }] });
const countBookings = (where: object) => prisma.booking.count({ where: scoped(where) });

before(async () => {
  if (skip) return;
  const inf = await prisma.influencer.create({ data: { slug: `hs-${run}`, name: "Health Snapshot", email: `hs${run}@example.com` } });
  influencerId = inf.id;
  inScope.session.service.influencerId = inf.id;
  serviceId = (await prisma.service.create({ data: { influencerId, title: "1:1", durationMin: 30, priceMinor: 10000 } })).id;
});

after(async () => {
  if (!skip && influencerId) {
    const ids = (await prisma.payment.findMany({ where: { booking: inScope }, select: { id: true } })).map((p) => p.id);
    await prisma.adminAuditLog.deleteMany({ where: { adminEmail: RECOVERY_ACTOR.email, targetId: { in: ids } } });
    await prisma.influencer.delete({ where: { id: influencerId } });
  }
  await prisma.$disconnect();
});

test("paid bookings without a Meet link count only after the threshold, and only until the session is over", { skip }, async () => {
  const now = Date.now();
  const stuck = await booking("PAID", { updatedMinutesAgo: T.meetingStuckMinutes + 5 });
  const recent = await booking("PAID", { updatedMinutesAgo: 2 });
  const linked = await booking("PAID", { updatedMinutesAgo: 60 });
  await prisma.booking.update({ where: { id: linked }, data: { meetLink: "https://meet.google.com/abc-defg-hij", eventId: "ev1" } });
  const scheduled = await booking("SCHEDULED", { updatedMinutesAgo: 60 });
  const past = await booking("PAID", { updatedMinutesAgo: 60 });
  await prisma.session.updateMany({ where: { bookings: { some: { id: past } } }, data: { endTime: new Date(now - 10 * MIN) } });

  const rows = await prisma.booking.findMany({ where: scoped(stuckMeetingsWhere(now, T)), select: { id: true } });
  assert.deepEqual(rows.map((r) => r.id), [stuck]);
  assert.ok(![recent, linked, scheduled, past].some((id) => rows.some((r) => r.id === id)));
});

test("a confirmation counts as failed only when it failed everywhere it was tried", { skip }, async () => {
  const failed = await booking("SCHEDULED");
  const delivered = await booking("SCHEDULED"); // WhatsApp failed but the SMS fallback went out
  const other = await booking("SCHEDULED"); // a failed email is not a customer-channel confirmation failure
  const cancelled = await booking("EXPIRED");
  const msg = (bookingId: string, channel: "WHATSAPP" | "SMS" | "EMAIL", status: "FAILED" | "SENT", template = "booking-confirmation") =>
    prisma.message.create({ data: { bookingId, channel, template, status } });
  await msg(failed, "SMS", "FAILED");
  await msg(delivered, "WHATSAPP", "FAILED");
  await msg(delivered, "SMS", "SENT");
  await msg(other, "EMAIL", "FAILED");
  await msg(cancelled, "SMS", "FAILED");
  const reminderFailed = await booking("SCHEDULED");
  await msg(reminderFailed, "SMS", "FAILED", "reminder-24h");

  const rows = await prisma.booking.findMany({ where: scoped(failedConfirmationsWhere(Date.now())), select: { id: true } });
  assert.deepEqual(rows.map((r) => r.id), [failed]);
});

test("holds more than the grace period past expiry count; fresh, paid and not-yet-expired ones do not", { skip }, async () => {
  const unswept = await booking("HELD", { holdExpiredMinutesAgo: T.holdSweepGraceMinutes + 5 });
  const justExpired = await booking("PENDING_PAYMENT", { holdExpiredMinutesAgo: 1 });
  const live = await booking("HELD", { holdExpiredMinutesAgo: -10 });
  const paid = await booking("PAID", { holdExpiredMinutesAgo: 60 });
  const rows = await prisma.booking.findMany({ where: scoped(unsweptHoldsWhere(Date.now(), T)), select: { id: true } });
  assert.deepEqual(rows.map((r) => r.id), [unswept]);
  assert.ok(![justExpired, live, paid].some((id) => rows.some((r) => r.id === id)));
});

test("captured-but-unapplied payments count after the threshold and while the booking is still unpaid", { skip }, async () => {
  const mk = async (opts: { ageMin: number; error: string | null; bookingStatus?: "PENDING_PAYMENT" | "PAID" }) => {
    const id = await booking(opts.bookingStatus ?? "PENDING_PAYMENT");
    const p = await prisma.payment.create({
      data: {
        bookingId: id,
        providerOrderId: `order_hs_${run}_${++n}`,
        amountMinor: 10000,
        currency: "INR",
        recoveryError: opts.error,
        createdAt: new Date(Date.now() - opts.ageMin * MIN),
      },
    });
    return p.id;
  };
  const stuck = await mk({ ageMin: T.paymentUnrecoveredMinutes + 5, error: "redis down" });
  const young = await mk({ ageMin: 2, error: "redis down" });
  const noError = await mk({ ageMin: 60, error: null });
  const paidBooking = await mk({ ageMin: 60, error: "x", bookingStatus: "PAID" });
  const rows = await prisma.payment.findMany({ where: { AND: [unrecoveredPaymentsWhere(Date.now(), T), { booking: inScope }] }, select: { id: true } });
  assert.deepEqual(rows.map((r) => r.id), [stuck]);
  assert.ok(![young, noError, paidBooking].some((id) => rows.some((r) => r.id === id)));
});

test("collectSnapshot gathers everything, reports unreadable queues as unknown, and the report flags the stuck rows", { skip }, async () => {
  const before = await collectSnapshot({
    kv: new HealthKv(null),
    queueCounts: async () => ({ waiting: 0, active: 0, failed: 0, delayed: 0 }),
  });
  const stuckId = await booking("PAID", { updatedMinutesAgo: T.meetingStuckMinutes + 30 });
  const snapshot = await collectSnapshot({
    kv: new HealthKv(null),
    queueCounts: async (name) => {
      if (name === "reminders") throw new Error("redis down");
      return { waiting: 1, active: 2, failed: name === "meetings" ? 9 : 0, delayed: 3 };
    },
  });
  assert.ok(snapshot.stuckMeetings !== null && before.stuckMeetings !== null && snapshot.stuckMeetings >= before.stuckMeetings + 1, "the new stuck booking is counted");
  assert.equal(snapshot.heartbeat.state, "unknown", "no Redis in this test");
  assert.equal(snapshot.queues.reminders, null);
  assert.deepEqual(snapshot.queues.meetings, { waiting: 1, active: 2, failed: 9, delayed: 3 });
  for (const key of ["unrecoveredPayments", "failedConfirmations", "unsweptHolds"] as const) assert.equal(typeof snapshot[key], "number", key);

  const report = evaluateHealth(snapshot, T);
  const ids = report.unhealthy.map((c) => c.id);
  assert.ok(ids.includes("meetings-stuck"));
  assert.ok(ids.includes("queue:meetings"), "9 failed jobs is over the limit");
  assert.equal(report.conditions.find((c) => c.id === "queue:reminders")?.status, "unknown");
  assert.equal(report.conditions.find((c) => c.id === "worker-heartbeat")?.status, "unknown");
  assert.ok(stuckId);
});

test("recovered payments are listed from the audit log under the system actor", { skip }, async () => {
  const id = await booking("PAID");
  const payment = await prisma.payment.create({
    data: { bookingId: id, providerOrderId: `order_hs_${run}_audit`, amountMinor: 10000, currency: "INR", status: "CAPTURED" },
  });
  await prisma.adminAuditLog.create({
    data: {
      adminId: null,
      adminEmail: RECOVERY_ACTOR.email,
      action: "payment.recovered",
      targetType: "payment",
      targetId: payment.id,
      detail: { razorpayPaymentId: "pay_x1", bookingId: id, amountMinor: 10000, currency: "INR", orderId: payment.providerOrderId },
    },
  });
  const rows = await listRecoveredPayments(50);
  const mine = rows.find((r) => r.paymentId === payment.id);
  assert.ok(mine);
  assert.equal(mine.outcome, "recovered");
  assert.equal(mine.razorpayPaymentId, "pay_x1");
  assert.equal(mine.bookingId, id);
  assert.equal(mine.amountMinor, 10000);
});
