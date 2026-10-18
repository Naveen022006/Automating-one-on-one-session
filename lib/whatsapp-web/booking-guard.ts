import { prisma } from "@/lib/db";
import type { QueuedSend } from "./send-queue";

/**
 * "Never message anyone who does not have a real booking with that influencer." The send queue asks this before every message:
 * the booking must exist, belong to this influencer (through its session and service), carry exactly this WhatsApp number, still
 * have its customer data (not erased), have the customer's WhatsApp opt-in, and be in a state a customer message makes sense for
 * (paid, scheduled, completed, or cancelled for the cancellation notice). A held, expired or failed booking never gets a message.
 */
export async function bookingAllowsMessage(influencerId: string, req: Pick<QueuedSend, "bookingId" | "toE164">): Promise<boolean> {
  const found = await prisma.booking.findFirst({
    where: {
      id: req.bookingId,
      whatsappE164: req.toE164,
      whatsappOptIn: true,
      redactedAt: null,
      status: { in: ["PAID", "SCHEDULED", "COMPLETED", "CANCELLED"] },
      session: { service: { influencerId } },
    },
    select: { id: true },
  });
  return found !== null;
}
