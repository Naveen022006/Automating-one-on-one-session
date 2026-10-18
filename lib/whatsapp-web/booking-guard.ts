import { prisma } from "@/lib/db";
import type { QueuedSend } from "./send-queue";

/**
 * "Never message anyone who does not have a real booking with that influencer." The send queue asks this before every message, and
 * once more immediately before the send when the message had to wait: the booking must exist, belong to this influencer (through its
 * session and service), carry exactly this WhatsApp number and have the customer's WhatsApp opt-in.
 *
 * Answers:
 *  - `true`: send;
 *  - `false`: there is no such booking for this influencer and number (or no opt-in);
 *  - `"not-sendable"`: the booking exists but is not in a state this message makes sense for any more (it was cancelled, failed or
 *    expired while the message waited, or the customer's data was erased). The caller drops the message instead of sending it another way.
 *
 * Which states are fine depends on the message (`req.kind`, the template key): a cancellation notice is for a cancelled booking, a
 * reminder needs a still SCHEDULED one, a confirmation or a reschedule notice needs a paid or scheduled one. A request that does not
 * say what it is (no `kind`) gets the widest rule, the one the first version used (paid, scheduled, completed or cancelled).
 */

const STATUSES_BY_KIND: Record<string, string[]> = {
  "booking-confirmation": ["PAID", "SCHEDULED", "COMPLETED"],
  "reminder-24h": ["SCHEDULED"],
  "reminder-15m": ["SCHEDULED"],
  reschedule: ["PAID", "SCHEDULED"],
  cancellation: ["PAID", "SCHEDULED", "COMPLETED", "CANCELLED"],
};
const LEGACY_STATUSES = ["PAID", "SCHEDULED", "COMPLETED", "CANCELLED"];

export async function bookingAllowsMessage(influencerId: string, req: Pick<QueuedSend, "bookingId" | "toE164" | "kind">): Promise<true | false | "not-sendable"> {
  const found = await prisma.booking.findFirst({
    where: {
      id: req.bookingId,
      whatsappE164: req.toE164,
      whatsappOptIn: true,
      session: { service: { influencerId } },
    },
    select: { status: true, redactedAt: true },
  });
  if (!found) return false;
  if (found.redactedAt !== null) return "not-sendable";
  const allowed = (req.kind ? STATUSES_BY_KIND[req.kind] : undefined) ?? LEGACY_STATUSES;
  return allowed.includes(found.status) ? true : "not-sendable";
}
