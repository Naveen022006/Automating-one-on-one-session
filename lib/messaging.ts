import { alertInfluencer } from "@/lib/alerts";
import { prisma } from "@/lib/db";
import { sendSMS as realSendSMS, type SendResult } from "@/lib/sms";
import { sendWhatsApp as realSendWhatsApp } from "@/lib/whatsapp";

/** Template used for the booking confirmation message (must be approved in WhatsApp Business). */
export const CONFIRMATION_TEMPLATE = "booking-confirmation";

/**
 * Thrown when a message cannot be sent yet but should be retried later. send-message is enqueued
 * only by the create-meeting job, after it sets the Meet link, so a missing link is not the expected
 * path. This remains a defensive guard: if a job somehow runs before the link is persisted, it throws
 * so BullMQ retries rather than sending an incomplete message.
 */
export class RetryableMessageError extends Error {
  readonly retryable = true;
  constructor(message: string) {
    super(message);
    this.name = "RetryableMessageError";
  }
}

export type MessageOutcome = "sent" | "already-sent" | "skipped";

/**
 * Statuses from which a customer message still makes sense. A booking that has been cancelled, expired or
 * failed should not receive a confirmation/reminder, so those are skipped (read at run time, never trusted
 * from enqueue time: the booking may have changed since the job was queued). A cancellation message is a
 * deliberate exception handled by its caller (lib/booking-actions.cancelBooking sends it BEFORE the flip).
 */
const SENDABLE_STATUSES = new Set(["PAID", "SCHEDULED", "COMPLETED"]);

export interface SendBookingMessageResult {
  /** The channel that ultimately succeeded, or null if nothing was sent. */
  channel: "WHATSAPP" | "SMS" | null;
  /** True when the booking opted out and was intentionally not messaged. */
  skipped?: boolean;
}

export interface MessagingDeps {
  sendWhatsApp: (input: {
    to: string;
    template: string;
    languageCode?: string;
    components?: unknown[];
  }) => Promise<SendResult>;
  sendSMS: (input: { to: string; body: string }) => Promise<SendResult>;
  alert: typeof alertInfluencer;
}

const defaultDeps: MessagingDeps = {
  sendWhatsApp: (input) => realSendWhatsApp(input as never),
  sendSMS: (input) => realSendSMS(input),
  alert: alertInfluencer,
};

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Sends (or re-records) a customer message for a booking, trying WhatsApp first and falling back to SMS.
 *
 * This is the single delivery path used by every outbound customer message: the booking confirmation
 * (enqueued by the create-meeting job), the session reminders (Phase 5), and the reschedule/cancellation
 * notices (Phase 5). It re-reads the latest booking at run time, keeps one deterministic Message row per
 * (bookingId, channel, template) via upsert so retries never duplicate rows, records the provider id + SENT
 * on success, records the error on failure, and rethrows a transient failure so BullMQ retries with backoff.
 *
 * Idempotent and safe to run repeatedly: a row already SENT/DELIVERED/READ short-circuits to "already-sent".
 */
export async function sendMessageForBooking(
  bookingId: string,
  template: string,
  overrides: Partial<MessagingDeps> = {},
): Promise<MessageOutcome> {
  const deps = { ...defaultDeps, ...overrides };

  const booking = await prisma.booking.findUnique({
    where: { id: bookingId },
    include: { session: { include: { service: { include: { influencer: true } } } } },
  });
  if (!booking) {
    console.warn(`[send-message] booking ${bookingId} not found, skipping`);
    return "skipped";
  }
  if (!SENDABLE_STATUSES.has(booking.status)) {
    console.warn(`[send-message] booking ${bookingId} is ${booking.status}; not sendable, skipping`);
    return "skipped";
  }
  if (!booking.whatsappOptIn || !booking.whatsappE164) {
    console.warn(`[send-message] booking ${bookingId} has not opted in to messaging, skipping`);
    return "skipped";
  }

  // Idempotency: if THIS message type has already been delivered on either customer channel, do not re-send.
  // Rows are keyed on (bookingId, channel, template), so a confirmation that went out over WhatsApp is a
  // WHATSAPP row; a re-run must not then fire the SMS fallback. We look across both customer channels.
  const alreadyDelivered = await prisma.message.findFirst({
    where: {
      bookingId,
      template,
      channel: { in: ["WHATSAPP", "SMS"] },
      status: { in: ["SENT", "DELIVERED", "READ"] },
    },
    select: { id: true },
  });
  if (alreadyDelivered) return "already-sent";

  const { session } = booking;
  const { service } = session;
  const { influencer } = service;
  const to = booking.whatsappE164;
  const link = booking.meetLink ?? "";
  const body = `${service.title} with ${influencer.name} on ${session.startTime.toISOString()}${
    link ? ` — ${link}` : ""
  }`;

  // Try WhatsApp, fall back to SMS. Only if BOTH channels fail do we treat the send as a (transient) failure.
  let channel: "WHATSAPP" | "SMS" = "WHATSAPP";
  let result: SendResult;
  try {
    result = await deps.sendWhatsApp({
      to,
      template,
      languageCode: "en",
      // The link is passed as a template body parameter so an approved template can render it.
      components: [{ type: "body", parameters: [{ type: "text", text: link }] }],
    });
  } catch (whatsappError) {
    console.warn(
      `[send-message] WhatsApp failed for booking ${bookingId}, falling back to SMS: ${errText(whatsappError)}`,
    );
    // Record the WhatsApp failure on its own row so the dashboard shows the attempt, then try SMS.
    await recordFailure(bookingId, "WHATSAPP", template, errText(whatsappError));
    channel = "SMS";
    try {
      result = await deps.sendSMS({ to, body });
    } catch (smsError) {
      await recordFailure(bookingId, "SMS", template, errText(smsError)); // transient: worker alerts after final attempt
      throw smsError;
    }
  }

  await prisma.message.upsert({
    where: { bookingId_channel_template: { bookingId, channel, template } },
    create: {
      bookingId,
      template,
      channel,
      status: "SENT",
      providerMessageId: result.providerMessageId,
      error: null,
    },
    update: { status: "SENT", providerMessageId: result.providerMessageId, error: null },
  });
  return "sent";
}

/** Records (or creates) the Message row for a channel with the latest failure, without flipping it to FAILED. */
async function recordFailure(
  bookingId: string,
  channel: "WHATSAPP" | "SMS",
  template: string,
  message: string,
): Promise<void> {
  const error = message.slice(0, 500);
  await prisma.message.upsert({
    where: { bookingId_channel_template: { bookingId, channel, template } },
    create: { bookingId, template, channel, status: "PENDING", error },
    update: { error },
  });
}

/**
 * Called by the worker after the final retry failed. Marks the Message row FAILED, records booking.lastError
 * for the dashboard flag, and alerts the influencer. The customer still has the link on the confirmation page
 * and email, so a message failure never blocks the booking.
 */
export async function reportMessageFailure(
  bookingId: string,
  template: string,
  message: string,
  alert: typeof alertInfluencer = alertInfluencer,
): Promise<void> {
  const booking = await prisma.booking.findUnique({
    where: { id: bookingId },
    select: { id: true, session: { select: { service: { select: { influencerId: true } } } } },
  });
  if (!booking) return;

  const detail = `Could not deliver "${template}" message after repeated failures: ${message}`.slice(0, 500);
  // Reaching the final failure means both channels failed; the SMS fallback is the last resort, so its row
  // carries the terminal FAILED state for the dashboard. (The WhatsApp attempt already left its own row.)
  await prisma.message.upsert({
    where: { bookingId_channel_template: { bookingId, channel: "SMS", template } },
    create: { bookingId, template, channel: "SMS", status: "FAILED", error: detail },
    update: { status: "FAILED", error: detail },
  });
  await prisma.booking.update({ where: { id: bookingId }, data: { lastError: detail } });
  await alert(booking.session.service.influencerId, {
    kind: "message-delivery-failed",
    detail,
    bookingId,
  });
}

/**
 * Backwards-compatible wrapper kept for callers that only send the booking confirmation (the Phase 4/6
 * manage + resend flows and the create-meeting confirmation enqueue). Delegates to sendMessageForBooking
 * with the confirmation template and reports the result in the shape those callers expect.
 */
export async function sendBookingMessage(bookingId: string): Promise<SendBookingMessageResult> {
  const outcome = await sendMessageForBooking(bookingId, CONFIRMATION_TEMPLATE);
  if (outcome === "skipped") return { channel: null, skipped: true };
  // sendMessageForBooking records the channel that succeeded on its own row; re-read the delivered one so the
  // caller's log reflects the real channel. A missing row (should not happen on "sent") degrades to WHATSAPP.
  const row = await prisma.message.findFirst({
    where: {
      bookingId,
      template: CONFIRMATION_TEMPLATE,
      channel: { in: ["WHATSAPP", "SMS"] },
      status: { in: ["SENT", "DELIVERED", "READ"] },
    },
    select: { channel: true },
  });
  return { channel: row?.channel ?? "WHATSAPP" };
}
