import { alertInfluencer } from "@/lib/alerts";
import { prisma } from "@/lib/db";
import { formatSessionTime } from "@/lib/format";
import { isRequestMessageKind, messageMayBeSent, redactPayLinks } from "@/lib/message-kinds";
import {
  CONFIRMATION_TEMPLATE,
  smsBody,
  templateParams,
  whatsappComponents,
  type MessageContext,
} from "@/lib/message-templates";
import { requestMessageContext } from "@/lib/request-message-context";
import { buildSelfServiceUrl } from "@/lib/self-service";
import { sendSMS as realSendSMS, type SendResult } from "@/lib/sms";
import { sendWhatsApp as realSendWhatsApp } from "@/lib/whatsapp";
import { WhatsAppNotConnectedError, markTokenInvalid, resolveSendCredentials } from "@/lib/whatsapp-connection";
import { WhatsAppGraphError } from "@/lib/whatsapp-connect";
import { readQrConfig } from "@/lib/whatsapp-web/config";
import { isReminderTemplate, webSendDeadline } from "@/lib/whatsapp-web/deadline";
import { whatsAppWebText } from "@/lib/whatsapp-web/messages";
import { isWhatsAppWebReady, sendWhatsAppWebText, type WhatsAppWebSendRequest, type WhatsAppWebSendResult } from "@/lib/whatsapp-web/send";
import { statusesThatMayAdvanceTo, type WhatsAppStatusUpdate } from "@/lib/whatsapp-webhook";

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

/*
 * Which booking states each message may be sent in lives in lib/message-kinds.ts (messageMayBeSent), shared with the linked-number
 * queue's booking check so the two cannot disagree. A booking that has been cancelled, expired or failed gets no confirmation or
 * reminder; a cancellation notice is meant for a CANCELLED booking; the four booking-request messages read the request's own facts.
 * Always read at run time, never trusted from enqueue time: the booking may have changed since the job was queued.
 */

export interface SendBookingMessageResult {
  /** The channel that ultimately succeeded, or null if nothing was sent. WHATSAPP_WEB is the influencer's QR-linked number. */
  channel: "WHATSAPP" | "WHATSAPP_WEB" | "SMS" | null;
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
  /** The optional QR-linked WhatsApp route (worker process only). Real by default; tests plug in a fake. */
  qr: {
    isReady: (influencerId: string) => boolean;
    send: (req: WhatsAppWebSendRequest) => Promise<WhatsAppWebSendResult>;
  };
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
  qr: {
    // A dry run only logs, so it never touches a real linked number.
    isReady: (influencerId) => process.env.MESSAGING_DRY_RUN !== "true" && isWhatsAppWebReady(influencerId),
    send: sendWhatsAppWebText,
  },
};

/** The marker a QR send leaves on its row between "handed to the queue" and "outcome recorded". A retry that finds it must not send again. */
const QR_IN_FLIGHT = "in-flight";
/**
 * The error text of a linked-number row whose send got no answer in time (the message may still arrive). The row is SENT with this
 * text and no provider id: nothing sends it another way (it could arrive twice), and the Messages view says "not confirmed".
 */
export const QR_UNKNOWN_DELIVERY = "unknown-delivery";

/**
 * Refusals where the linked number never TRIED to send: it was busy, not connected, over its daily limit, paused, the message was too
 * late, or the check before the send said no. The official route records nothing for a connection it did not use
 * (WhatsAppNotConnectedError), and neither does this one: the in-flight row is removed, so a group session's reminders that went by
 * SMS because the linked number was busy leave no "failed" rows behind. Every other reason is a real attempt that failed (the library
 * or WhatsApp refused it) and keeps a FAILED row with the reason.
 */
const NOT_ATTEMPTED = new Set([
  "busy",
  "queue-full",
  "not-connected",
  "not-linked",
  "manager-not-running",
  "qr-disabled",
  "daily-cap",
  "circuit-open",
  "expired",
  "not-sendable",
  "limits-unavailable",
  "guard-unavailable",
  "no-booking",
  "not-on-whatsapp",
  "invalid-number",
  "empty-text",
  "missing-booking",
  "queue-error",
]);

/** What the influencer reads on a linked-number row whose send was attempted and failed (the message went the next way). */
function describeWebRefusal(reason: string): string {
  switch (reason) {
    case "busy":
    case "queue-full":
      return "The linked number had too many messages waiting";
    case "expired":
      return "Too late to send from the linked number";
    case "daily-cap":
      return "The linked number reached its daily limit";
    case "circuit-open":
      return "Sending from the linked number is paused";
    case "not-on-whatsapp":
      return "This customer's number is not on WhatsApp";
    case "no-booking":
      return "No matching booking for the linked number";
    case "not-connected":
    case "not-linked":
    case "manager-not-running":
      return "The linked number was not connected";
    default:
      return "The linked number could not send it";
  }
}

type WebOutcome =
  | { kind: "sent"; providerMessageId: string }
  /** Handed over, but no answer in time: it may still arrive. Nothing else may send it. */
  | { kind: "unknown" }
  /** Not wanted any more (a reminder past its time, a booking cancelled while waiting): send nothing, anywhere. */
  | { kind: "skip" };

/** E.164 as WhatsApp numbers are written: a plus sign, a country code that does not start with 0, up to 15 digits in all. */
const E164 = /^\+[1-9]\d{7,14}$/;

/**
 * The first route for a customer message: the influencer's own QR-linked WhatsApp, when it is switched on, linked and connected right
 * now. Returns the provider message id when the text was handed to WhatsApp, or null to carry on with the official connection, SMS
 * and e-mail (a refusal, retryable or not, ends that way: the next channel, immediately). Three answers are not "carry on":
 * `unknown` (the send got no answer in time and may still arrive), and `skip` (a reminder that waited past its time, or a booking
 * that was cancelled, failed or erased while the message waited): nothing is sent another way.
 *
 * Never sends twice: the row for (booking, WHATSAPP_WEB, template) is marked in flight BEFORE the send and holds the outcome after, and
 * a retry that finds the in-flight mark (the process died between the two, so nobody knows whether it went out) skips this route.
 * Only the nine messages in lib/whatsapp-web/messages.ts (the five booking events and the four booking-request messages) have a text,
 * and the destination must be the valid number on this influencer's own booking; the queue checks the booking again before every send.
 * The text may hold a payment link: it is handed to the queue and the transport and never logged here.
 */
async function tryWhatsAppWeb(
  deps: MessagingDeps,
  b: { bookingId: string; influencerId: string; to: string; template: string; context: MessageContext; sessionStart: Date; holdExpiresAt: Date | null },
): Promise<WebOutcome | null> {
  const { bookingId, influencerId, to, template } = b;
  if (!readQrConfig().enabled || !deps.qr.isReady(influencerId)) return null;
  if (!E164.test(to)) return null;
  const linked = await prisma.whatsAppWebSession.findUnique({ where: { influencerId }, select: { status: true, wantLinked: true } });
  if (!linked || linked.status !== "LINKED" || !linked.wantLinked) return null;

  const text = whatsAppWebText(template, b.context);
  if (text === null) return null;

  const where = { bookingId_channel_template: { bookingId, channel: "WHATSAPP_WEB" as const, template } };
  const earlier = await prisma.message.findUnique({ where, select: { error: true, updatedAt: true } });
  if (earlier?.error === QR_IN_FLIGHT) {
    console.warn(`[send-message] booking ${bookingId}: an earlier send from the linked number was never recorded; not sending it that way again`);
    return null;
  }
  await prisma.message.upsert({
    where,
    create: { bookingId, template, channel: "WHATSAPP_WEB", status: "PENDING", error: QR_IN_FLIGHT },
    update: { status: "PENDING", error: QR_IN_FLIGHT },
  });

  // The key is the same for every retry of this message; it changes only when the row was deliberately re-armed (a resend), so the
  // queue's own short memory of "already sent" can never swallow a message the influencer asked for again.
  const key = `${bookingId}:${template}:${earlier ? earlier.updatedAt.getTime() : 0}`;
  let result: WhatsAppWebSendResult;
  try {
    result = await deps.qr.send({ influencerId, toE164: to, text, bookingId, key, kind: template, deadlineAtMs: webSendDeadline(template, b.sessionStart.getTime(), Date.now(), b.holdExpiresAt?.getTime()) });
  } catch {
    result = { ok: false, reason: "send-error", retryable: true };
  }
  if (result.ok) return { kind: "sent", providerMessageId: result.providerMessageId };

  if (result.reason === "unknown-delivery") {
    // SENT without a provider id: the dedupe stops every other channel, the Messages view shows it as "not confirmed".
    await prisma.message.update({ where, data: { status: "SENT", error: QR_UNKNOWN_DELIVERY, sentAt: new Date() } });
    console.warn(`[send-message] booking ${bookingId}: the linked WhatsApp gave no answer in time for "${template}"; it may still arrive, so it is not sent another way`);
    return { kind: "unknown" };
  }
  const lateReminder = result.reason === "expired" && isReminderTemplate(template);
  if (lateReminder || result.reason === "not-sendable") {
    await prisma.message.deleteMany({ where: { bookingId, channel: "WHATSAPP_WEB", template } }); // nothing was sent: leave no row, like any skipped message
    console.info(`[send-message] booking ${bookingId}: "${template}" dropped (${result.reason}); not sent anywhere`);
    return { kind: "skip" };
  }
  if (NOT_ATTEMPTED.has(result.reason)) {
    await prisma.message.deleteMany({ where: { bookingId, channel: "WHATSAPP_WEB", template, status: "PENDING", error: QR_IN_FLIGHT } });
    console.info(`[send-message] booking ${bookingId}: the linked WhatsApp did not try (${result.reason}); trying the next channel`);
    return null;
  }
  await prisma.message.update({ where, data: { status: "FAILED", error: `${describeWebRefusal(result.reason)}; sent another way.`.slice(0, 500) } });
  console.info(`[send-message] booking ${bookingId}: not sent from the linked WhatsApp (${result.reason}); trying the next channel`);
  return null;
}

/** An error as text for a log line or a stored row. Never carries a payment link, even if a provider echoed the message back. */
function errText(e: unknown): string {
  return redactPayLinks(e instanceof Error ? e.message : String(e));
}

/** The customer's manage/status link, or null when APP_URL / APP_SECRET are missing: no link rather than no message. */
function manageLink(bookingId: string): string | null {
  try {
    return buildSelfServiceUrl(bookingId);
  } catch {
    return null;
  }
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
    include: {
      session: { include: { service: { include: { influencer: true } } } },
      payments: { select: { id: true }, take: 1 },
      // Whether the customer was really sent "request received" (read by the rule for "request expired").
      messages: { where: { template: "request-received", channel: { in: ["WHATSAPP", "WHATSAPP_WEB", "SMS"] }, status: { in: ["SENT", "DELIVERED", "READ"] } }, select: { id: true }, take: 1 },
    },
  });
  if (!booking) {
    console.warn(`[send-message] booking ${bookingId} not found, skipping`);
    return "skipped";
  }
  const now = new Date();
  if (booking.redactedAt) {
    console.warn(`[send-message] booking ${bookingId} was redacted on request, skipping`);
    return "skipped";
  }
  // Which states a message is for depends on the message (lib/message-kinds.ts): a cancellation notice is meant for a CANCELLED booking,
  // a "request declined" notice for a declined request, and so on.
  const facts = {
    status: booking.status,
    holdExpiresAt: booking.holdExpiresAt,
    decidedAt: booking.decidedAt,
    requiresApproval: booking.session.service.requiresApproval,
    hasPayment: booking.payments.length > 0,
    receivedDelivered: booking.messages.length > 0,
  };
  if (!messageMayBeSent(template, facts, now, "sender")) {
    console.warn(`[send-message] booking ${bookingId} is ${booking.status}; "${template}" not sendable, skipping`);
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
      channel: { in: ["WHATSAPP", "WHATSAPP_WEB", "SMS"] },
      status: { in: ["SENT", "DELIVERED", "READ"] },
    },
    select: { id: true },
  });
  if (alreadyDelivered) return "already-sent";

  const { session } = booking;
  const { service } = session;
  const { influencer } = service;
  const to = booking.whatsappE164;
  // Every template gets the same readable values: link, service, host and the time in Indian Standard Time
  // ("Mon, 12 Oct 2026, 11:00 AM IST"), never a raw ISO timestamp. See lib/message-templates.ts.
  const context: MessageContext = {
    link: booking.meetLink ?? session.meetLink ?? null,
    serviceTitle: service.title,
    influencerName: influencer.name,
    when: formatSessionTime(session.startTime),
    manageUrl: manageLink(bookingId),
  };
  // The booking-request messages carry values worked out now (the payment link, the pay-by time, the amount...). They are never read
  // from the job and never stored, and a message that cannot have its link (the time to pay has passed) is not sent at all.
  if (isRequestMessageKind(template)) {
    const extra = requestMessageContext(
      template,
      { bookingId, holdExpiresAt: booking.holdExpiresAt, declineReason: booking.declineReason, priceMinor: service.priceMinor, currency: service.currency, slug: influencer.slug },
      now,
    );
    if (extra === null) {
      console.warn(`[send-message] booking ${bookingId}: "${template}" cannot be built now (the time to pay has passed, or no link can be signed); skipping`);
      return "skipped";
    }
    Object.assign(context, extra);
  }
  const body = smsBody(template, context);

  // First choice, only when the influencer linked their own number by QR code and it is connected right now. Any refusal falls
  // through to the official connection below as if this route did not exist.
  const viaLinkedNumber = await tryWhatsAppWeb(deps, { bookingId, influencerId: influencer.id, to, template, context, sessionStart: session.startTime, holdExpiresAt: booking.holdExpiresAt });
  if (viaLinkedNumber?.kind === "sent") {
    await recordSent(bookingId, "WHATSAPP_WEB", template, viaLinkedNumber.providerMessageId);
    return "sent";
  }
  if (viaLinkedNumber?.kind === "unknown") return "sent";
  if (viaLinkedNumber?.kind === "skip") return "skipped";

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

  await recordSent(bookingId, channel, template, result.providerMessageId);
  return "sent";
}

/** Records the channel that delivered: SENT with the provider's message id (later moved on by its delivery callbacks). */
async function recordSent(bookingId: string, channel: "WHATSAPP" | "WHATSAPP_WEB" | "SMS", template: string, providerMessageId: string): Promise<void> {
  const data = { status: "SENT" as const, providerMessageId, error: null, sentAt: new Date() };
  const write = () =>
    prisma.message.upsert({
      where: { bookingId_channel_template: { bookingId, channel, template } },
      create: { bookingId, template, channel, ...data },
      update: data,
    });
  try {
    await write();
  } catch (e) {
    // The message is already out. One more try before the job fails and is retried (a retry would find nothing recorded).
    if (channel !== "WHATSAPP_WEB") throw e;
    await write();
  }
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

  const detail = redactPayLinks(`Could not deliver "${template}" message after repeated failures: ${message}`).slice(0, 500);
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
      channel: { in: ["WHATSAPP", "WHATSAPP_WEB", "SMS"] },
      status: { in: ["SENT", "DELIVERED", "READ"] },
    },
    select: { channel: true },
  });
  const channel = row?.channel === "SMS" ? "SMS" : row?.channel === "WHATSAPP_WEB" ? "WHATSAPP_WEB" : "WHATSAPP";
  return { channel };
}

/**
 * Re-arms a message type for a deliberate re-send (resend link, a second reschedule): the idempotency check in
 * sendMessageForBooking skips a template that was already delivered, so its WhatsApp/SMS rows go back to PENDING
 * first. Pair with a unique job suffix in enqueueSendMessage so BullMQ does not dedupe the new job either.
 */
export async function rearmMessage(bookingId: string, template: string): Promise<void> {
  // The provider id and send time go too: a delivery callback for the PREVIOUS send (it can arrive hours later) must not
  // find this row and flip it to READ, which would make the new send look already delivered.
  await prisma.message.updateMany({
    where: { bookingId, template, channel: { in: ["WHATSAPP", "WHATSAPP_WEB", "SMS"] } },
    data: { status: "PENDING", error: null, providerMessageId: null, sentAt: null },
  });
}

/**
 * Applies one WhatsApp delivery callback. It only touches the row whose providerMessageId matches AND whose status can
 * move forward to the reported one (see statusesThatMayAdvanceTo), so a late callback can neither revive a re-armed
 * (PENDING) row nor move a message backwards. Returns how many rows changed.
 */
export async function applyWhatsAppStatusUpdate(u: WhatsAppStatusUpdate): Promise<number> {
  // Only overwrite the error column on FAILED transitions (u.error is present). On other transitions the stored error
  // stays, so a later DELIVERED/READ callback does not wipe diagnostic context from a prior FAILED callback.
  const data = "error" in u ? { status: u.status, error: u.error } : { status: u.status };
  const { count } = await prisma.message.updateMany({
    where: { providerMessageId: u.providerMessageId, status: { in: statusesThatMayAdvanceTo(u.status) } },
    data,
  });
  return count;
}
