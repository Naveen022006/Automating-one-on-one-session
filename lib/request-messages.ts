import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { expireStaleHolds } from "@/lib/holds";
import { REQUEST_EXPIRED_TEMPLATE, redactPayLinks, type RequestMessageKind } from "@/lib/message-kinds";
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

/**
 * Queues one booking-request message. True only when the customer can be messaged AND the job is on the queue (or was already);
 * false when they did not opt in, have no number, were erased, or the queue could not be reached. Never throws and never logs a link.
 */
export async function queueRequestMessage(
  booking: { id: string } & WhatsAppContact,
  template: RequestMessageKind,
  enqueue: RequestEnqueue = enqueueRequestMessage,
): Promise<boolean> {
  if (!canMessageOnWhatsApp(booking)) return false;
  try {
    await enqueue(booking.id, template);
    return true;
  } catch (e) {
    console.error(`[request-messages] could not queue "${template}" for booking ${booking.id}: ${redactPayLinks(e instanceof Error ? e.message : String(e))}`);
    return false;
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
      select: { id: true, whatsappOptIn: true, whatsappE164: true, redactedAt: true },
    });
    for (const b of unanswered) {
      if (!canMessageOnWhatsApp(b)) continue;
      if (queueDown) {
        lost += 1;
        continue;
      }
      if (await queueRequestMessage(b, REQUEST_EXPIRED_TEMPLATE, enqueue)) queued += 1;
      else {
        queueDown = true; // one failure is enough to stop waiting on a dead queue for the rest of this sweep
        lost += 1;
      }
    }
  }
  if (lost > 0) console.error(`[request-messages] ${lost} "request expired" message(s) could not be queued; the requests are expired anyway`);
  const rest = await expireStaleHolds(now, { includeRequests: false, scope: opts.scope });
  return { expired: requests + rest, requests, queued };
}
