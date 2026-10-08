import "dotenv/config";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import {
  BookingNotReschedulableError,
  cancelBooking,
  rescheduleBooking,
  type BookingActionDeps,
} from "../lib/booking-actions";
import type { CalendarEvent, EventPatch, GoogleClient, NewEvent } from "../lib/google";
import type { MessageOutcome } from "../lib/messaging";
import type { TokenLookup } from "../lib/google-tokens";
import { prisma } from "../lib/db";
import { createHold } from "../lib/holds";

// Integration tests: rescheduleBooking/cancelBooking re-read a real booking row, so they need a migrated
// Postgres at DATABASE_URL (skipped otherwise, matching tests/payments.test.ts). The Google client, queue
// helpers and messaging are all injected as fakes, so no Redis/Google is contacted.
const skip = process.env.DATABASE_URL ? false : "DATABASE_URL not set";

const run = Date.now();
let n = 0;
let influencerId: string;
let serviceId: string;

// Availability rules that cover every weekday for the whole day, so any aligned 30-min UTC start is a slot.
const EVERY_DAY_RULES = Array.from({ length: 7 }, (_, i) => ({
  weekday: i + 1,
  startTime: "00:00",
  endTime: "23:30",
  timezone: "UTC",
}));

/** An aligned 30-min UTC slot `days` days from now. */
function slotIn(days: number): Date {
  const d = new Date(Date.now() + days * 86_400_000);
  d.setUTCMinutes(0, 0, 0);
  return d;
}

/**
 * Records every injected call in order so a test can assert, for example, that cancelReminders ran before
 * enqueueReminders, and with what start time.
 */
function actionFakes(tokenState: TokenLookup = { state: "ok", refreshToken: "rt" }) {
  const calls: string[] = [];
  const updatedEvents: Array<{ eventId: string; patch: EventPatch }> = [];
  const deletedEvents: string[] = [];
  const reminderEnqueues: Array<{ bookingId: string; startTime: Date }> = [];
  const messages: Array<{ bookingId: string; template: string }> = [];

  const google: GoogleClient = {
    refreshAccessToken: async () => {
      calls.push("refreshAccessToken");
      return "access-token";
    },
    insertEvent: async (_t, _e: NewEvent): Promise<CalendarEvent> => {
      throw new Error("not used");
    },
    getEvent: async (): Promise<CalendarEvent | null> => null,
    updateEvent: async (_t, eventId, patch): Promise<CalendarEvent> => {
      calls.push("updateEvent");
      updatedEvents.push({ eventId, patch });
      return { id: eventId, status: "confirmed", meetLink: null, conferenceStatus: "none" };
    },
    deleteEvent: async (_t, eventId) => {
      calls.push("deleteEvent");
      deletedEvents.push(eventId);
    },
  };

  const deps: Partial<BookingActionDeps> = {
    google,
    getRefreshToken: async (): Promise<TokenLookup> => tokenState,
    cancelReminders: async () => void calls.push("cancelReminders"),
    enqueueReminders: async (bookingId, startTime) => {
      calls.push("enqueueReminders");
      reminderEnqueues.push({ bookingId, startTime });
    },
    sendMessage: async (bookingId, template): Promise<MessageOutcome> => {
      calls.push(`sendMessage:${template}`);
      messages.push({ bookingId, template });
      return "sent";
    },
    alert: async () => void calls.push("alert"),
  };

  return { deps, calls, updatedEvents, deletedEvents, reminderEnqueues, messages };
}

async function makeBooking(opts: {
  status: string;
  startTime: Date;
  eventId?: string | null;
}): Promise<string> {
  const hold = await createHold({
    serviceId,
    startTime: opts.startTime,
    endTime: new Date(opts.startTime.getTime() + 30 * 60_000),
    capacity: 1,
    customerName: "Action Tester",
    customerEmail: `action${run}_${++n}@example.com`,
    whatsappE164: "+919876543210",
    whatsappOptIn: true,
  });
  await prisma.booking.update({
    where: { id: hold.id },
    data: { status: opts.status as never, eventId: opts.eventId ?? null, meetLink: opts.eventId ? "https://meet" : null },
  });
  return hold.id;
}

before(async () => {
  if (skip) return;
  const inf = await prisma.influencer.create({
    data: {
      slug: `action-${run}`,
      name: "Action Test",
      email: `action${run}@example.com`,
      rules: { create: EVERY_DAY_RULES },
    },
  });
  influencerId = inf.id;
  serviceId = (
    await prisma.service.create({ data: { influencerId, title: "1:1", durationMin: 30, priceMinor: 49900 } })
  ).id;
});

after(async () => {
  if (!skip && influencerId) {
    await prisma.influencer.delete({ where: { id: influencerId } });
  }
  await prisma.$disconnect();
});

test("reschedule updates the event, then cancels old reminders before enqueueing new ones for the new time", { skip }, async () => {
  const bookingId = await makeBooking({ status: "SCHEDULED", startTime: slotIn(5), eventId: "evt_resched" });
  const newStart = slotIn(9);
  const { deps, calls, updatedEvents, reminderEnqueues, messages } = actionFakes();

  const outcome = await rescheduleBooking(bookingId, newStart, deps);
  assert.equal(outcome, "rescheduled");

  // Calendar event was patched to the new window.
  assert.equal(updatedEvents.length, 1);
  assert.equal(updatedEvents[0].eventId, "evt_resched");
  assert.equal(updatedEvents[0].patch.start?.getTime(), newStart.getTime());

  // Ordering is the key spec outcome. Reminders are replaced (cancel BEFORE enqueue, only the new ones remain)
  // and that replacement happens BEFORE the fallible Calendar patch, so a transient updateEvent failure can
  // never leave a SCHEDULED booking with no reminders (review issues 2 & 4).
  const iUpdate = calls.indexOf("updateEvent");
  const iCancel = calls.indexOf("cancelReminders");
  const iEnqueue = calls.indexOf("enqueueReminders");
  assert.ok(iUpdate >= 0 && iCancel >= 0 && iEnqueue >= 0);
  assert.ok(iCancel < iEnqueue, "cancelReminders must run before enqueueReminders (only the new reminders remain)");
  assert.ok(iEnqueue < iUpdate, "reminders must be replaced before the fallible Calendar patch (recoverable state)");

  // The new reminders are enqueued for the NEW start time, not the old one.
  assert.equal(reminderEnqueues.length, 1);
  assert.equal(reminderEnqueues[0].startTime.getTime(), newStart.getTime());

  // Customer is told the booking moved.
  assert.deepEqual(messages, [{ bookingId, template: "reschedule" }]);

  // The booking now sits on a session at the new time.
  const moved = await prisma.booking.findUniqueOrThrow({ where: { id: bookingId }, include: { session: true } });
  assert.equal(moved.session.startTime.getTime(), newStart.getTime());
  assert.equal(moved.lastError, null);
});

test("reschedule of a PAID booking (no eventId yet) enqueues reminders and skips updateEvent", { skip }, async () => {
  // A PAID booking has not been scheduled on the calendar yet, so there is no eventId to patch. The reminder
  // replacement must still run for the new time; the deterministic ids dedupe the later createMeeting enqueue.
  const bookingId = await makeBooking({ status: "PAID", startTime: slotIn(5), eventId: null });
  const newStart = slotIn(11);
  const { deps, calls, updatedEvents, reminderEnqueues, messages } = actionFakes();

  const outcome = await rescheduleBooking(bookingId, newStart, deps);
  assert.equal(outcome, "rescheduled");

  // No calendar event exists, so updateEvent (and the token refresh behind it) is skipped entirely.
  assert.equal(updatedEvents.length, 0);
  assert.ok(!calls.includes("updateEvent"), "updateEvent must be skipped when the booking has no eventId");

  // Reminders are still replaced for the new time, and the customer is still told the booking moved.
  const iCancel = calls.indexOf("cancelReminders");
  const iEnqueue = calls.indexOf("enqueueReminders");
  assert.ok(iCancel >= 0 && iEnqueue >= 0 && iCancel < iEnqueue);
  assert.equal(reminderEnqueues.length, 1);
  assert.equal(reminderEnqueues[0].startTime.getTime(), newStart.getTime());
  assert.deepEqual(messages, [{ bookingId, template: "reschedule" }]);

  const moved = await prisma.booking.findUniqueOrThrow({ where: { id: bookingId }, include: { session: true } });
  assert.equal(moved.session.startTime.getTime(), newStart.getTime());
});

test("reschedule leaves a recoverable state when the Calendar patch fails transiently", { skip }, async () => {
  // Review issue 4: a transient updateEvent failure must not strand the move. The session should already be
  // moved and the reminders already replaced for the new time BEFORE the patch is attempted, so the operation
  // is re-drivable; the failure surfaces with lastError recorded.
  const bookingId = await makeBooking({ status: "SCHEDULED", startTime: slotIn(5), eventId: "evt_fail" });
  const newStart = slotIn(12);
  const { deps, calls } = actionFakes();
  // Make the Calendar patch throw a transient Google error.
  const { GoogleTransientError } = await import("../lib/google");
  deps.google!.updateEvent = async () => {
    calls.push("updateEvent");
    throw new GoogleTransientError("calendar unavailable");
  };

  await assert.rejects(() => rescheduleBooking(bookingId, newStart, deps), /calendar unavailable/);

  // The session move committed and the reminders were replaced before the patch was attempted.
  const moved = await prisma.booking.findUniqueOrThrow({ where: { id: bookingId }, include: { session: true } });
  assert.equal(moved.session.startTime.getTime(), newStart.getTime());
  const iCancel = calls.indexOf("cancelReminders");
  const iEnqueue = calls.indexOf("enqueueReminders");
  const iUpdate = calls.indexOf("updateEvent");
  assert.ok(iCancel >= 0 && iEnqueue >= 0 && iUpdate >= 0);
  assert.ok(iEnqueue < iUpdate, "reminders are replaced before the Calendar patch, so the state is recoverable");
  // lastError records the transient failure for the dashboard flag / re-drive.
  assert.ok((moved.lastError ?? "").includes("calendar unavailable"));
});

test("reschedule of a non-SCHEDULED/PAID booking throws BookingNotReschedulableError", { skip }, async () => {
  const bookingId = await makeBooking({ status: "CANCELLED", startTime: slotIn(6) });
  const { deps, calls } = actionFakes();
  await assert.rejects(
    () => rescheduleBooking(bookingId, slotIn(10), deps),
    BookingNotReschedulableError,
  );
  // Nothing was touched.
  assert.deepEqual(calls, []);
});

test("cancel deletes the event, cancels reminders, sends a cancellation message and flags a captured payment", { skip }, async () => {
  const bookingId = await makeBooking({ status: "SCHEDULED", startTime: slotIn(7), eventId: "evt_cancel" });
  await prisma.payment.create({
    data: {
      bookingId,
      providerOrderId: `order_cancel_${run}_${n}`,
      providerPaymentId: `pay_cancel_${run}_${n}`,
      amountMinor: 49900,
      currency: "INR",
      status: "CAPTURED",
    },
  });
  const { deps, calls, deletedEvents, messages } = actionFakes();

  const outcome = await cancelBooking(bookingId, "customer asked", deps);
  assert.equal(outcome, "cancelled");

  assert.deepEqual(deletedEvents, ["evt_cancel"]);
  assert.ok(calls.includes("cancelReminders"));
  assert.deepEqual(messages, [{ bookingId, template: "cancellation" }]);

  const booking = await prisma.booking.findUniqueOrThrow({ where: { id: bookingId } });
  assert.equal(booking.status, "CANCELLED");
  const payment = await prisma.payment.findFirstOrThrow({ where: { bookingId } });
  assert.equal(payment.needsRefund, true);
  assert.match(payment.failureReason ?? "", /booking cancelled/);
});

test("cancel still completes when the cancellation message send throws (review issue 3)", { skip }, async () => {
  // A transient WhatsApp+SMS outage must NOT abort the cancel: the booking should still flip to CANCELLED, the
  // event be deleted, and the reminders dropped even though the notification send threw.
  const bookingId = await makeBooking({ status: "SCHEDULED", startTime: slotIn(13), eventId: "evt_msgfail" });
  const { deps, calls, deletedEvents } = actionFakes();
  deps.sendMessage = async () => {
    calls.push("sendMessage:cancellation");
    throw new Error("whatsapp and sms both down");
  };

  const outcome = await cancelBooking(bookingId, "customer asked", deps);
  assert.equal(outcome, "cancelled");

  // The messaging failure did not block any of the cancel side effects.
  assert.deepEqual(deletedEvents, ["evt_msgfail"]);
  assert.ok(calls.includes("cancelReminders"));
  const booking = await prisma.booking.findUniqueOrThrow({ where: { id: bookingId } });
  assert.equal(booking.status, "CANCELLED");
});

test("cancel is idempotent on an already-CANCELLED booking (no second delete or alert)", { skip }, async () => {
  const bookingId = await makeBooking({ status: "CANCELLED", startTime: slotIn(8), eventId: "evt_already" });
  const { deps, calls, deletedEvents, messages } = actionFakes();

  const outcome = await cancelBooking(bookingId, undefined, deps);
  assert.equal(outcome, "already-cancelled");

  // No calendar delete, no reminder cancel, no message, no alert on a terminal booking.
  assert.deepEqual(deletedEvents, []);
  assert.deepEqual(messages, []);
  assert.deepEqual(calls, []);
});
