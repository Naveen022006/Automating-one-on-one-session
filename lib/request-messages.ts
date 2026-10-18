import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { expireStaleHolds } from "@/lib/holds";
import { REQUEST_EXPIRED_TEMPLATE, redactPayLinks, type DeliveryRoute, type RequestMessageKind } from "@/lib/message-kinds";
import { customerMessageRoute } from "@/lib/message-route";
import { enqueueSendMessage } from "@/lib/queue";
import { within } from "@/lib/timeout";

/**
 * Queueing the four booking-request messages (doc/16-request-whatsapp-flow.md). The message itself is built and sent by the messaging
 * worker (lib/messaging.ts sendMessageForBooking): this file only puts "send <template> for <booking>" on the queue, so the job holds a
 * booking id and a template key and nothing else (never a payment link).
 *
 * Everything here is BEST EFFORT, like the e-mails it sits beside: a Redis outage must not break a hold, an approval or a decline, so
 * a failed enqueue is one log line and `false`. Callers use it after their database change has committed, never inside a transaction
 * that could still roll back. A repeat is harmless twice over: the job id is deterministic (BullMQ ignores a second add) and the
 * messages table remembers what was sent.
 */

export type RequestEnqueue = (bookingId: string, template: RequestMessageKind) => Promise<void>;

/** A person is waiting for the answer to a click, so a dead Redis is given up on quickly. */
export const REQUEST_ENQUEUE_TIMEOUT_MS = 2_000;

/** The real queue. */
export const enqueueRequestMessage: RequestEnqueue = (bookingId, template) =>
  within(enqueueSendMessage(bookingId, template), REQUEST_ENQUEUE_TIMEOUT_MS, `queueing the "${template}" message`);

/** What decides whether a customer may be messaged on WhatsApp at all: they said yes, there is a number, and their data was not erased. */
export interface WhatsAppContact {
  whatsappOptIn: boolean;
  whatsappE164: string | null;
  redactedAt: Date | null;
}

export function canMessageOnWhatsApp(b: WhatsAppContact): boolean {
  return b.whatsappOptIn && !!b.whatsappE164 && b.redactedAt === null;
}

/** What happened to one message: how it could reach the customer, and whether a job is on the queue for it. */
export interface QueueOutcome {
  /** `none` also covers a customer who cannot be messaged at all (no opt-in, no number, erased) and a route that could not be worked out. */
  route: DeliveryRoute;
  queued: boolean;
}

export interface QueueDeps {
  enqueue?: RequestEnqueue;
  /** Works out how the message can reach the customer (lib/message-route.ts). A test replaces it. */
  route?: (influencerId: string, template: RequestMessageKind) => Promise<DeliveryRoute>;
}

/**
 * Queues one booking-request message, but only when a route to the customer exists: their linked WhatsApp number, their official
 * connection with this template approved, or SMS set up for it. Without one a job could only fail, so nothing is queued and the answer
 * says `none` (the dashboard then shows the host what to do). `queued` is true only when the job is really on the queue (or was already).
 * Never throws and never logs a link.
 */
export async function queueRequestMessage(booking: { id: string; influencerId: string } & WhatsAppContact, template: RequestMessageKind, deps: QueueDeps = {}): Promise<QueueOutcome> {
  if (!canMessageOnWhatsApp(booking)) return { route: "none", queued: false };
  let route: DeliveryRoute;
  try {
    route = await (deps.route ?? customerMessageRoute)(booking.influencerId, template);
  } catch (e) {
    console.error(`[request-messages] could not work out how to reach the customer for "${template}" (booking ${booking.id}): ${redactPayLinks(e instanceof Error ? e.message : String(e))}`);
    return { route: "none", queued: false };
  }
  if (route === "none") return { route, queued: false };
  try {
    await (deps.enqueue ?? enqueueRequestMessage)(booking.id, template);
    return { route, queued: true };
  } catch (e) {
    console.error(`[request-messages] could not queue "${template}" for booking ${booking.id}: ${redactPayLinks(e instanceof Error ? e.message : String(e))}`);
    return { route, queued: false };
  }
}

/** Requests handled per database round trip, and the most rounds one sweep makes (so one sweep stays bounded under any backlog). */
export const EXPIRY_BATCH = 200;
export const EXPIRY_MAX_BATCHES = 25;

export interface ExpiryResult {
  /** Bookings marked EXPIRED, of every kind (what `expireStaleHolds` returns). */
  expired: number;
  /** How many of them were unanswered requests. */
  requests: number;
  /** "request expired" messages put on the queue. */
  queued: number;
}

/**
 * The worker's hold expiry: marks timed-out unpaid bookings EXPIRED (expireStaleHolds) and tells the customer of each REQUESTED
 * booking that lapsed unanswered ("request expired", WhatsApp). The requests go first, in bounded batches, so each one is seen at the
 * moment it is expired; the rest (a held or pending payment that lapsed, which includes an APPROVED request nobody paid: that one gets no
 * message yet, see doc/16) are expired exactly as before.
 *
 * A message is queued only for a booking this sweep (or a concurrent one) really moved from REQUESTED to EXPIRED without the host ever
 * deciding, so an approval or a decline that raced the sweep is never contradicted. If the queue is down the sweep carries on: the
 * bookings are expired either way (availability never depends on this), the messages for that sweep are lost and one line says so.
 */
export async function expireStaleHoldsAndNotify(
  now = new Date(),
  opts: { enqueue?: RequestEnqueue; /** Narrows the sweep (a test's own bookings in a shared database); the worker never passes it. */ scope?: Prisma.BookingWhereInput } = {},
): Promise<ExpiryResult> {
  const enqueue = opts.enqueue ?? enqueueRequestMessage;
  const scope = opts.scope ? [opts.scope] : [];
  // One route lookup per influencer per sweep, however many of their requests lapsed.
  const routes = new Map<string, Promise<DeliveryRoute>>();
  const routeOf = (influencerId: string, template: RequestMessageKind) => {
    let known = routes.get(influencerId);
    if (!known) routes.set(influencerId, (known = customerMessageRoute(influencerId, template)));
    return known;
  };
  let requests = 0;
  let queued = 0;
  let lost = 0;
  let queueDown = false;
  for (let round = 0; round < EXPIRY_MAX_BATCHES; round++) {
    const due = await prisma.booking.findMany({
      where: { status: "REQUESTED", holdExpiresAt: { lte: now }, AND: scope },
      select: { id: true },
      orderBy: { holdExpiresAt: "asc" },
      take: EXPIRY_BATCH,
    });
    if (due.length === 0) break;
    const ids = due.map((d) => d.id);
    const { count } = await prisma.booking.updateMany({
      where: { id: { in: ids }, status: "REQUESTED", holdExpiresAt: { lte: now } },
      data: { status: "EXPIRED" },
    });
    requests += count;
    if (count === 0) continue; // all of them were decided meanwhile; the next round looks again
    const unanswered = await prisma.booking.findMany({
      where: { id: { in: ids }, status: "EXPIRED", decidedAt: null },
      select: { id: true, whatsappOptIn: true, whatsappE164: true, redactedAt: true, session: { select: { service: { select: { influencerId: true } } } } },
    });
    for (const b of unanswered) {
      if (!canMessageOnWhatsApp(b)) continue;
      if (queueDown) {
        lost += 1;
        continue;
      }
      const outcome = await queueRequestMessage({ ...b, influencerId: b.session.service.influencerId }, REQUEST_EXPIRED_TEMPLATE, { enqueue, route: routeOf });
      if (outcome.queued) queued += 1;
      else if (outcome.route !== "none") {
        queueDown = true; // one failure is enough to stop waiting on a dead queue for the rest of this sweep
        lost += 1;
      }
    }
  }
  if (lost > 0) console.error(`[request-messages] ${lost} "request expired" message(s) could not be queued; the requests are expired anyway`);
  const rest = await expireStaleHolds(now, { includeRequests: false, scope: opts.scope });
  return { expired: requests + rest, requests, queued };
}
