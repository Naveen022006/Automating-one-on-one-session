import { alertInfluencer } from "@/lib/alerts";
import { prisma } from "@/lib/db";
import {
  GoogleReconnectError,
  GoogleRequestError,
  GoogleTransientError,
  google as defaultGoogle,
  type GoogleClient,
} from "@/lib/google";
import { getRefreshToken as defaultGetRefreshToken, markReconnectNeeded } from "@/lib/google-tokens";
import { activeSeatWhere } from "@/lib/holds";
import { sendMessageForBooking } from "@/lib/messaging";
import {
  cancelReminders as defaultCancelReminders,
  enqueueReminders as defaultEnqueueReminders,
} from "@/lib/queue";
import { isSlotStart } from "@/lib/slots";

/**
 * The booking is in a state from which it cannot be rescheduled or cancelled the way the caller asked
 * (e.g. rescheduling a booking that was never scheduled, or a non-slot target time). Routes map this to 409.
 */
export class BookingNotReschedulableError extends Error {}
/** The request itself is bad: the target time is not a real slot, or is in the past. Routes map this to 400. */
export class BookingActionError extends Error {}

/** Statuses a reschedule is allowed from: the session is live (SCHEDULED) or paid but not yet scheduled. */
const RESCHEDULABLE_STATUSES = new Set(["SCHEDULED", "PAID"]);
/** Terminal statuses: a cancel on any of these is a no-op (already settled). */
const TERMINAL_STATUSES = new Set(["CANCELLED", "EXPIRED", "COMPLETED", "FAILED"]);

export type RescheduleOutcome = "rescheduled";
export type CancelOutcome = "cancelled" | "already-cancelled";

export interface BookingActionDeps {
  google: GoogleClient;
  getRefreshToken: typeof defaultGetRefreshToken;
  cancelReminders: (bookingId: string) => Promise<void>;
  enqueueReminders: (bookingId: string, startTime: Date) => Promise<void>;
  /** Delivers a customer message, reusing the FEAT-002 WhatsApp->SMS fallback and the Message row. */
  sendMessage: typeof sendMessageForBooking;
  alert: typeof alertInfluencer;
}

const defaultDeps: BookingActionDeps = {
  google: defaultGoogle,
  getRefreshToken: defaultGetRefreshToken,
  cancelReminders: (id) => defaultCancelReminders(id),
  enqueueReminders: (id, startTime) => defaultEnqueueReminders(id, startTime),
  sendMessage: sendMessageForBooking,
  alert: alertInfluencer,
};

/**
 * Refreshes the influencer's Google access token the same way lib/meeting.ts does, and translates the token
 * state into the typed errors the Calendar helpers already use. A dead grant surfaces as GoogleReconnectError
 * so the caller can treat it uniformly with a 401 from Calendar.
 */
async function accessTokenFor(deps: BookingActionDeps, influencerId: string): Promise<string> {
  const token = await deps.getRefreshToken(influencerId);
  if (token.state === "not-connected") {
    throw new GoogleReconnectError("Google Calendar has not been connected");
  }
  if (token.state === "reconnect-needed") {
    throw new GoogleReconnectError(token.reason ?? "Google connection needs to be renewed");
  }
  return deps.google.refreshAccessToken(token.refreshToken);
}

/**
 * Moves a booking to a new slot time: relocates the Session, shifts the Google Calendar event, replaces the
 * reminder jobs so ONLY the new ones remain, and sends an update message.
 *
 * Mirrors lib/meeting.ts: the booking is re-read at run time (never trusted from enqueue/request time) and the
 * operation is idempotent. Allowed only while the booking is SCHEDULED or PAID; any other status raises
 * BookingNotReschedulableError. The target time must be a real availability slot and in the future, and the
 * target seat must be free - all checked under the same FOR UPDATE session lock + capacity pattern as
 * lib/holds.ts createHold, inside a single transaction.
 */
export async function rescheduleBooking(
  bookingId: string,
  newStartTime: Date,
  overrides: Partial<BookingActionDeps> = {},
): Promise<RescheduleOutcome> {
  const deps = { ...defaultDeps, ...overrides };

  const booking = await prisma.booking.findUnique({
    where: { id: bookingId },
    include: { session: { include: { service: { include: { influencer: { include: { rules: true } } } } } } },
  });
  if (!booking) throw new BookingNotReschedulableError(`Booking ${bookingId} not found`);
  if (!RESCHEDULABLE_STATUSES.has(booking.status)) {
    throw new BookingNotReschedulableError(`Booking is ${booking.status} and cannot be rescheduled`);
  }

  const { service } = booking.session;
  const { influencer } = service;

  // Validate the target time before touching anything: it must be a real slot and in the future.
  if (newStartTime <= new Date()) {
    throw new BookingActionError("The new time is in the past");
  }
  if (!isSlotStart(influencer.rules, service.durationMin, newStartTime)) {
    throw new BookingActionError("That time is not available");
  }

  const newEndTime = new Date(newStartTime.getTime() + service.durationMin * 60_000);

  // Nothing to do if the booking is already on the requested slot (idempotent re-run / no-op reschedule).
  if (booking.session.startTime.getTime() === newStartTime.getTime()) {
    return "rescheduled";
  }

  const fail = (message: string) =>
    prisma.booking.update({ where: { id: booking.id }, data: { lastError: message.slice(0, 500) } });

  // 1) Relocate the booking to a session at the new time, serialising on the target session row so the
  //    capacity check cannot be raced (same lock pattern as createHold).
  try {
    await prisma.$transaction(async (tx) => {
      // Idempotent create of the target session: the (service_id, start_time) unique constraint is race-safe.
      await tx.$executeRaw`
        INSERT INTO sessions (id, service_id, start_time, end_time, created_at)
        VALUES (${"s_" + crypto.randomUUID()}, ${service.id}, ${newStartTime}, ${newEndTime}, now())
        ON CONFLICT (service_id, start_time) DO NOTHING`;

      const rows = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM sessions
        WHERE service_id = ${service.id} AND start_time = ${newStartTime}
        FOR UPDATE`;
      const targetSessionId = rows[0].id;

      const now = new Date();
      // Count seats taken on the target session, excluding this booking (it may already sit there on a retry).
      const taken = await tx.booking.count({
        where: { sessionId: targetSessionId, id: { not: booking.id }, ...activeSeatWhere(now) },
      });
      if (taken >= service.capacity) {
        throw new BookingActionError("That time is no longer available");
      }

      await tx.booking.update({ where: { id: booking.id }, data: { sessionId: targetSessionId } });
    });
  } catch (e) {
    // A capacity/validation failure is the caller's problem; surface it unchanged (no lastError churn).
    if (e instanceof BookingActionError || e instanceof BookingNotReschedulableError) throw e;
    await fail(e instanceof Error ? e.message : String(e));
    throw e;
  }

  // 2) Replace the reminders BEFORE any fallible Calendar/messaging step, so a transient failure below can
  //    never leave a SCHEDULED booking with no reminders. The old jobs are dropped first, then fresh jobs for
  //    the NEW time are enqueued (enqueueReminders itself does a remove-then-add replace and the new jobs carry
  //    expectedStartTime, checked at run time), so ONLY the new reminders remain. This is the Phase 5 "a
  //    rescheduled booking sends only the new reminders" outcome, and the deterministic ids make a re-driven
  //    reschedule (after a later-step failure) idempotent.
  await deps.cancelReminders(booking.id);
  await deps.enqueueReminders(booking.id, newStartTime);

  // 3) Shift the Calendar event to the new start/end. Mirror lib/meeting.ts error handling / token refresh.
  //    The booking has already moved and its reminders already point at the new time, so a transient failure
  //    here records lastError and surfaces (route -> 409) WITHOUT undoing the move: re-running rescheduleBooking
  //    for the same slot is a no-op on the session (idempotent) and simply re-patches the event.
  if (booking.eventId) {
    try {
      const accessToken = await accessTokenFor(deps, influencer.id);
      await deps.google.updateEvent(accessToken, booking.eventId, { start: newStartTime, end: newEndTime });
    } catch (e) {
      if (e instanceof GoogleReconnectError) {
        // The grant is dead. Flag the influencer once and surface it; the booking has already moved in the DB
        // and the reminders already target the new time, so this is a recoverable state.
        const notify = await markReconnectNeeded(influencer.id, e.message);
        await fail(`Waiting for ${influencer.name} to reconnect Google Calendar: ${e.message}`);
        if (notify) {
          await deps.alert(influencer.id, {
            kind: "google-reconnect-needed",
            detail: e.message,
            bookingId: booking.id,
          });
        }
        throw e;
      }
      if (e instanceof GoogleRequestError || e instanceof GoogleTransientError) {
        await fail(e.message);
        throw e;
      }
      await fail(e instanceof Error ? e.message : String(e));
      throw e;
    }
  }

  // 4) Tell the customer the booking moved, and clear any recorded error now that the reschedule succeeded.
  await deps.sendMessage(booking.id, "reschedule");
  await prisma.booking.update({ where: { id: booking.id }, data: { lastError: null } });

  return "rescheduled";
}

/**
 * Cancels a booking: marks it CANCELLED, deletes the Google Calendar event, drops the pending reminders,
 * notifies the customer, and flags a captured payment for refund.
 *
 * Mirrors lib/meeting.ts: the booking is re-read at run time and the operation is idempotent. A booking that
 * is already CANCELLED/EXPIRED/COMPLETED/FAILED returns "already-cancelled" without a second delete or alert.
 */
export async function cancelBooking(
  bookingId: string,
  reason?: string,
  overrides: Partial<BookingActionDeps> = {},
): Promise<CancelOutcome> {
  const deps = { ...defaultDeps, ...overrides };

  const booking = await prisma.booking.findUnique({
    where: { id: bookingId },
    include: { session: { include: { service: { include: { influencer: true } } } }, payments: true },
  });
  if (!booking) throw new BookingNotReschedulableError(`Booking ${bookingId} not found`);
  // Terminal already: nothing to delete, nobody to notify a second time.
  if (TERMINAL_STATUSES.has(booking.status)) return "already-cancelled";

  const detail = reason ? `booking cancelled: ${reason}` : "booking cancelled";

  // Notify the customer BEFORE flipping to CANCELLED: the messaging layer only sends for live statuses
  // (PAID/SCHEDULED/COMPLETED), so a cancellation sent after the flip would be skipped. On an idempotent
  // re-run the terminal-status short-circuit above means this never fires twice.
  //
  // The send must NOT be able to abort the cancel: a transient WhatsApp+SMS outage used to throw out of here
  // before the booking was marked CANCELLED, the event deleted, or the reminders dropped, leaving the cancel
  // fully blocked by a messaging hiccup. We now tolerate a send failure here (it is logged and the customer
  // still learns of the cancellation through the confirmation page / email) and proceed with the cancel. The
  // messaging layer records its own failure/alert on the Message row, so the outage is still surfaced.
  try {
    await deps.sendMessage(booking.id, "cancellation");
  } catch (e) {
    console.error(
      `[cancel] cancellation message failed for booking ${booking.id}; proceeding with cancel: ${
        e instanceof Error ? e.message : String(e)
      }`,
    );
  }

  // All DB mutations in one transaction: mark CANCELLED and flag any captured payment for refund.
  await prisma.$transaction(async (tx) => {
    await tx.booking.update({
      where: { id: booking.id },
      data: { status: "CANCELLED", lastError: null },
    });
    // Refund policy: money that was captured must be returned. We only flag it here (mirrors the needsRefund
    // usage in lib/payment-webhook.ts); the actual money movement is out of scope for Phase 5.
    // TODO(phase-6): issue the Razorpay refund for payments flagged needsRefund and set status REFUNDED.
    await tx.payment.updateMany({
      where: { bookingId: booking.id, status: "CAPTURED" },
      data: { needsRefund: true, failureReason: detail },
    });
  });

  // Delete the Calendar event (a 404/410 is treated as success by the client). Done after the DB flip so a
  // retry still finds the booking CANCELLED and short-circuits before a second delete.
  if (booking.eventId) {
    const accessToken = await accessTokenFor(deps, booking.session.service.influencer.id);
    await deps.google.deleteEvent(accessToken, booking.eventId);
  }

  // Drop the pending reminder jobs so no stale 24h/15m reminder fires for a cancelled booking.
  await deps.cancelReminders(booking.id);

  return "cancelled";
}
