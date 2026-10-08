import { prisma as realPrisma } from "@/lib/db";
import { sendSMS as realSendSMS, type SendResult } from "@/lib/sms";
import { sendWhatsApp as realSendWhatsApp } from "@/lib/whatsapp";

/** Template used for the booking confirmation message (must be approved in WhatsApp Business). */
export const CONFIRMATION_TEMPLATE = "booking_confirmation";

/**
 * Thrown when a message cannot be sent yet but should be retried later. send-message is now enqueued
 * only by the Phase 3 create-meeting job, after it sets the Meet link, so a missing link is not the
 * expected path. This remains a defensive guard: if a job somehow runs before the link is persisted,
 * it throws so BullMQ retries rather than sending an incomplete message.
 */
export class RetryableMessageError extends Error {
  readonly retryable = true;
  constructor(message: string) {
    super(message);
    this.name = "RetryableMessageError";
  }
}

// The subset of the prisma client the job needs; keeps the deps injectable for offline unit tests.
export interface MessagingPrisma {
  booking: {
    findUnique(args: {
      where: { id: string };
      select: { status: true; whatsappE164: true; whatsappOptIn: true; meetLink: true };
    }): Promise<{
      status: string;
      whatsappE164: string;
      whatsappOptIn: boolean;
      meetLink: string | null;
    } | null>;
  };
  message: {
    create(args: {
      data: { bookingId: string; channel: "WHATSAPP" | "SMS"; template: string; status: "PENDING" };
    }): Promise<{ id: string }>;
    update(args: {
      where: { id: string };
      data: { status?: "SENT" | "FAILED"; providerMessageId?: string | null; error?: string | null };
    }): Promise<unknown>;
  };
}

export interface SendBookingMessageDeps {
  prisma?: MessagingPrisma;
  sendWhatsApp?: (input: { to: string; template: string; languageCode?: string; components?: unknown[] }) => Promise<SendResult>;
  sendSMS?: (input: { to: string; body: string }) => Promise<SendResult>;
}

export interface SendBookingMessageResult {
  /** The channel that ultimately succeeded, or null if nothing was sent. */
  channel: "WHATSAPP" | "SMS" | null;
  /** True when the booking opted out and was intentionally not messaged. */
  skipped?: boolean;
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Sends the meeting link to a scheduled booking: tries WhatsApp first and falls back to SMS when
 * WhatsApp fails, recording every attempt in the messages table. Only opted-in numbers are messaged.
 *
 * meetLink is set by the Phase 3 create-meeting job, which enqueues send-message only after the link
 * exists, so by the time this runs the link is normally present. A still-missing link raises
 * RetryableMessageError as a defensive fallback so BullMQ retries rather than sending an incomplete
 * message.
 */
export async function sendBookingMessage(
  bookingId: string,
  deps: SendBookingMessageDeps = {},
): Promise<SendBookingMessageResult> {
  const prisma = deps.prisma ?? (realPrisma as unknown as MessagingPrisma);
  const sendWhatsApp = deps.sendWhatsApp ?? ((input) => realSendWhatsApp(input as never));
  const sendSMS = deps.sendSMS ?? ((input) => realSendSMS(input));

  const booking = await prisma.booking.findUnique({
    where: { id: bookingId },
    select: { status: true, whatsappE164: true, whatsappOptIn: true, meetLink: true },
  });
  if (!booking) throw new Error(`Booking ${bookingId} not found`);

  // Only message numbers that opted in (doc rule). Nothing recorded; the link is still shown on the
  // confirmation page and email so the customer is never blocked.
  if (!booking.whatsappOptIn || !booking.whatsappE164) {
    return { channel: null, skipped: true };
  }

  // The create-meeting job sets meetLink before enqueueing this job, so it is normally present.
  // Guard defensively: if it is somehow missing, retry rather than send an incomplete message.
  if (!booking.meetLink) {
    throw new RetryableMessageError(`Booking ${bookingId} has no meetLink yet; will retry`);
  }

  const link = booking.meetLink;

  // Try WhatsApp first.
  const waRow = await prisma.message.create({
    data: { bookingId, channel: "WHATSAPP", template: CONFIRMATION_TEMPLATE, status: "PENDING" },
  });
  try {
    const { providerMessageId } = await sendWhatsApp({
      to: booking.whatsappE164,
      template: CONFIRMATION_TEMPLATE,
      languageCode: "en",
      // The link is passed as a template body parameter so the approved template renders it.
      components: [{ type: "body", parameters: [{ type: "text", text: link }] }],
    });
    await prisma.message.update({ where: { id: waRow.id }, data: { status: "SENT", providerMessageId } });
    return { channel: "WHATSAPP" };
  } catch (waErr) {
    await prisma.message.update({ where: { id: waRow.id }, data: { status: "FAILED", error: errText(waErr) } });

    // Fall back to SMS.
    const smsRow = await prisma.message.create({
      data: { bookingId, channel: "SMS", template: CONFIRMATION_TEMPLATE, status: "PENDING" },
    });
    try {
      const { providerMessageId } = await sendSMS({
        to: booking.whatsappE164,
        body: `Your session is confirmed. Join here: ${link}`,
      });
      await prisma.message.update({ where: { id: smsRow.id }, data: { status: "SENT", providerMessageId } });
      return { channel: "SMS" };
    } catch (smsErr) {
      await prisma.message.update({ where: { id: smsRow.id }, data: { status: "FAILED", error: errText(smsErr) } });
      // Both channels failed: throw so BullMQ retries. The confirmation page/email still show the link.
      throw new Error(`Both WhatsApp and SMS failed for booking ${bookingId}: ${errText(smsErr)}`);
    }
  }
}
