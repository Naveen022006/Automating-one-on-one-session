import { alertInfluencer } from "@/lib/alerts";
import { prisma } from "@/lib/db";
import { sendBookingEmail } from "@/lib/email";
import {
  GoogleReconnectError,
  GoogleRequestError,
  google as defaultGoogle,
  type GoogleClient,
} from "@/lib/google";
import { getRefreshToken, markReconnectNeeded } from "@/lib/google-tokens";
import { activeSeatWhere } from "@/lib/holds";
import { calendarEventId, sessionEventId } from "@/lib/meeting";
import { CANCELLATION_TEMPLATE, CONFIRMATION_TEMPLATE, RESCHEDULE_TEMPLATE } from "@/lib/message-templates";
import { rearmMessage } from "@/lib/messaging";
import { createMessage } from "@/lib/messages";
import { cancelReminders, enqueueReminders, enqueueSendMessage } from "@/lib/queue";
import { describeRefundPolicy, refundDecision, type CancelActor, type RefundPolicy } from "@/lib/refund-policy";
import { RefundPendingError, refundPayment } from "@/lib/refunds";
import { NOTICE_MS } from "@/lib/refund-policy";
import { windowProblem } from "@/lib/booking-window";
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
 * influencer's availability rules that does not fall on a blocked day. Returns null when ok, or a reason string.
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
  enqueueSendMessage: (bookingId: string, template?: string, dedupeSuffix?: string) => Promise<void>;
  sendBookingEmail: typeof sendBookingEmail;
  alert: typeof alertInfluencer;
  cancelReminders: (bookingId: string) => Promise<void>;
  enqueueReminders: (bookingId: string, startTime: Date) => Promise<void>;
  rearmMessage: (bookingId: string, template: string) => Promise<void>;
  refundPayment: (paymentId: string, opts: { reason?: string }) => Promise<unknown>;
}

const defaultDeps: ManageDeps = {
  google: defaultGoogle,
  enqueueSendMessage: (id, template, suffix) => enqueueSendMessage(id, template, suffix),
  sendBookingEmail,
  alert: alertInfluencer,
  cancelReminders: (id) => cancelReminders(id),
  enqueueReminders: (id, start) => enqueueReminders(id, start),
  rearmMessage,
  refundPayment: (id, opts) => refundPayment(id, opts),
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

/** Each step is best-effort: a queue/email hiccup must not undo or fail a change that already landed. */
async function step(label: string, fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
  } catch (e) {
    console.error(`[manage] ${label} failed`, e instanceof Error ? e.message : e);
  }
}

/**
 * Re-sends the booking confirmation (email + WhatsApp/SMS) without touching the Calendar event. Used by the
 * influencer "Resend link" action and the customer's "message not received?" button. The confirmation is
 * re-armed so the messaging idempotency check does not swallow the deliberate repeat.
 */
export async function resendBookingLink(bookingId: string, overrides: Partial<ManageDeps> = {}): Promise<void> {
  const deps = { ...defaultDeps, ...overrides };
  const booking = await prisma.booking.findUnique({ where: { id: bookingId }, select: { id: true, status: true } });
  if (!booking) throw new BookingNotManageableError("Booking not found");
  if (!["PAID", "SCHEDULED", "COMPLETED"].includes(booking.status)) {
    throw new BookingNotManageableError(`There is no link to resend while the booking is ${booking.status}`);
  }
  await deps.sendBookingEmail(bookingId, "booking-confirmation", { force: true });
  await step("re-arm confirmation", () => deps.rearmMessage(bookingId, CONFIRMATION_TEMPLATE));
  await createMessage({ bookingId, channel: "whatsapp", template: CONFIRMATION_TEMPLATE, status: "queued" });
  await step("enqueue confirmation", () => deps.enqueueSendMessage(bookingId, CONFIRMATION_TEMPLATE, `resend-${Date.now()}`));
}

/**
 * Resolves an access token for the booking's influencer. Throws ManageBlockedError if Google is not connected or is
 * already flagged for reconnect. A grant Google rejects right now surfaces as GoogleReconnectError (not wrapped), so
 * recordCalendarProblem can flag the connection. `grant.connectedAt` is set to the version of the grant that was read,
 * before it is used, so that flag only lands if that is still the connected grant (a reconnect during a slow Calendar
 * call must not be marked dead by an error of the old one).
 */
async function accessTokenFor(deps: ManageDeps, booking: BookingWithContext, grant: { connectedAt?: Date }): Promise<string> {
  const influencerId = booking.session.service.influencer.id;
  const token = await getRefreshToken(influencerId);
  if (token.state !== "ok") {
    throw new ManageBlockedError("The influencer's Google Calendar is not connected; the change was saved but the calendar was not updated");
  }
  grant.connectedAt = token.connectedAt;
  return deps.google.refreshAccessToken(token.refreshToken);
}

export interface CancelOptions {
  /** Who is cancelling. Customers get the service's refund policy; an influencer cancel always refunds. */
  actor?: CancelActor;
  reason?: string;
  /**
   * The platform (an administrator) cancels on the host's behalf: the refund decision is the influencer's (full refund), but the platform
   * issues it, so the host gets no "issue the refund" alert and the customer is told the platform will refund, not the host.
   */
  byPlatform?: boolean;
}

export interface CancelResult {
  /** issued: "yes" (refunded now), "pending" (sent to Razorpay, not yet confirmed), "no" (flagged or not due). */
  refund: { eligible: boolean; reason: string; issued: "yes" | "pending" | "no" };
  /**
   * Set when the booking was cancelled but its Calendar event could not be updated (Google not connected, revoked,
   * unreachable or rejecting the change). The reminders, refund and customer notice all went ahead anyway.
   */
  warning?: string;
}

/**
 * Cancels a booking: marks it CANCELLED, updates the shared/1:1 Calendar event, drops its reminders, decides the
 * refund from the service policy, and tells the customer (WhatsApp/SMS + email). The DB change always happens; a
 * calendar failure is best-effort: it is remembered, the rest of the cancel carries on (the booking is already
 * CANCELLED, so nothing could retry the reminders, refund or customer notice later), and it is recorded, alerted
 * and returned as `warning` at the end, the way rescheduleBooking handles it.
 *
 *  - 1:1    -> delete the booking's own event.
 *  - GROUP  -> remove ONLY this attendee from the shared session event; delete the event (and clear the
 *              session's shared fields) only when no other PAID/SCHEDULED booking of the session remains in the
 *              database (see releaseSharedEvent).
 *  - Refund -> eligible payments are flagged `needsRefund` (and the influencer alerted), or refunded straight
 *              away through Razorpay when AUTO_REFUND_ON_CANCEL=true.
 */
export async function cancelBooking(
  bookingId: string,
  opts: CancelOptions = {},
  overrides: Partial<ManageDeps> = {},
): Promise<CancelResult> {
  const deps = { ...defaultDeps, ...overrides };
  const actor = opts.actor ?? "influencer";
  const booking = await loadBooking(bookingId);
  if (!booking) throw new BookingNotManageableError("Booking not found");
  if (!MANAGEABLE.includes(booking.status as (typeof MANAGEABLE)[number]) && booking.status !== "FAILED") {
    throw new BookingNotManageableError(`Booking cannot be cancelled while it is ${booking.status}`);
  }

  const { session } = booking;
  const { service } = session;
  const influencerId = service.influencer.id;
  const isGroup = service.type === "GROUP";
  // A customer cannot cancel (and claim a refund for) a session that has already started.
  if (actor === "customer" && session.startTime.getTime() <= Date.now()) {
    throw new BookingNotManageableError("This session has already started, so it can no longer be cancelled online. Please contact the host.");
  }
  // The policy the customer booked under; older bookings without a snapshot use the service's current policy.
  const policy = ((booking as { refundPolicy?: RefundPolicy | null }).refundPolicy ??
    (service as { refundPolicy?: RefundPolicy }).refundPolicy ??
    "FULL") as RefundPolicy;
  const decision = refundDecision({ policy, actor, sessionStart: session.startTime });
  const hasCapturedPayment = (booking.payments ?? []).length > 0;

  // 1) DB: cancel the booking and record the refund decision on any captured payment.
  await prisma.booking.update({ where: { id: booking.id }, data: { status: "CANCELLED", lastError: null } });
  if (hasCapturedPayment) {
    await prisma.payment.updateMany({
      where: { bookingId: booking.id, status: "CAPTURED" },
      data: { needsRefund: decision.refund, failureReason: `booking ${decision.reason}${opts.reason ? `: ${opts.reason}` : ""}`.slice(0, 500) },
    });
  }

  // 2) Calendar (best-effort): remove the attendee / delete the event.
  let calendarError: unknown = null;
  const grant: { connectedAt?: Date } = {};
  if (booking.eventId || session.eventId) {
    try {
      const accessToken = await accessTokenFor(deps, booking, grant);
      if (isGroup) {
        const shared = await releaseSharedEvent(session.id, booking.id, booking.customerEmail);
        const eventId = shared.eventId ?? booking.eventId ?? sessionEventId(session.id);
        if (shared.last) await deps.google.deleteEvent(accessToken, eventId);
        // The attendee list is by email: another live booking on this session under the same address needs it to stay.
        else if (!shared.emailInUse) await deps.google.removeAttendee(accessToken, eventId, booking.customerEmail);
      } else if (booking.eventId) {
        await deps.google.deleteEvent(accessToken, booking.eventId);
      }
    } catch (e) {
      calendarError = e;
    }
  }

  // 3) No stale reminder may fire for a cancelled booking (the reminder job also re-checks status at run time).
  await step("cancel reminders", () => deps.cancelReminders(booking.id));

  // 4) Refund: issue it automatically if configured, otherwise flag it for the influencer.
  let issued: CancelResult["refund"]["issued"] = "no";
  if (decision.refund && hasCapturedPayment) {
    if (autoRefundOnCancel()) {
      for (const p of booking.payments) {
        try {
          await deps.refundPayment(p.id, { reason: decision.reason });
          if (issued === "no") issued = "yes";
        } catch (e) {
          if (e instanceof RefundPendingError) {
            issued = "pending";
            continue;
          }
          // A platform cancel leaves the payment flagged for the administrator, who is the one refunding: the host is not asked to act.
          if (!opts.byPlatform) {
            await deps.alert(influencerId, {
              kind: "refund-failed",
              detail: `Automatic refund failed: ${e instanceof Error ? e.message : String(e)}`,
              bookingId: booking.id,
            });
          }
        }
      }
    } else if (!opts.byPlatform) {
      await deps.alert(influencerId, {
        kind: "refund-needed",
        detail: `${booking.customerName}'s booking for ${service.title} was ${decision.reason}. Issue the refund from the Sessions page.`,
        bookingId: booking.id,
      });
    }
  }

  // 5) Tell the customer what actually happened to their money. The cancellation template is the one message
  //    allowed for a CANCELLED booking.
  const refundNote = !hasCapturedPayment
    ? null
    : !decision.refund
      ? `No refund is due under this session's policy: ${describeRefundPolicy(policy)}`
      : issued === "yes"
        ? "Your refund has been issued to your original payment method. It usually arrives within 5-7 working days."
        : issued === "pending"
          ? "Your refund is being processed to your original payment method. It usually arrives within 5-7 working days."
          : opts.byPlatform
            ? "You are due a full refund. We will issue it to your original payment method."
            : "You are due a full refund. The host has been notified and will issue it to your original payment method.";
  await deps.sendBookingEmail(booking.id, "booking-cancelled", { refundNote });
  await createMessage({ bookingId: booking.id, channel: "whatsapp", template: CANCELLATION_TEMPLATE, status: "queued" });
  await step("enqueue cancellation", () => deps.enqueueSendMessage(booking.id, CANCELLATION_TEMPLATE));

  // 6) Only now report the calendar problem (record it on the booking, flag a dead grant, alert the influencer).
  const problem = calendarError ? await recordCalendarProblem(deps, influencerId, booking.id, calendarError, "cancel", grant.connectedAt) : null;

  return {
    refund: { eligible: decision.refund && hasCapturedPayment, reason: decision.reason, issued },
    ...(problem ? { warning: problem.detail } : {}),
  };
}

/**
 * Group cancel, database side: decides whether the cancelled booking was the last one that depends on the session's
 * shared Calendar event. That is decided here, under the session row lock (SELECT ... FOR UPDATE, as lib/holds.ts
 * does), from the bookings in OUR database, not from Google's attendee list: that list can miss paying customers
 * (earlier race losers, two attendee edits at once, two bookings sharing one email), and deleting the event on its
 * say-so would leave them holding a Meet link to a deleted event. When nobody else is PAID or SCHEDULED the event is
 * retired in the same transaction (the session forgets it and its generation moves on, so the next payer starts a fresh
 * event, see lib/meeting.ts ensureGroupEvent) and the caller deletes it at Google. Otherwise the caller only removes
 * this attendee, unless `emailInUse`: Google's attendee list is by email, and another live booking of the session books
 * under the same address (compared case-insensitively), whose invite must stay. `eventId` is the event as the session
 * recorded it, null if it had none.
 */
async function releaseSharedEvent(
  sessionId: string,
  bookingId: string,
  customerEmail: string,
): Promise<{ eventId: string | null; last: boolean; emailInUse: boolean }> {
  return prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<{ event_id: string | null }[]>`SELECT event_id FROM sessions WHERE id = ${sessionId} FOR UPDATE`;
    const eventId = rows[0]?.event_id ?? null;
    const others = await tx.booking.findMany({
      where: { sessionId, id: { not: bookingId }, status: { in: ["PAID", "SCHEDULED"] } },
      select: { customerEmail: true },
    });
    const emailInUse = others.some((o) => o.customerEmail.toLowerCase() === customerEmail.toLowerCase());
    if (others.length > 0) return { eventId, last: false, emailInUse };
    if (!eventId) return { eventId, last: true, emailInUse };
    // The generation moves on atomically and only if the event is still the one just read (it always is under the lock;
    // the guard is what makes this write correct on its own, with nothing but a number to get wrong).
    const retired = await tx.session.updateMany({
      where: { id: sessionId, eventId },
      data: { eventId: null, meetLink: null, eventGeneration: { increment: 1 } },
    });
    return { eventId, last: retired.count > 0, emailInUse };
  });
}

/** AUTO_REFUND_ON_CANCEL=true makes eligible cancellations refund immediately through Razorpay. */
export function autoRefundOnCancel(): boolean {
  return process.env.AUTO_REFUND_ON_CANCEL === "true";
}

/**
 * Reschedules a booking to `newStart` by moving its Session and patching the Calendar event start/end
 * (sendUpdates=all notifies every attendee), replacing the reminders, then re-notifying. For a GROUP session this
 * moves the shared session (all attendees) to the new time, keeping the one-event-per-session invariant intact.
 */
export async function rescheduleBooking(
  bookingId: string,
  newStart: Date,
  overrides: Partial<ManageDeps> = {},
  opts: { actor?: CancelActor } = {},
): Promise<void> {
  const deps = { ...defaultDeps, ...overrides };
  const booking = await loadBooking(bookingId);
  if (!booking) throw new BookingNotManageableError("Booking not found");
  if (!MANAGEABLE.includes(booking.status as (typeof MANAGEABLE)[number])) {
    throw new BookingNotManageableError(`Booking cannot be rescheduled while it is ${booking.status}`);
  }

  const { session } = booking;
  const { service } = session;
  if (opts.actor === "customer") {
    // A suspended host takes no new commitments (the manage page hides the button; this is the rule itself). Cancelling stays allowed.
    if (service.influencer.suspendedAt) {
      throw new BookingNotManageableError("This host's account is not taking changes right now, so this session cannot be moved online. You can still cancel it.");
    }
    if (service.type === "GROUP") {
      throw new BookingNotManageableError("Group sessions can only be moved by the host. Please contact them, or cancel your seat.");
    }
    const msToStart = session.startTime.getTime() - Date.now();
    if (msToStart <= 0) throw new BookingNotManageableError("This session has already started, so it can no longer be moved online.");
    // Under the 24-hour notice policy a late reschedule would let the customer move the session out of the notice
    // window and then cancel for a refund, so customers cannot reschedule inside the window either.
    const policy =
      (booking as { refundPolicy?: RefundPolicy | null }).refundPolicy ?? (service as { refundPolicy?: RefundPolicy }).refundPolicy;
    if (policy === "NOTICE_24H" && msToStart < NOTICE_MS) {
      throw new BookingNotManageableError("Sessions can only be rescheduled online at least 24 hours in advance. Please contact the host.");
    }
    // Customers move within the same booking window as when booking (minimum notice, furthest ahead).
    const outside = windowProblem(newStart, { minNoticeHours: service.minNoticeHours, maxAdvanceDays: service.maxAdvanceDays });
    if (outside) throw new RescheduleNotAllowedError(outside);
  }
  const influencerId = service.influencer.id;
  const newEnd = new Date(newStart.getTime() + service.durationMin * 60_000);
  if (session.startTime.getTime() === newStart.getTime()) return; // already there (idempotent re-run)

  // 1) Validate the new time the same way the hold route does: a real slot start, not on a blocked day.
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

  // 2) DB: move the session to the new time under a FOR UPDATE lock that re-checks capacity (see lib/holds.ts).
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
  let calendarError: unknown = null;
  const grant: { connectedAt?: Date } = {};
  if (booking.eventId || session.eventId) {
    try {
      const accessToken = await accessTokenFor(deps, booking, grant);
      await deps.google.updateEvent(accessToken, eventId, { start: newStart, end: newEnd });
    } catch (e) {
      calendarError = e;
    }
  }

  // 4) Every live booking in the (possibly shared) session: replace its reminders and tell the customer. Done
  //    before surfacing a calendar error so a Google outage never leaves a moved booking without reminders.
  const suffix = `at-${newStart.getTime()}`;
  for (const b of session.bookings) {
    if (b.status === "CANCELLED" || b.status === "FAILED" || b.status === "EXPIRED") continue;
    await step("replace reminders", async () => {
      await deps.cancelReminders(b.id);
      if (b.status !== "SCHEDULED") return;
      // The moment these reminders are (re)armed, kept on the booking row: the repair job (lib/reminders.ts) will not
      // re-create a reminder whose fire time is before it. A Message row cannot carry it; delivery callbacks keep touching those.
      await step("stamp reminder time", () => prisma.booking.update({ where: { id: b.id }, data: { updatedAt: new Date() } }));
      // A reminder already sent for the OLD time would otherwise make the new one "already-sent" (and hide it from the repair job).
      await step("re-arm reminders", async () => {
        for (const template of ["reminder-24h", "reminder-15m"]) await deps.rearmMessage(b.id, template);
      });
      await deps.enqueueReminders(b.id, newStart);
    });
    await deps.sendBookingEmail(b.id, "booking-rescheduled");
    await step("re-arm reschedule notice", () => deps.rearmMessage(b.id, RESCHEDULE_TEMPLATE));
    await createMessage({ bookingId: b.id, channel: "whatsapp", template: RESCHEDULE_TEMPLATE, status: "queued" });
    await step("enqueue reschedule notice", () => deps.enqueueSendMessage(b.id, RESCHEDULE_TEMPLATE, suffix));
  }

  if (calendarError) {
    const problem = await recordCalendarProblem(deps, influencerId, booking.id, calendarError, "reschedule", grant.connectedAt);
    if (problem.kind === "blocked") throw new ManageBlockedError(problem.detail);
    if (problem.kind === "rejected") throw new ManageRejectedError(problem.detail);
    // Transient: the DB change already landed; the influencer was alerted and can retry from the dashboard.
  }
}

interface CalendarProblem {
  /** blocked: Google is not connected or the grant is dead. rejected: Google refused this change. transient: try again. */
  kind: "blocked" | "rejected" | "transient";
  detail: string;
}

/**
 * Records a calendar failure on the booking and alerts the influencer. Never throws: the caller decides whether to
 * surface the problem (reschedule throws it, cancel returns it as a warning).
 *
 * A grant Google rejects right now (revoked, expired, password changed) is dead for every booking, not just this
 * one, so it is flagged exactly like lib/meeting.ts does: the dashboard stops saying "Connected", the booking page
 * goes offline until they reconnect, and the influencer gets one "Reconnect Google" alert (only the call that flips
 * the flag sends it) instead of a generic calendar alert per booking.
 */
async function recordCalendarProblem(
  deps: ManageDeps,
  influencerId: string,
  bookingId: string,
  e: unknown,
  action: "cancel" | "reschedule",
  connectedAt?: Date,
): Promise<CalendarProblem> {
  const message = e instanceof Error ? e.message : String(e);
  const detail = `Could not ${action} the calendar event: ${message}`;
  await prisma.booking.update({ where: { id: bookingId }, data: { lastError: detail.slice(0, 500) } }).catch(() => {});
  // `connectedAt`: the grant that produced the error; if the influencer reconnected meanwhile nothing is flagged.
  const flagged = e instanceof GoogleReconnectError ? await markReconnectNeeded(influencerId, message, connectedAt).catch(() => false) : false;
  if (flagged) {
    await deps.alert(influencerId, {
      kind: "google-reconnect-needed",
      detail: `Google stopped accepting the connection (${message}). Reconnect to keep creating Meet links. ${detail}`,
      bookingId,
    });
  } else {
    await deps.alert(influencerId, { kind: "meeting-creation-failed", detail, bookingId });
  }
  if (e instanceof GoogleReconnectError || e instanceof ManageBlockedError) return { kind: "blocked", detail };
  if (e instanceof GoogleRequestError) return { kind: "rejected", detail };
  return { kind: "transient", detail };
}
