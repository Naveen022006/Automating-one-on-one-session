import { createHash } from "node:crypto";
import { alertInfluencer } from "@/lib/alerts";
import { prisma } from "@/lib/db";
import {
  GoogleEventGoneError,
  GoogleReconnectError,
  GoogleRequestError,
  GoogleTransientError,
  google as defaultGoogle,
  type CalendarEvent,
  type EventAttendee,
  type GoogleClient,
} from "@/lib/google";
import { sendBookingEmail } from "@/lib/email";
import { getRefreshToken, markReconnectNeeded } from "@/lib/google-tokens";
import { createMessage } from "@/lib/messages";
import { enqueueReminders, enqueueSendMessage, requeueCreateMeeting } from "@/lib/queue";

const CONFIRMATION_TEMPLATE = "booking-confirmation";

/**
 * Records that the booking confirmation was handed to the messaging queue, sends the customer their
 * confirmation/receipt email (which carries the signed self-service link), then enqueues the WhatsApp
 * message. Best-effort and non-throwing (createMessage and sendBookingEmail both swallow their own errors):
 * recording/emailing must never fail the create-meeting job. The WhatsApp row is 'queued' because the real
 * delivery worker is Phase 4; the dashboard shows it as the latest status.
 */
async function enqueueConfirmation(deps: MeetingDeps, bookingId: string): Promise<void> {
  await createMessage({ bookingId, channel: "whatsapp", template: CONFIRMATION_TEMPLATE, status: "queued" });
  // The confirmation email is the only organic delivery of the self-service link, so it must go out on the
  // normal paid -> scheduled path, not only from the resend/reschedule actions. sendBookingEmail is itself
  // best-effort (records an 'email' Message row and never throws), so a broken email channel cannot fail the job.
  await deps.sendBookingEmail(bookingId, CONFIRMATION_TEMPLATE);
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
  enqueueReminders: (bookingId: string, startTime: Date) => Promise<void>;
  sendBookingEmail: typeof sendBookingEmail;
  alert: typeof alertInfluencer;
  sleep: (ms: number) => Promise<void>;
}

const defaultDeps: MeetingDeps = {
  google: defaultGoogle,
  enqueueSendMessage: (id) => enqueueSendMessage(id),
  enqueueReminders: (id, startTime) => enqueueReminders(id, startTime),
  sendBookingEmail,
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
 *
 * `generation` 0 is the original id. Google never lets an event id be used twice, so once a session's shared event
 * has been deleted the next one gets generation 1, then 2... (see {@link ensureGroupEvent}).
 */
export function sessionEventId(sessionId: string, generation = 0): string {
  return createHash("sha256").update(generation === 0 ? `session:${sessionId}` : `session:${sessionId}:${generation}`).digest("hex");
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

/** The walk down the id sequence never needs more than a step or two; this only stops a runaway loop. */
const MAX_EVENT_STEPS = 1000;

/** The id sequence of a group session ran out (see {@link ensureGroupEvent}); someone has to look at the calendar. */
class GroupEventExhaustedError extends Error {}

/**
 * Makes sure a LIVE shared Calendar event exists for a group session and returns it with its id and generation.
 * `created` is false when the event was already there (someone else made it first), so the caller must still add its
 * own attendee.
 *
 * Why not simply insert `sessionEventId(sessionId)`: when the last booking is cancelled, lib/manage.ts deletes the shared
 * event, and Google never lets a deleted event's id be reused. The next payer's insert answers 409 and the read gives a
 * "cancelled" tombstone (or 404/410 once it is purged), so their paid booking would fail for good. Two fixes were weighed:
 *  - restore the event (events.patch status "confirmed"): only works while Google still keeps the deleted event, and the
 *    Meet conference of a deleted event is not guaranteed to come back, so we could end up with a link that does not work;
 *  - create a new event under the next id of the deterministic sequence (generation 1, 2...): always works and gets a
 *    fresh Meet link. Chosen.
 * The walk starts at `fromGeneration`, the session's stored generation (sessions.event_generation: the live event's, or
 * the next one to try after a cancel deleted the last), so it is short however often the event was deleted. It skips
 * ids whose event is dead and stops at the first live one, so every caller (the elected creator, a payer racing it, a job
 * retried after a crash) converges on the same event and a repeat run creates nothing new. The caller records the
 * returned id and generation on the session and the id on the booking.
 */
async function ensureGroupEvent(
  deps: MeetingDeps,
  accessToken: string,
  sessionId: string,
  fromGeneration: number,
  event: { summary: string; description: string; start: Date; end: Date; attendee: EventAttendee },
): Promise<{ eventId: string; generation: number; event: CalendarEvent; created: boolean }> {
  for (let generation = fromGeneration; generation < fromGeneration + MAX_EVENT_STEPS; generation++) {
    const id = sessionEventId(sessionId, generation);
    // A new event also needs a new Meet request id: Google ignores a request id it has already seen.
    const conferenceRequestId = generation === 0 ? sessionId : `${sessionId}:${generation}`;
    const inserted = await deps.google.insertEvent(accessToken, { ...event, id, conferenceRequestId });
    if (inserted !== "exists") return { eventId: id, generation, event: inserted, created: true };
    const existing = await deps.google.getEvent(accessToken, id);
    if (existing && existing.status !== "cancelled") return { eventId: id, generation, event: existing, created: false };
    // Deleted (tombstone or purged): this id can never be used again, try the next one.
  }
  throw new GroupEventExhaustedError(
    `Could not create a calendar event for this group session: ${MAX_EVENT_STEPS} event ids in a row were already used. Check the session's events in Google Calendar.`,
  );
}

/**
 * Group sessions only. A booking that is still live but points at a different event than the session's current one is
 * on a dead link: its event was deleted (by the influencer, or by a cancel that did not know about it) and the session
 * has a new one. Moves each such booking to the current event: invites them there, saves the new event id and link on
 * the booking (every reader prefers the booking's link over the session's), emails them the confirmation again, and
 * tells the influencer once. Idempotent: a moved booking no longer matches, so a retried job finishes what a crashed one
 * started.
 */
async function moveStrandedBookings(
  deps: MeetingDeps,
  accessToken: string,
  args: { sessionId: string; triggerBookingId: string; influencerId: string; eventId: string; meetLink: string },
): Promise<void> {
  const { sessionId, triggerBookingId, influencerId, eventId, meetLink } = args;
  const live: ("PAID" | "SCHEDULED")[] = ["PAID", "SCHEDULED"];
  const stranded = await prisma.booking.findMany({
    where: {
      sessionId,
      id: { not: triggerBookingId },
      status: { in: live },
      AND: [{ eventId: { not: null } }, { eventId: { not: eventId } }],
    },
    select: { id: true, customerName: true, customerEmail: true },
  });
  if (stranded.length === 0) return;
  let moved = 0;
  let notInvited = 0;
  for (const b of stranded) {
    try {
      await deps.google.addAttendee(accessToken, eventId, { email: b.customerEmail, displayName: b.customerName });
    } catch (e) {
      // They still get the new link by email below; the influencer is told that the calendar invite is missing.
      notInvited++;
      console.warn(`[create-meeting] could not invite booking ${b.id} to the replacement group event: ${e instanceof Error ? e.message : e}`);
    }
    const { count } = await prisma.booking.updateMany({ where: { id: b.id, status: { in: live } }, data: { eventId, meetLink } });
    if (count === 0) continue; // cancelled meanwhile
    moved++;
    await deps.sendBookingEmail(b.id, CONFIRMATION_TEMPLATE, { force: true });
  }
  if (moved > 0) {
    await deps.alert(influencerId, {
      kind: "meeting-creation-failed",
      title: "A group session got a new Meet link",
      detail: `The shared calendar event of this group session had been deleted, so a new one was created. ${moved} booked attendee(s) were moved to it and emailed the new link${notInvited > 0 ? `; ${notInvited} of them could not be added to the calendar event and have the link by email only` : ""}. WhatsApp and SMS confirmations were not re-sent: use "Resend link" on a booking to send the new link there too.`,
      bookingId: triggerBookingId,
    });
  }
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
    if (booking.status === "SCHEDULED") {
      await enqueueConfirmation(deps, booking.id);
      // Re-establish the reminders too (recovery after a lost enqueue). enqueueReminders is idempotent via the
      // deterministic job ids and skips any fire time already in the past, so this is safe to repeat.
      await deps.enqueueReminders(booking.id, booking.session.startTime);
    }
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
  // `let`: a group session whose shared event was deleted moves on to the next id (see ensureGroupEvent).
  let eventId = isGroup ? sessionEventId(session.id, session.eventGeneration ?? 0) : calendarEventId(booking.id);

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
      // The session as it is now: a cancel may have deleted the shared event (and moved its generation on) after this
      // job loaded the booking.
      const fresh = await prisma.session.findUnique({
        where: { id: session.id },
        select: { eventId: true, eventGeneration: true, meetLink: true },
      });

      // Another attendee already claimed the event. If its link is saved we reuse it and just add THIS customer to
      // the shared event. If that event has since been deleted (the last booking was cancelled, or the influencer
      // removed it) the add fails with "gone" and we fall through to make sure a live one exists.
      let sharedLink: string | null = null;
      if (!weAreCreator && fresh?.meetLink) {
        // The session's recorded id is the truth: it may be a later generation than the one derived above.
        const sharedId = fresh.eventId ?? eventId;
        try {
          await deps.google.addAttendee(accessToken, sharedId, attendee);
          eventId = sharedId;
          sharedLink = fresh.meetLink;
        } catch (e) {
          if (!(e instanceof GoogleEventGoneError)) throw e;
        }
      }
      if (sharedLink === null) {
        // We are the creator, or the creator has not finished (or crashed), or the shared event is gone: ensure a live
        // event exists (idempotent, see ensureGroupEvent) and its link is ready, then persist both so the stuck
        // creator and other attendees converge on the same event.
        const ensured = await ensureGroupEvent(deps, accessToken, session.id, fresh?.eventGeneration ?? session.eventGeneration ?? 0, {
          summary: `${service.title} with ${influencer.name}`,
          description: `${service.title} with ${influencer.name} (group session).\nBooking reference: ${booking.id}`,
          start,
          end,
          attendee,
        });
        eventId = ensured.eventId;
        // Lost the create race (or retrying after a crash): the event was made without this customer on it, so they
        // would get no invite. addAttendee is a no-op when they are already listed.
        if (!ensured.created) await deps.google.addAttendee(accessToken, eventId, attendee);
        sharedLink = await waitForMeetLink(deps, accessToken, ensured.event, eventId);
        // Store the shared event id, its generation and link on the session so later attendees reuse them without
        // another round-trip, and the next walk starts from here.
        await prisma.session.update({
          where: { id: session.id },
          data: { eventId, eventGeneration: ensured.generation, meetLink: sharedLink },
        });
      }
      meetLink = sharedLink;
      // Anyone already booked onto an earlier, now dead event of this session (only after it was deleted behind our
      // back; a cancel never deletes it while another booking is live) is moved onto this one.
      await moveStrandedBookings(deps, accessToken, {
        sessionId: session.id,
        triggerBookingId: booking.id,
        influencerId: influencer.id,
        eventId,
        meetLink,
      });
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
    if (e instanceof GroupEventExhaustedError) {
      // Not Google's rejection of this booking and not fixable by retrying: the booking stays PAID (the customer paid),
      // the reason is recorded and the influencer is told, instead of the booking failing without anyone knowing why.
      await fail(e.message);
      await deps.alert(influencer.id, { kind: "meeting-creation-failed", detail: e.message, bookingId: booking.id });
      throw new MeetingBlockedError(e.message);
    }
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

  // Only now that the booking is actually SCHEDULED do we send the confirmation (email + WhatsApp) and
  // schedule the reminders. Reminders are never enqueued at PAID/enqueue time; the delayed jobs re-read the
  // booking status when they fire, so a cancel/reschedule before the fire time is honoured at run time.
  await enqueueConfirmation(deps, booking.id);
  await deps.enqueueReminders(booking.id, session.startTime);
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
