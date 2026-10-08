import { alertInfluencer } from "@/lib/alerts";
import { prisma } from "@/lib/db";
import { sendBookingEmail } from "@/lib/email";
import {
  GoogleReconnectError,
  GoogleRequestError,
  google as defaultGoogle,
  type GoogleClient,
} from "@/lib/google";
import { getRefreshToken } from "@/lib/google-tokens";
import { activeSeatWhere } from "@/lib/holds";
import { calendarEventId, sessionEventId } from "@/lib/meeting";
import { createMessage } from "@/lib/messages";
import { enqueueSendMessage } from "@/lib/queue";
import { blockedDaySet, isSlotStart, type Rule } from "@/lib/slots";

export { SELF_SERVICE_PURPOSE, buildSelfServiceUrl, verifySelfServiceToken } from "@/lib/self-service";

/** The influencer must reconnect Google before this calendar change can go through. The DB change is kept. */
export class ManageBlockedError extends Error {}
/** Google rejected the change for good (deleted event, bad request); recorded for manual attention. */
export class ManageRejectedError extends Error {}
export class BookingNotManageableError extends Error {}
/** The requested reschedule time is in the past, off the influencer's schedule, on a blocked day, or clashes. */
export class RescheduleNotAllowedError extends Error {}

/**
 * Pure, DB-free check that `newStart` is a legal time to reschedule onto, mirroring the hold route's gate
 * (app/api/bookings/hold/route.ts): the time must be in the future AND a real slot start out of the
 * influencer's availability rules that does not fall on a blocked day. Kept pure (rules + blocked days are
 * passed in) so it is unit-testable without a DB, like lib/slots.ts. Returns null when ok, or a reason string.
 */
export function validateRescheduleTime(args: {
  rules: Rule[];
  durationMin: number;
  newStart: Date;
  blockedDates: ReadonlySet<string>;
  now?: Date;
}): string | null {
  const { rules, durationMin, newStart, blockedDates } = args;
  const now = args.now ?? new Date();
  if (Number.isNaN(newStart.getTime())) return "The new time is not a valid date";
  if (newStart <= now) return "The new time must be in the future";
  if (!isSlotStart(rules, durationMin, newStart, blockedDates)) {
    return "That time is not available";
  }
  return null;
}

export interface ManageDeps {
  google: GoogleClient;
  enqueueSendMessage: (bookingId: string) => Promise<void>;
  sendBookingEmail: typeof sendBookingEmail;
  alert: typeof alertInfluencer;
}

const defaultDeps: ManageDeps = {
  google: defaultGoogle,
  enqueueSendMessage: (id) => enqueueSendMessage(id),
  sendBookingEmail,
  alert: alertInfluencer,
};

/** Statuses whose booking still has a live session the customer/influencer can act on. */
const MANAGEABLE = ["PAID", "SCHEDULED"] as const;

type BookingWithContext = NonNullable<Awaited<ReturnType<typeof loadBooking>>>;

function loadBooking(bookingId: string) {
  return prisma.booking.findUnique({
    where: { id: bookingId },
    include: {
      session: {
        include: { service: { include: { influencer: { include: { rules: true } } } }, bookings: true },
      },
      payments: { where: { status: "CAPTURED" } },
    },
  });
}

/**
 * Re-notifies the customer of a change: records a WhatsApp message under `template`, re-enqueues delivery, and
 * (for a reschedule) sends a fresh confirmation email with the new time. Cancellations skip the email because
 * the only email kinds are confirmation/receipt. All best-effort / non-throwing, like the create path.
 */
async function renotify(deps: ManageDeps, bookingId: string, template: string, sendEmail: boolean): Promise<void> {
  await createMessage({ bookingId, channel: "whatsapp", template, status: "queued" });
  if (sendEmail) await deps.sendBookingEmail(bookingId, "booking-confirmation");
  await deps.enqueueSendMessage(bookingId);
}

/**
 * Re-sends the booking confirmation (email + queued WhatsApp message) without touching the Calendar event.
 * Used by the influencer "resend link" action. Best-effort recording like the create path.
 */
export async function resendBookingLink(bookingId: string, overrides: Partial<ManageDeps> = {}): Promise<void> {
  const deps = { ...defaultDeps, ...overrides };
  const booking = await prisma.booking.findUnique({ where: { id: bookingId }, select: { id: true } });
  if (!booking) throw new BookingNotManageableError("Booking not found");
  await createMessage({ bookingId, channel: "whatsapp", template: "booking-confirmation", status: "queued" });
  await deps.sendBookingEmail(bookingId, "booking-confirmation");
  await deps.enqueueSendMessage(bookingId);
}

/** Resolves an access token for the booking's influencer, or throws ManageBlockedError if not connected. */
async function accessTokenFor(deps: ManageDeps, booking: BookingWithContext): Promise<string> {
  const influencerId = booking.session.service.influencer.id;
  const token = await getRefreshToken(influencerId);
  if (token.state !== "ok") {
    throw new ManageBlockedError("The influencer's Google Calendar is not connected; the change was saved but the calendar was not updated");
  }
  try {
    return await deps.google.refreshAccessToken(token.refreshToken);
  } catch (e) {
    if (e instanceof GoogleReconnectError) throw new ManageBlockedError(e.message);
    throw e;
  }
}

/**
 * Cancels a booking: marks it CANCELLED, updates the shared/1:1 Calendar event, flags the payment for refund
 * if money was captured, and re-notifies the customer. The DB change always happens; a calendar failure is
 * best-effort (recorded + alerted) so a cancel is never blocked by Google being unreachable.
 *
 *  - 1:1    -> delete the booking's own event.
 *  - GROUP  -> remove ONLY this attendee from the shared session event; delete the event (and clear the
 *              session's shared fields) only when the last attendee has left. Preserves the shared-event
 *              invariant from FEAT-002.
 */
export async function cancelBooking(bookingId: string, overrides: Partial<ManageDeps> = {}): Promise<void> {
  const deps = { ...defaultDeps, ...overrides };
  const booking = await loadBooking(bookingId);
  if (!booking) throw new BookingNotManageableError("Booking not found");
  if (!MANAGEABLE.includes(booking.status as (typeof MANAGEABLE)[number]) && booking.status !== "FAILED") {
    throw new BookingNotManageableError(`Booking cannot be cancelled while it is ${booking.status}`);
  }

  const { session } = booking;
  const { service } = session;
  const influencerId = service.influencer.id;
  const isGroup = service.type === "GROUP";

  // 1) DB: cancel the booking and flag any captured payment for refund (mirrors needsRefund in lib/payment-webhook.ts).
  await prisma.booking.update({ where: { id: booking.id }, data: { status: "CANCELLED", lastError: null } });
  if (booking.payments.length > 0) {
    await prisma.payment.updateMany({
      where: { bookingId: booking.id, status: "CAPTURED" },
      data: { needsRefund: true, failureReason: "booking cancelled" },
    });
  }

  // 2) Calendar (best-effort): remove the attendee / delete the event.
  if (booking.eventId || session.eventId) {
    try {
      const accessToken = await accessTokenFor(deps, booking);
      if (isGroup) {
        const eventId = session.eventId ?? sessionEventId(session.id);
        const { remaining } = await deps.google.removeAttendee(accessToken, eventId, booking.customerEmail);
        // The last attendee has left: drop the shared event and clear the session's shared fields.
        if (remaining === 0) {
          await deps.google.deleteEvent(accessToken, eventId);
          await prisma.session.update({ where: { id: session.id }, data: { eventId: null, meetLink: null } });
        }
      } else if (booking.eventId) {
        await deps.google.deleteEvent(accessToken, booking.eventId);
      }
    } catch (e) {
      await handleCalendarError(deps, influencerId, booking.id, e, "cancel");
    }
  }

  // 3) Re-notify the customer that their booking was cancelled (no email: see renotify).
  await renotify(deps, booking.id, "booking-cancelled", false);
}

/**
 * Reschedules a booking to `newStart` by moving its Session and patching the Calendar event start/end
 * (sendUpdates=all notifies every attendee), then re-notifies. For a GROUP session this moves the shared
 * session (all attendees) to the new time, keeping the one-event-per-session invariant intact. The booking's
 * endTime is derived from the service duration.
 */
export async function rescheduleBooking(
  bookingId: string,
  newStart: Date,
  overrides: Partial<ManageDeps> = {},
): Promise<void> {
  const deps = { ...defaultDeps, ...overrides };
  const booking = await loadBooking(bookingId);
  if (!booking) throw new BookingNotManageableError("Booking not found");
  if (!MANAGEABLE.includes(booking.status as (typeof MANAGEABLE)[number])) {
    throw new BookingNotManageableError(`Booking cannot be rescheduled while it is ${booking.status}`);
  }

  const { session } = booking;
  const { service } = session;
  const influencerId = service.influencer.id;
  const newEnd = new Date(newStart.getTime() + service.durationMin * 60_000);

  // 1) Validate the new time the same way the hold route does: it must be a real slot start out of the
  //    influencer's availability rules and not land on a blocked day. The API routes accept any ISO datetime,
  //    so without this a crafted dashboard/self-service request could move a booking (and, for GROUP, the whole
  //    shared session) to an off-schedule or blocked time. Load the influencer's blocked days around the target.
  const blocked = await prisma.blockedDate.findMany({
    where: {
      influencerId,
      date: {
        gte: new Date(newStart.getTime() - 86_400_000),
        lte: new Date(newStart.getTime() + 86_400_000),
      },
    },
    select: { date: true },
  });
  const reason = validateRescheduleTime({
    rules: service.influencer.rules,
    durationMin: service.durationMin,
    newStart,
    blockedDates: blockedDaySet(blocked.map((b) => b.date)),
  });
  if (reason) throw new RescheduleNotAllowedError(reason);

  // 2) DB: move the session to the new time, serialized on the destination so capacity cannot be raced. The
  //    (service_id, start_time) unique constraint means a second session already at newStart would collide, so
  //    we reject that up front; then we lock THIS session row (FOR UPDATE, mirroring lib/holds.ts) and confirm
  //    its live seats still fit the service capacity at the destination before moving it. This keeps the
  //    one-event-per-session invariant (the whole GROUP session moves together) and prevents an oversell slipping
  //    in if capacity was shrunk after the seats were sold.
  await prisma.$transaction(async (tx) => {
    const clash = await tx.session.findFirst({
      where: { serviceId: service.id, startTime: newStart, id: { not: session.id } },
      select: { id: true },
    });
    if (clash) throw new RescheduleNotAllowedError("Another session already occupies that time");

    await tx.$queryRaw`SELECT id FROM sessions WHERE id = ${session.id} FOR UPDATE`;
    const taken = await tx.booking.count({ where: { sessionId: session.id, ...activeSeatWhere(new Date()) } });
    if (taken > service.capacity) {
      throw new RescheduleNotAllowedError("This session has more bookings than the service now allows");
    }

    await tx.session.update({ where: { id: session.id }, data: { startTime: newStart, endTime: newEnd } });
  });

  // 3) Calendar (best-effort): patch the event start/end.
  const eventId =
    service.type === "GROUP" ? session.eventId ?? sessionEventId(session.id) : booking.eventId ?? calendarEventId(booking.id);
  if (booking.eventId || session.eventId) {
    try {
      const accessToken = await accessTokenFor(deps, booking);
      await deps.google.updateEvent(accessToken, eventId, { start: newStart, end: newEnd });
    } catch (e) {
      await handleCalendarError(deps, influencerId, booking.id, e, "reschedule");
    }
  }

  // 4) Re-notify every live booking in the (possibly shared) session of the new time. For a GROUP this is one
  //    confirmation email per attendee: intended, because the shared event moved for all of them and each
  //    customer needs their own notice carrying their own self-service link (issue 5 - this is by design).
  for (const b of session.bookings) {
    if (b.status === "CANCELLED" || b.status === "FAILED" || b.status === "EXPIRED") continue;
    await renotify(deps, b.id, "booking-rescheduled", true);
  }
}

/** Records a calendar failure on the booking and alerts the influencer. Does not rethrow transient failures. */
async function handleCalendarError(
  deps: ManageDeps,
  influencerId: string,
  bookingId: string,
  e: unknown,
  action: "cancel" | "reschedule",
): Promise<void> {
  const detail = `Could not ${action} the calendar event: ${e instanceof Error ? e.message : String(e)}`;
  await prisma.booking.update({ where: { id: bookingId }, data: { lastError: detail.slice(0, 500) } }).catch(() => {});
  await deps.alert(influencerId, { kind: "meeting-creation-failed", detail, bookingId });
  if (e instanceof GoogleReconnectError || e instanceof ManageBlockedError) throw new ManageBlockedError(detail);
  if (e instanceof GoogleRequestError) throw new ManageRejectedError(detail);
  // Transient: the DB change already landed; the influencer was alerted and can retry from the dashboard.
}
