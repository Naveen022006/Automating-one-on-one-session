import { createHash } from "node:crypto";
import { alertInfluencer } from "@/lib/alerts";
import { prisma } from "@/lib/db";
import {
  GoogleReconnectError,
  GoogleRequestError,
  GoogleTransientError,
  google as defaultGoogle,
  type CalendarEvent,
  type GoogleClient,
} from "@/lib/google";
import { getRefreshToken, markReconnectNeeded } from "@/lib/google-tokens";
import { createMessage } from "@/lib/messages";
import { enqueueSendMessage, requeueCreateMeeting } from "@/lib/queue";

const CONFIRMATION_TEMPLATE = "booking-confirmation";

/**
 * Records that the booking confirmation was handed to the messaging queue, then enqueues it. Best-effort and
 * non-throwing (via createMessage): recording must never fail the create-meeting job. The row is 'queued'
 * because the real WhatsApp/email delivery worker is Phase 4; the dashboard shows it as the latest status.
 */
async function enqueueConfirmation(deps: MeetingDeps, bookingId: string): Promise<void> {
  await createMessage({ bookingId, channel: "whatsapp", template: CONFIRMATION_TEMPLATE, status: "queued" });
  await deps.enqueueSendMessage(bookingId);
}

/**
 * The influencer must act (connect / reconnect Google) before this booking can get a link.
 * Retrying is pointless, so the worker does not retry. The booking stays PAID and is re-queued after they reconnect.
 */
export class MeetingBlockedError extends Error {}
/** Google rejected this booking's event for good (bad attendee, deleted event...). Booking is marked FAILED for manual attention. */
export class MeetingRejectedError extends Error {}

export type MeetingOutcome = "scheduled" | "already-scheduled" | "skipped";

export interface MeetingDeps {
  google: GoogleClient;
  enqueueSendMessage: (bookingId: string) => Promise<void>;
  alert: typeof alertInfluencer;
  sleep: (ms: number) => Promise<void>;
}

const defaultDeps: MeetingDeps = {
  google: defaultGoogle,
  enqueueSendMessage: (id) => enqueueSendMessage(id),
  alert: alertInfluencer,
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
};

/**
 * Calendar event ids must be 5-1024 chars of a-v and 0-9 (base32hex); a hex digest qualifies. Deriving the id
 * from the booking makes `events.insert` idempotent: a second insert answers 409 and we read the existing event.
 */
export function calendarEventId(bookingId: string): string {
  return createHash("sha256").update(`booking:${bookingId}`).digest("hex");
}

/**
 * Event id for a GROUP session. Every booking in the session derives the SAME id, so they all converge on
 * one shared Calendar event: the first paid attendee creates it, the rest are added to it. Keyed on the
 * session (not the booking) and using the same sha256 hex scheme as {@link calendarEventId}.
 */
export function sessionEventId(sessionId: string): string {
  return createHash("sha256").update(`session:${sessionId}`).digest("hex");
}

const LINK_POLLS = 3;
const LINK_POLL_DELAY_MS = 1_500;

/** Meet creation is asynchronous at Google: right after insert the link can still be "pending". */
async function waitForMeetLink(
  deps: MeetingDeps,
  accessToken: string,
  event: CalendarEvent,
  eventId: string,
): Promise<string> {
  let current: CalendarEvent | null = event;
  for (let i = 0; ; i++) {
    if (current?.status === "cancelled") {
      throw new GoogleRequestError("The calendar event for this booking was deleted from the calendar");
    }
    if (current?.meetLink) return current.meetLink;
    if (i >= LINK_POLLS) break;
    await deps.sleep(LINK_POLL_DELAY_MS);
    current = await deps.google.getEvent(accessToken, eventId);
  }
  // The event exists now, so the retry takes the "already exists" path and just re-reads it.
  throw new GoogleTransientError(`Meet link not ready yet (conference status: ${current?.conferenceStatus ?? "unknown"})`);
}

/**
 * Creates the Google Calendar event with a Meet link for a paid booking, saves event id + link, marks the
 * booking SCHEDULED and queues the confirmation message.
 *
 * Idempotent: safe to run any number of times, concurrently or after a crash at any point.
 *  - booking already has an event id -> nothing is created (the message enqueue is repeated, but it has a
 *    deterministic job id, so it covers a crash between saving the event and enqueueing without double-sending)
 *  - crash after the event was created but before it was saved -> the deterministic event id makes the
 *    retry find the same event instead of creating a second one
 */
export async function createMeetingForBooking(
  bookingId: string,
  overrides: Partial<MeetingDeps> = {},
): Promise<MeetingOutcome> {
  const deps = { ...defaultDeps, ...overrides };

  const booking = await prisma.booking.findUnique({
    where: { id: bookingId },
    include: { session: { include: { service: { include: { influencer: true } } } } },
  });
  if (!booking) {
    console.warn(`[create-meeting] booking ${bookingId} not found, skipping`);
    return "skipped";
  }

  if (booking.eventId) {
    if (booking.status === "SCHEDULED") await enqueueConfirmation(deps, booking.id);
    return "already-scheduled";
  }
  // Read at run time, never trusted from enqueue time: the booking may have been cancelled or refunded since.
  if (booking.status !== "PAID") {
    console.warn(`[create-meeting] booking ${bookingId} is ${booking.status}, not PAID; skipping`);
    return "skipped";
  }

  const { session } = booking;
  const { service } = session;
  const { influencer } = service;
  const isGroup = service.type === "GROUP";
  // GROUP: one shared event per session (id derived from the session). 1:1: one event per booking (unchanged).
  const eventId = isGroup ? sessionEventId(session.id) : calendarEventId(booking.id);

  if (isGroup && service.durationMin > 60) {
    console.warn(
      `[create-meeting] service ${service.id} is a ${service.durationMin} min group call; free Gmail accounts cap group Meet calls at 60 minutes`,
    );
  }

  const fail = (message: string) => prisma.booking.update({ where: { id: booking.id }, data: { lastError: message.slice(0, 500) } });

  /**
   * Parks the booking (it stays PAID) until the influencer reconnects.
   *  - "revoked":         Google just rejected the grant. Flag it and alert, but only for the job that flips the
   *                       flag, so ten waiting bookings produce one alert rather than ten.
   *  - "not-connected":   no grant exists, so there is nothing to flag. Alert for each booking that is stuck.
   *  - "already-flagged": flagged and alerted earlier. Park quietly.
   */
  const blocked = async (reason: string, mode: "revoked" | "not-connected" | "already-flagged"): Promise<never> => {
    const notify = mode === "revoked" ? await markReconnectNeeded(influencer.id, reason) : mode === "not-connected";
    await fail(`Waiting for ${influencer.name} to connect Google Calendar: ${reason}`);
    if (notify) await deps.alert(influencer.id, { kind: "google-reconnect-needed", detail: reason, bookingId: booking.id });
    throw new MeetingBlockedError(reason);
  };

  const token = await getRefreshToken(influencer.id);
  if (token.state === "not-connected") return blocked("Google Calendar has not been connected", "not-connected");
  if (token.state === "reconnect-needed") {
    return blocked(token.reason ?? "Google connection needs to be renewed", "already-flagged");
  }

  let meetLink: string;
  try {
    const accessToken = await deps.google.refreshAccessToken(token.refreshToken);
    const start = session.startTime;
    const end = session.endTime;
    const attendee = { email: booking.customerEmail, displayName: booking.customerName };

    if (isGroup) {
      // Elect exactly one creator per session. The first attendee to flip session.event_id from null (atomic
      // updateMany with a where-guard, mirroring the races guarded in lib/holds.ts and lib/payment-webhook.ts)
      // wins the insert; everyone else takes the add-attendee path. Two concurrent payers therefore cannot both
      // create the event. The event id is deterministic and keyed on the session, so even if the elected creator
      // crashes before the link is saved, the retry's insertEvent/addAttendee converge on the same event.
      const claim = await prisma.session.updateMany({
        where: { id: session.id, eventId: null },
        data: { eventId },
      });
      const weAreCreator = claim.count > 0;

      if (weAreCreator) {
        const created = await deps.google.insertEvent(accessToken, {
          id: eventId,
          summary: `${service.title} with ${influencer.name}`,
          description: `${service.title} with ${influencer.name} (group session).\nBooking reference: ${booking.id}`,
          start,
          end,
          attendee,
          conferenceRequestId: session.id,
        });
        const event = created === "exists" ? await deps.google.getEvent(accessToken, eventId) : created;
        if (!event) throw new GoogleTransientError("Calendar reported the event exists but it could not be read");
        meetLink = await waitForMeetLink(deps, accessToken, event, eventId);
        // Store the shared link on the session so later attendees copy it without another Google round-trip.
        await prisma.session.update({ where: { id: session.id }, data: { meetLink } });
      } else {
        // Another attendee already claimed the event. If its link is saved we reuse it; otherwise the creator is
        // still mid-flight (or crashed), so insertEvent on the deterministic id gives us the event (409 -> read)
        // and we poll for the link. Either way we add THIS customer to the shared event.
        const fresh = await prisma.session.findUnique({ where: { id: session.id }, select: { meetLink: true } });
        if (fresh?.meetLink) {
          meetLink = fresh.meetLink;
          await deps.google.addAttendee(accessToken, eventId, attendee);
        } else {
          // Creator has not finished. Ensure the event exists (insert is idempotent via the deterministic id)
          // and the link is ready, then persist it so the stuck creator and other attendees converge.
          const created = await deps.google.insertEvent(accessToken, {
            id: eventId,
            summary: `${service.title} with ${influencer.name}`,
            description: `${service.title} with ${influencer.name} (group session).\nBooking reference: ${booking.id}`,
            start,
            end,
            attendee,
            conferenceRequestId: session.id,
          });
          const event = created === "exists" ? await deps.google.getEvent(accessToken, eventId) : created;
          if (!event) throw new GoogleTransientError("Calendar reported the event exists but it could not be read");
          meetLink = await waitForMeetLink(deps, accessToken, event, eventId);
          await prisma.session.update({ where: { id: session.id }, data: { meetLink } });
        }
      }
    } else {
      const created = await deps.google.insertEvent(accessToken, {
        id: eventId,
        summary: `${service.title} with ${influencer.name}`,
        description: `${service.title} with ${influencer.name}.\nBooking reference: ${booking.id}`,
        start,
        end,
        attendee,
        conferenceRequestId: booking.id,
      });
      const event = created === "exists" ? await deps.google.getEvent(accessToken, eventId) : created;
      if (!event) throw new GoogleTransientError("Calendar reported the event exists but it could not be read");
      meetLink = await waitForMeetLink(deps, accessToken, event, eventId);
    }
  } catch (e) {
    if (e instanceof GoogleReconnectError) return blocked(e.message, "revoked");
    if (e instanceof GoogleRequestError) {
      await prisma.booking.update({
        where: { id: booking.id },
        data: { status: "FAILED", lastError: e.message.slice(0, 500) },
      });
      await deps.alert(influencer.id, { kind: "meeting-creation-failed", detail: e.message, bookingId: booking.id });
      throw new MeetingRejectedError(e.message);
    }
    await fail(e instanceof Error ? e.message : String(e)); // transient: BullMQ retries; alerting after the last attempt is the worker's job
    throw e;
  }

  const { count } = await prisma.booking.updateMany({
    where: { id: booking.id, status: "PAID", eventId: null },
    data: { eventId, meetLink, status: "SCHEDULED", lastError: null },
  });
  if (count === 0) {
    // Cancelled / refunded while we were talking to Google. The event exists on the calendar under `eventId`.
    console.warn(`[create-meeting] booking ${booking.id} changed while its event was being created; event ${eventId} was not linked`);
    return "skipped";
  }

  await enqueueConfirmation(deps, booking.id);
  return "scheduled";
}

/**
 * Called by the worker after the final retry failed. The booking stays PAID (the customer paid, and the cause
 * is usually fixable), the reason is recorded for the dashboard, and the influencer is told.
 */
export async function reportMeetingFailure(
  bookingId: string,
  message: string,
  alert: typeof alertInfluencer = alertInfluencer,
): Promise<void> {
  const booking = await prisma.booking.findUnique({
    where: { id: bookingId },
    select: { id: true, eventId: true, session: { select: { service: { select: { influencerId: true } } } } },
  });
  if (!booking || booking.eventId) return;
  const detail = `Gave up creating the Meet link after repeated failures: ${message}`.slice(0, 500);
  await prisma.booking.update({ where: { id: bookingId }, data: { lastError: detail } });
  await alert(booking.session.service.influencerId, { kind: "meeting-creation-failed", detail, bookingId });
}

/**
 * Re-queues create-meeting for paid, future bookings that still have no event. Called after an influencer
 * reconnects Google, and on worker start-up to recover from a lost enqueue or an exhausted retry.
 * Influencers whose connection is still broken are skipped; their bookings wait for the reconnect.
 */
export async function requeuePendingMeetings(
  influencerId?: string,
  requeue: (bookingId: string) => Promise<void> = requeueCreateMeeting,
): Promise<number> {
  const bookings = await prisma.booking.findMany({
    where: {
      status: "PAID",
      eventId: null,
      session: {
        endTime: { gt: new Date() },
        service: {
          influencer: { ...(influencerId ? { id: influencerId } : {}), googleToken: { is: { status: "ACTIVE" } } },
        },
      },
    },
    select: { id: true },
  });
  for (const b of bookings) await requeue(b.id);
  return bookings.length;
}
