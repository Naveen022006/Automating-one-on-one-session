import { alertInfluencer } from "@/lib/alerts";
import { prisma } from "@/lib/db";
import { sendSms as defaultSendSms, type SendSms } from "@/lib/sms";
import { sendWhatsAppTemplate as defaultSendWhatsApp, type SendResult, type SendWhatsApp } from "@/lib/whatsapp";

export type MessageOutcome = "sent" | "already-sent" | "skipped";

/**
 * Statuses from which a customer message still makes sense. A booking that has been cancelled, expired or
 * failed should not receive a confirmation/reminder, so those are skipped (read at run time, never trusted
 * from enqueue time: the booking may have changed since the job was queued).
 */
const SENDABLE_STATUSES = new Set(["PAID", "SCHEDULED", "COMPLETED"]);

export interface MessagingDeps {
  sendWhatsApp: SendWhatsApp;
  sendSms: SendSms;
  alert: typeof alertInfluencer;
}

const defaultDeps: MessagingDeps = {
  sendWhatsApp: defaultSendWhatsApp,
  sendSms: defaultSendSms,
  alert: alertInfluencer,
};

/**
 * Sends (or re-records) a customer message for a booking, trying WhatsApp first and falling back to SMS.
 *
 * Mirrors lib/meeting.ts: re-reads the latest booking at run time, keeps one deterministic Message row per
 * (bookingId, template) via upsert so retries never duplicate rows, records the provider id + SENT on
 * success, records the error on failure, and rethrows a transient failure so BullMQ retries with backoff.
 *
 * Idempotent and safe to run repeatedly: a row already SENT/DELIVERED short-circuits to "already-sent".
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
  if (!booking.whatsappOptIn) {
    console.warn(`[send-message] booking ${bookingId} has not opted in to messaging, skipping`);
    return "skipped";
  }

  // Deterministic row per (bookingId, template): the retry writes to the same row instead of a new one.
  const existing = await prisma.message.findUnique({
    where: { bookingId_template: { bookingId, template } },
  });
  if (existing && (existing.status === "SENT" || existing.status === "DELIVERED")) {
    return "already-sent";
  }

  const { session } = booking;
  const { service } = session;
  const { influencer } = service;
  const to = booking.whatsappE164;
  const params: Record<string, string> = {
    customerName: booking.customerName,
    serviceTitle: service.title,
    influencerName: influencer.name,
    startTime: session.startTime.toISOString(),
    meetLink: booking.meetLink ?? "",
  };
  const body = `${service.title} with ${influencer.name} on ${session.startTime.toISOString()}${
    booking.meetLink ? ` — ${booking.meetLink}` : ""
  }`;

  // Try WhatsApp, fall back to SMS. Only if BOTH channels fail do we treat the send as a (transient) failure.
  let channel: "WHATSAPP" | "SMS" = "WHATSAPP";
  let result: SendResult;
  try {
    result = await deps.sendWhatsApp(to, template, params);
  } catch (whatsappError) {
    console.warn(
      `[send-message] WhatsApp failed for booking ${bookingId}, falling back to SMS: ${
        whatsappError instanceof Error ? whatsappError.message : String(whatsappError)
      }`,
    );
    channel = "SMS";
    try {
      result = await deps.sendSms(to, body);
    } catch (smsError) {
      const message = smsError instanceof Error ? smsError.message : String(smsError);
      await recordFailure(bookingId, template, message); // transient: the worker alerts after the final attempt
      throw smsError;
    }
  }

  await prisma.message.upsert({
    where: { bookingId_template: { bookingId, template } },
    create: { bookingId, template, channel, status: "SENT", providerId: result.providerId, error: null },
    update: { channel, status: "SENT", providerId: result.providerId, error: null },
  });
  return "sent";
}

/** Records (or creates) the Message row with the latest failure, without flipping it to FAILED. */
async function recordFailure(bookingId: string, template: string, message: string): Promise<void> {
  const error = message.slice(0, 500);
  await prisma.message.upsert({
    where: { bookingId_template: { bookingId, template } },
    create: { bookingId, template, channel: "SMS", status: "PENDING", error },
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
  await prisma.message.upsert({
    where: { bookingId_template: { bookingId, template } },
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
