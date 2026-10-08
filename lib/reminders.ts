import { alertInfluencer } from "@/lib/alerts";
import { prisma } from "@/lib/db";
import { sendMessageForBooking } from "@/lib/messaging";
import type { ReminderKind } from "@/lib/queue";

export type ReminderOutcome = "sent" | "already-sent" | "skipped";

/** Reminders only make sense while the booking is still a live, scheduled session. */
const REMINDER_TEMPLATES: Record<ReminderKind, string> = {
  "24h": "reminder-24h",
  "15m": "reminder-15m",
};

/**
 * The minimal booking shape the reminder needs: the run-time status and the CURRENT session start time. The
 * start time is the fire-time backstop for a reschedule (which leaves the booking SCHEDULED): a stale reminder
 * whose job data was enqueued for the OLD time no longer matches session.startTime and is skipped.
 */
export interface ReminderBooking {
  id: string;
  status: string;
  session: { startTime: Date };
}

export interface ReminderDeps {
  /**
   * Reads the latest booking state at run time. Defaults to a fresh prisma query; injectable so the status
   * check can be unit-tested without a database.
   */
  findBooking: (bookingId: string) => Promise<ReminderBooking | null>;
  /** Delivers the reminder message, reusing the FEAT-002 WhatsApp->SMS fallback and the Message row. */
  sendMessage: typeof sendMessageForBooking;
  alert: typeof alertInfluencer;
}

const defaultDeps: ReminderDeps = {
  findBooking: (bookingId) =>
    prisma.booking.findUnique({
      where: { id: bookingId },
      select: { id: true, status: true, session: { select: { startTime: true } } },
    }),
  sendMessage: sendMessageForBooking,
  alert: alertInfluencer,
};

/**
 * Sends a session reminder for a booking.
 *
 * Mirrors lib/meeting.ts: the booking status is re-read from the database at run time and never trusted from
 * the job data captured at enqueue time. If the booking is no longer SCHEDULED (cancelled, completed or
 * failed) the reminder is skipped WITHOUT sending.
 *
 * The run-time guard also backstops a RESCHEDULE. A reschedule leaves the booking SCHEDULED, so the status
 * check alone cannot tell a stale reminder apart from a live one. The job therefore carries the start time it
 * was enqueued for (`expectedStartTime`); when that no longer matches the booking's current session start, the
 * job is a leftover for the old time and is skipped. This is what makes "a rescheduled booking sends only the
 * new reminders" a real run-time guarantee rather than one that depends solely on cancelReminders succeeding.
 *
 * When the booking is SCHEDULED and the fire time still matches, the reminder is delivered via the messaging
 * layer (WhatsApp with SMS fallback, recorded on a deterministic Message row keyed on (bookingId, template)).
 * A transient delivery failure is rethrown by the messaging layer so BullMQ retries with backoff.
 */
export async function sendReminderForBooking(
  bookingId: string,
  kind: ReminderKind,
  expectedStartTime?: Date,
  overrides: Partial<ReminderDeps> = {},
): Promise<ReminderOutcome> {
  const deps = { ...defaultDeps, ...overrides };

  const booking = await deps.findBooking(bookingId);
  if (!booking) {
    console.warn(`[send-reminder] booking ${bookingId} not found, skipping`);
    return "skipped";
  }
  // Status read at run time: a booking cancelled or completed since the reminder was enqueued is skipped.
  if (booking.status !== "SCHEDULED") {
    console.log(`[send-reminder] booking ${bookingId} is ${booking.status}, not SCHEDULED; skipping ${kind} reminder`);
    return "skipped";
  }
  // Fire-time backstop: a reschedule keeps the booking SCHEDULED but moves session.startTime. A reminder whose
  // job data was enqueued for a different time is a stale leftover for the old slot; skip it so only the
  // reminders enqueued for the current time ever fire.
  if (expectedStartTime && expectedStartTime.getTime() !== booking.session.startTime.getTime()) {
    console.log(
      `[send-reminder] booking ${bookingId} ${kind} reminder was for ${expectedStartTime.toISOString()} but the ` +
        `session is now ${booking.session.startTime.toISOString()}; skipping stale reminder`,
    );
    return "skipped";
  }

  const template = REMINDER_TEMPLATES[kind];
  const outcome = await deps.sendMessage(bookingId, template);
  // sendMessageForBooking may also skip (opt-out / non-sendable); surface its outcome as-is.
  return outcome;
}
