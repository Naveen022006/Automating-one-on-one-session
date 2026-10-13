// Integration test: needs a migrated Postgres at DATABASE_URL (skipped otherwise).
// An influencer is in one session at a time, whichever of their services was booked: holds, the calendar, a late payment
// and a reschedule all refuse a time that overlaps another of their sessions with an occupied seat.
import "dotenv/config";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { DateTime } from "luxon";
import { prisma } from "../lib/db";
import { openSlots, type BookableService } from "../lib/availability";
import { createHold, SlotUnavailableError } from "../lib/holds";
import { handleRazorpayEvent } from "../lib/payment-webhook";

const skip = process.env.DATABASE_URL ? false : "DATABASE_URL not set";
const MIN = 60_000;
const DAY = 86_400_000;
const run = Date.now();

let influencerId: string;
let hourId: string; // 1:1, 60 minutes
let halfId: string; // 1:1, 30 minutes
let groupId: string; // group of 3, 30 minutes
let n = 0;

/** 10:00 UTC on the day `daysAhead` from now; each test uses its own day so they cannot see each other's bookings. */
function dayAt(daysAhead: number, hour: number, minute = 0): Date {
  return DateTime.fromMillis(Date.now() + daysAhead * DAY, { zone: "utc" }).set({ hour, minute, second: 0, millisecond: 0 }).toJSDate();
}

const durations: Record<string, number> = {};
const capacities: Record<string, number> = {};

function hold(serviceId: string, start: Date) {
  n += 1;
  return createHold({
    serviceId,
    startTime: start,
    endTime: new Date(start.getTime() + durations[serviceId] * MIN),
    capacity: capacities[serviceId],
    customerName: `Overlap ${n}`,
    customerEmail: `overlap${run}_${n}@example.com`,
    whatsappE164: "+919876543210",
    whatsappOptIn: true,
  });
}

const refused = (e: unknown) => e instanceof SlotUnavailableError;

async function bookable(serviceId: string): Promise<BookableService> {
  const rules = await prisma.availabilityRule.findMany({ where: { influencerId } });
  return {
    id: serviceId,
    influencerId,
    durationMin: durations[serviceId],
    capacity: capacities[serviceId],
    timezone: "UTC",
    rules,
    minNoticeHours: 0,
    maxAdvanceDays: 365,
  };
}

before(async () => {
  if (skip) return;
  const inf = await prisma.influencer.create({
    data: { slug: `overlap-${run}`, name: "Overlap Test", email: `overlap${run}@example.com`, timezone: "UTC" },
  });
  influencerId = inf.id;
  // Every day of the week, 08:00 to 20:00 UTC.
  await prisma.availabilityRule.createMany({
    data: [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({ influencerId, weekday, startTime: "08:00", endTime: "20:00", timezone: "UTC" })),
  });
  const base = { influencerId, priceMinor: 49900 };
  hourId = (await prisma.service.create({ data: { ...base, title: "1:1 hour", durationMin: 60, capacity: 1 } })).id;
  halfId = (await prisma.service.create({ data: { ...base, title: "1:1 half", durationMin: 30, capacity: 1 } })).id;
  groupId = (await prisma.service.create({ data: { ...base, title: "Group", type: "GROUP", durationMin: 30, capacity: 3 } })).id;
  Object.assign(durations, { [hourId]: 60, [halfId]: 30, [groupId]: 30 });
  Object.assign(capacities, { [hourId]: 1, [halfId]: 1, [groupId]: 3 });
});

after(async () => {
  if (!skip && influencerId) {
    await prisma.influencer.delete({ where: { id: influencerId } });
    await prisma.$executeRaw`DELETE FROM webhook_events WHERE event_id LIKE ${"evt_overlap_" + run + "%"}`;
  }
  await prisma.$disconnect();
});

test("a booking on one service blocks every overlapping time on the influencer's other services", { skip }, async () => {
  await hold(hourId, dayAt(8, 10)); // 10:00-11:00
  await assert.rejects(hold(halfId, dayAt(8, 10)), refused, "same start, other service");
  await assert.rejects(hold(halfId, dayAt(8, 10, 30)), refused, "starts inside");
  await assert.rejects(hold(groupId, dayAt(8, 10, 30)), refused, "a group seat at that time too");
  // Back to back is fine: 09:30-10:00 and 11:00-11:30 only touch it.
  await hold(halfId, dayAt(8, 9, 30));
  await hold(halfId, dayAt(8, 11));
  // A longer session that would start inside another one is refused the other way round as well.
  await assert.rejects(hold(hourId, dayAt(8, 10, 30)), refused);
});

test("the calendar leaves out the times another service has taken, and keeps the free ones", { skip }, async () => {
  await hold(hourId, dayAt(9, 14)); // 14:00-15:00
  const from = dayAt(9, 13);
  const to = dayAt(9, 16);
  const starts = (await openSlots(await bookable(halfId), from, to)).map((s) => s.start);
  assert.deepEqual(
    starts,
    [dayAt(9, 13), dayAt(9, 13, 30), dayAt(9, 15), dayAt(9, 15, 30)].map((d) => d.toISOString()),
    "14:00 and 14:30 are gone",
  );
  const hourStarts = (await openSlots(await bookable(hourId), from, to)).map((s) => s.start);
  assert.deepEqual(hourStarts, [dayAt(9, 13), dayAt(9, 15)].map((d) => d.toISOString()), "its own booked slot is full, as before");
});

test("a lapsed hold elsewhere blocks nothing", { skip }, async () => {
  const first = await hold(hourId, dayAt(10, 10));
  await prisma.booking.update({ where: { id: first.id }, data: { holdExpiresAt: new Date(Date.now() - MIN) } });
  await hold(halfId, dayAt(10, 10, 30));
});

test("the seats of one group session are still shared; another service at that time is not", { skip }, async () => {
  for (let i = 0; i < 3; i++) await hold(groupId, dayAt(11, 12));
  await assert.rejects(hold(groupId, dayAt(11, 12)), refused, "full");
  await assert.rejects(hold(halfId, dayAt(11, 12)), refused, "the host is in the workshop");
});

test("concurrent holds on two services at overlapping times: exactly one wins", { skip }, async () => {
  const results = await Promise.allSettled(
    Array.from({ length: 10 }, (_, i) => (i % 2 === 0 ? hold(hourId, dayAt(12, 10)) : hold(halfId, dayAt(12, 10, 30)))),
  );
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  for (const r of results) if (r.status === "rejected") assert.ok(refused(r.reason), String(r.reason));
});

test("a reschedule onto a time the host has booked on another service is refused", { skip }, async () => {
  const manage = await import("../lib/manage");
  const mine = await hold(halfId, dayAt(13, 9));
  const other = await hold(hourId, dayAt(13, 16)); // 16:00-17:00
  await prisma.booking.updateMany({ where: { id: { in: [mine.id, other.id] } }, data: { status: "SCHEDULED", holdExpiresAt: null } });
  const noop = async () => {};
  const deps = { google: {} as never, enqueueSendMessage: noop, sendBookingEmail: noop as never, cancelReminders: noop, enqueueReminders: noop, rearmMessage: noop, alert: noop as never };
  await assert.rejects(
    manage.rescheduleBooking(mine.id, dayAt(13, 16, 30), deps),
    (e: unknown) => e instanceof manage.RescheduleNotAllowedError && /another session at that time/.test(e.message),
  );
  const unchanged = await prisma.booking.findUniqueOrThrow({ where: { id: mine.id }, include: { session: true } });
  assert.equal(unchanged.session.startTime.getTime(), dayAt(13, 9).getTime());
  await manage.rescheduleBooking(mine.id, dayAt(13, 17), deps); // right after it: fine
  const moved = await prisma.booking.findUniqueOrThrow({ where: { id: mine.id }, include: { session: true } });
  assert.equal(moved.session.startTime.getTime(), dayAt(13, 17).getTime());
});

test("a late payment is refused when the host was booked on another service meanwhile", { skip }, async () => {
  const late = await hold(halfId, dayAt(14, 12)); // 12:00-12:30
  const orderId = `order_overlap_${run}`;
  await prisma.booking.update({ where: { id: late.id }, data: { status: "PENDING_PAYMENT", holdExpiresAt: new Date(Date.now() - MIN) } });
  await prisma.payment.create({ data: { bookingId: late.id, providerOrderId: orderId, amountMinor: 49900, currency: "INR" } });
  const other = await hold(hourId, dayAt(14, 11, 30)); // 11:30-12:30, taken after the first hold lapsed
  await prisma.booking.update({ where: { id: other.id }, data: { status: "PAID", holdExpiresAt: null } });

  const queued: string[] = [];
  await handleRazorpayEvent(
    `evt_overlap_${run}_a`,
    { event: "payment.captured", payload: { payment: { entity: { id: `pay_${orderId}`, order_id: orderId, amount: 49900, currency: "INR" } } } },
    async (id) => void queued.push(id),
  );
  assert.deepEqual(queued, []);
  assert.equal((await prisma.booking.findUniqueOrThrow({ where: { id: late.id } })).status, "FAILED");
  const payment = await prisma.payment.findUniqueOrThrow({ where: { providerOrderId: orderId } });
  assert.equal(payment.needsRefund, true);
  assert.match(payment.failureReason ?? "", /host was booked/);
});
