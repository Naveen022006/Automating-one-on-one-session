import { alertInfluencer } from "@/lib/alerts";
import { prisma } from "@/lib/db";
import { customerZone, formatSessionTime } from "@/lib/format";
import {
  CANCELLATION_TEMPLATE,
  CONFIRMATION_TEMPLATE,
  smsBody,
  templateParams,
  whatsappComponents,
  type MessageContext,
} from "@/lib/message-templates";
import { sendSMS as realSendSMS, type SendResult } from "@/lib/sms";
import { sendWhatsApp as realSendWhatsApp } from "@/lib/whatsapp";
import { WhatsAppNotConnectedError, markTokenInvalid, resolveSendCredentials } from "@/lib/whatsapp-connection";
import { WhatsAppGraphError } from "@/lib/whatsapp-connect";

/** Template used for the booking confirmation message (must be approved in WhatsApp Business). */
export { CONFIRMATION_TEMPLATE };

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
 * deliberate exception: it is also sendable for a CANCELLED booking (see the template check in the sender).
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
    /** Whose WhatsApp number to send from (their own connection). */
    influencerId?: string;
    to: string;
    template: string;
    languageCode?: string;
    components?: unknown[];
  }) => Promise<SendResult>;
  sendSMS: (input: { to: string; body: string; template?: string; variables?: string[] }) => Promise<SendResult>;
  alert: typeof alertInfluencer;
}

const defaultDeps: MessagingDeps = {
  sendWhatsApp: async (input) => {
    // Each influencer messages from their own connected number. No healthy connection means this throws and the
    // caller falls back to SMS; a rejected token flags the connection so the influencer is told once.
    const credentials = input.influencerId ? await resolveSendCredentials(input.influencerId, process.env, input.template) : undefined;
    try {
      return await realSendWhatsApp({ ...(input as never as Parameters<typeof realSendWhatsApp>[0]), credentials });
    } catch (e) {
      if (input.influencerId && credentials && e instanceof WhatsAppGraphError && e.invalidToken) {
        await markTokenInvalid(input.influencerId, e.message).catch(() => {});
      }
      throw e;
    }
  },
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
  // A cancellation notice is the one message that is meant for a CANCELLED booking.
  const sendable = SENDABLE_STATUSES.has(booking.status) || (template === CANCELLATION_TEMPLATE && booking.status === "CANCELLED");
  if (booking.redactedAt) {
    console.warn(`[send-message] booking ${bookingId} was redacted on request, skipping`);
    return "skipped";
  }
  if (!sendable) {
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
  // Every template gets the same readable values: link, service, host and the time in the CUSTOMER's timezone
  // (falling back to the influencer's), never a raw ISO timestamp. See lib/message-templates.ts.
  const context: MessageContext = {
    link: booking.meetLink ?? session.meetLink ?? null,
    serviceTitle: service.title,
    influencerName: influencer.name,
    when: formatSessionTime(session.startTime, customerZone(booking.customerTz, influencer.timezone)),
  };
  const body = smsBody(template, context);

  // Try WhatsApp, fall back to SMS. Only if BOTH channels fail do we treat the send as a (transient) failure.
  let channel: "WHATSAPP" | "SMS" = "WHATSAPP";
  let result: SendResult;
  try {
    result = await deps.sendWhatsApp({
      influencerId: influencer.id,
      to,
      template,
      languageCode: process.env.WHATSAPP_TEMPLATE_LANGUAGE || "en",
      components: whatsappComponents(template, context),
    });
  } catch (whatsappError) {
    if (whatsappError instanceof WhatsAppNotConnectedError) {
      // WhatsApp was not even tried (no healthy connection, or this template is not approved yet), so there is no
      // failed attempt to record: go straight to SMS and say why in the log.
      console.info(`[send-message] booking ${bookingId}: not sending by WhatsApp (${errText(whatsappError)}); sending by SMS`);
    } else {
      console.warn(
        `[send-message] WhatsApp failed for booking ${bookingId}, falling back to SMS: ${errText(whatsappError)}`,
      );
      // Record the WhatsApp failure on its own row so the dashboard shows the attempt, then try SMS.
      await recordFailure(bookingId, "WHATSAPP", template, errText(whatsappError));
    }
    channel = "SMS";
    try {
      result = await deps.sendSMS({ to, body, template, variables: templateParams(template, context) });
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
      sentAt: new Date(),
    },
    update: { status: "SENT", providerMessageId: result.providerMessageId, error: null, sentAt: new Date() },
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
  const channel = row?.channel === "SMS" ? "SMS" : "WHATSAPP";
  return { channel };
}

/**
 * Re-arms a message type for a deliberate re-send (resend link, a second reschedule): the idempotency check in
 * sendMessageForBooking skips a template that was already delivered, so its WhatsApp/SMS rows go back to PENDING
 * first. Pair with a unique job suffix in enqueueSendMessage so BullMQ does not dedupe the new job either.
 */
export async function rearmMessage(bookingId: string, template: string): Promise<void> {
  await prisma.message.updateMany({
    where: { bookingId, template, channel: { in: ["WHATSAPP", "SMS"] } },
    data: { status: "PENDING", error: null },
  });
}
