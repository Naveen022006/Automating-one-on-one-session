import { prisma } from "@/lib/db";
import { statusesThatMayAdvanceTo } from "@/lib/whatsapp-webhook";
import type { WhatsAppWebDeliveryStatus } from "./transport";

/**
 * What WhatsApp tells the worker about a message that a linked number sent (sent, delivered, read, failed) becomes the status of that
 * message's row in `messages` (channel WHATSAPP_WEB). Only messages WE sent are reported (the transport has no event for anything
 * else), and nothing is stored beyond the new status.
 *
 * A row moves forward only (SENT -> DELIVERED -> READ; FAILED from SENT or DELIVERED), the same rule as the official connection's
 * callbacks (statusesThatMayAdvanceTo), so a late or repeated receipt changes nothing. The row is found by the provider's message id
 * AND the influencer who owns the booking. A receipt can arrive a moment before the send is recorded; when no row has that id yet it
 * is tried again a few times, then dropped.
 */

export type MessageDeliveryStatus = "SENT" | "DELIVERED" | "READ" | "FAILED";

export function messageStatusFor(status: WhatsAppWebDeliveryStatus): MessageDeliveryStatus {
  switch (status) {
    case "delivered":
      return "DELIVERED";
    case "read":
      return "READ";
    case "failed":
      return "FAILED";
    default:
      return "SENT";
  }
}

export const DELIVERY_FAILED_TEXT = "WhatsApp reported that this message was not delivered.";

export interface DeliveryDb {
  /** Moves the matching row forward. Returns how many rows changed. */
  advance(influencerId: string, providerMessageId: string, status: MessageDeliveryStatus): Promise<number>;
  /** Is there a WHATSAPP_WEB row of this influencer with this provider id at all? */
  exists(influencerId: string, providerMessageId: string): Promise<boolean>;
}

export const prismaDeliveryDb: DeliveryDb = {
  async advance(influencerId, providerMessageId, status) {
    const { count } = await prisma.message.updateMany({
      where: {
        channel: "WHATSAPP_WEB",
        providerMessageId,
        booking: { session: { service: { influencerId } } },
        status: { in: statusesThatMayAdvanceTo(status) },
      },
      data: status === "FAILED" ? { status, error: DELIVERY_FAILED_TEXT } : { status },
    });
    return count;
  },
  async exists(influencerId, providerMessageId) {
    const row = await prisma.message.findFirst({
      where: { channel: "WHATSAPP_WEB", providerMessageId, booking: { session: { service: { influencerId } } } },
      select: { id: true },
    });
    return row !== null;
  },
};

/** How long to wait before looking again for a row that does not exist yet. */
export const DELIVERY_RETRY_DELAYS_MS = [2_000, 10_000, 30_000] as const;

export interface DeliveryHandlerOptions {
  db?: DeliveryDb;
  /** Runs `fn` after `ms`. The default is an unreferenced timer. */
  schedule?: (fn: () => void, ms: number) => void;
  retryDelaysMs?: readonly number[];
  /** One line when an update fails; never a message id's content, a number or a text. */
  log?: (line: string) => void;
}

/** The function the worker passes to the manager as `onDelivery`. Never throws. Returns the work in progress, for tests. */
export function createDeliveryHandler(opts: DeliveryHandlerOptions = {}) {
  const db = opts.db ?? prismaDeliveryDb;
  const delays = opts.retryDelaysMs ?? DELIVERY_RETRY_DELAYS_MS;
  const log = opts.log ?? ((line: string) => console.warn(`[whatsapp-web] ${line}`));
  const schedule =
    opts.schedule ??
    ((fn: () => void, ms: number) => {
      const timer = setTimeout(fn, ms);
      timer.unref?.();
    });

  const attempt = async (influencerId: string, providerMessageId: string, status: MessageDeliveryStatus, retry: number): Promise<void> => {
    try {
      const changed = await db.advance(influencerId, providerMessageId, status);
      if (changed > 0) return;
      // Nothing moved. Either the row is already at or past this state (done), or the send is not recorded yet (look again shortly).
      if (retry < delays.length && !(await db.exists(influencerId, providerMessageId))) {
        schedule(() => void attempt(influencerId, providerMessageId, status, retry + 1), delays[retry]);
      }
    } catch (e) {
      log(`could not record a delivery state (${e instanceof Error ? e.name : "error"})`);
    }
  };

  return (influencerId: string, info: { providerMessageId: string; status: WhatsAppWebDeliveryStatus }): Promise<void> =>
    attempt(influencerId, info.providerMessageId, messageStatusFor(info.status), 0);
}
