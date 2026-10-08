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

/** The minimal booking shape the reminder needs: just the run-time status. */
export interface ReminderBooking {
  id: string;
  status: string;
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
    prisma.booking.findUnique({ where: { id: bookingId }, select: { id: true, status: true } }),
  sendMessage: sendMessageForBooking,
  alert: alertInfluencer,
};

/**
 * Sends a session reminder for a booking.
 *
 * Mirrors lib/meeting.ts: the booking status is re-read from the database at run time and never trusted from
 * the job data captured at enqueue time. If the booking is no longer SCHEDULED (cancelled, rescheduled to a
 * new event, completed or failed) the reminder is skipped WITHOUT sending. This is what makes a rescheduled
 * booking send only the new reminders: the stale 24h/15m jobs for the old time run, see a non-SCHEDULED (or
 * re-timed) booking, and quietly skip, while cancelReminders + enqueueReminders install the new ones.
 *
 * When the booking is SCHEDULED the reminder is delivered via the messaging layer (WhatsApp with SMS
 * fallback, recorded on a deterministic Message row keyed on (bookingId, template)). A transient delivery
 * failure is rethrown by the messaging layer so BullMQ retries with backoff.
 */
export async function sendReminderForBooking(
  bookingId: string,
  kind: ReminderKind,
  overrides: Partial<ReminderDeps> = {},
): Promise<ReminderOutcome> {
  const deps = { ...defaultDeps, ...overrides };

  const booking = await deps.findBooking(bookingId);
  if (!booking) {
    console.warn(`[send-reminder] booking ${bookingId} not found, skipping`);
    return "skipped";
  }
  // Status read at run time: a booking cancelled or rescheduled since the reminder was enqueued is skipped.
  if (booking.status !== "SCHEDULED") {
    console.log(`[send-reminder] booking ${bookingId} is ${booking.status}, not SCHEDULED; skipping ${kind} reminder`);
    return "skipped";
  }

  const template = REMINDER_TEMPLATES[kind];
  const outcome = await deps.sendMessage(bookingId, template);
  // sendMessageForBooking may also skip (opt-out / non-sendable); surface its outcome as-is.
  return outcome;
}
