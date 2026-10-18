import { prisma } from "@/lib/db";
import { messageMayBeSent } from "@/lib/message-kinds";
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
 * Which states are fine depends on the message (`req.kind`, the template key) and is decided by lib/message-kinds.ts, the same table the
 * sender uses: a cancellation notice is for a cancelled booking, a reminder needs a still SCHEDULED one, a confirmation or a reschedule
 * notice needs a paid or scheduled one, and the four booking-request messages read the request's own facts (decided or not, ever paid,
 * hold still running). A request that does not say what it is (no `kind`) gets the widest rule, the one the first version used (paid,
 * scheduled, completed or cancelled).
 */

export async function bookingAllowsMessage(influencerId: string, req: Pick<QueuedSend, "bookingId" | "toE164" | "kind">): Promise<true | false | "not-sendable"> {
  const found = await prisma.booking.findFirst({
    where: {
      id: req.bookingId,
      whatsappE164: req.toE164,
      whatsappOptIn: true,
      session: { service: { influencerId } },
    },
    select: {
      status: true,
      redactedAt: true,
      holdExpiresAt: true,
      decidedAt: true,
      session: { select: { service: { select: { requiresApproval: true, influencer: { select: { suspendedAt: true } } } } } },
      payments: { select: { id: true }, take: 1 },
      messages: { where: { template: "request-received", channel: { in: ["WHATSAPP", "WHATSAPP_WEB", "SMS"] }, status: { in: ["SENT", "DELIVERED", "READ"] } }, select: { id: true }, take: 1 },
    },
  });
  if (!found) return false;
  if (found.redactedAt !== null) return "not-sendable";
  const facts = {
    status: found.status,
    holdExpiresAt: found.holdExpiresAt,
    decidedAt: found.decidedAt,
    requiresApproval: found.session.service.requiresApproval,
    hasPayment: found.payments.length > 0,
    receivedDelivered: found.messages.length > 0,
    hostSuspended: found.session.service.influencer.suspendedAt !== null,
  };
  // No `kind`: the widest rule (an unlisted template name). The queue only ever sends texts that exist, and every one of them says its kind.
  return messageMayBeSent(req.kind ?? "", facts, new Date(), "queue") ? true : "not-sendable";
}
