import { appUrl } from "@/lib/brand";
import { prisma } from "@/lib/db";
import { sendCustomerEmail } from "@/lib/customer-email";
import { GMAIL_FAILED_PREFIX } from "@/lib/gmail";
import { createMessage, markMessageFailed, NO_EMAIL_ROUTE_REASON } from "@/lib/messages";
import { buildSelfServiceUrl, signBookingCalendarToken } from "@/lib/self-service";
import { EmailDisabledError, transportFromEnv, type EmailSendResult, type EmailTransport, type OutgoingEmail } from "@/lib/email/providers";
import { bookingEmail, type BookingEmailKind } from "@/lib/email/templates";
import type { RenderedEmail } from "@/lib/email/layout";

/** The e-mailed calendar-file link carries its own token, valid until 30 days after the session ends. Null without APP_SECRET. */
export function calendarFileUrl(bookingId: string, sessionEnd: Date): string | null {
  try {
    const ttlSec = (sessionEnd.getTime() - Date.now()) / 1000 + 30 * 86_400;
    return `${appUrl()}/api/bookings/${encodeURIComponent(bookingId)}/ics?t=${encodeURIComponent(signBookingCalendarToken(bookingId, ttlSec))}`;
  } catch {
    return null;
  }
}

/** Which customer email we are sending. */
export type EmailKind = BookingEmailKind;

/**
 * Delivery hook. Defaults to the provider chosen by EMAIL_PROVIDER (lib/email/providers.ts); tests replace it.
 * Mirrors the AlertSender hook in lib/alerts.ts.
 */
export type EmailSender = EmailTransport;

let sender: EmailSender | null = null;
export function setEmailSender(next: EmailSender | null): void {
  sender = next;
}
function currentSender(): EmailSender {
  sender ??= transportFromEnv();
  return sender;
}

/** Sends any email through the configured provider. Throws on provider failure. */
export async function sendEmail(email: OutgoingEmail): Promise<EmailSendResult> {
  return currentSender()(email);
}

/**
 * Account emails (verify, reset, alerts). Best-effort: returns false instead of throwing.
 * With EMAIL_PROVIDER=none the platform sends no e-mail: this is a logged no-op (one line with the tag, never the address or the
 * content) that returns false, "not sent". Every caller must treat false as "the person was not told by e-mail".
 */
export async function sendAccountEmail(
  to: { email: string; name?: string },
  rendered: RenderedEmail,
  tag: string,
): Promise<boolean> {
  try {
    await sendEmail({ to, subject: rendered.subject, html: rendered.html, text: rendered.text, tag });
    return true;
  } catch (e) {
    if (e instanceof EmailDisabledError) {
      console.log(`[email:${tag}] not sent: the platform sends no e-mail (EMAIL_PROVIDER=none)`);
      return false;
    }
    console.error(`[email:${tag}] failed`, e instanceof Error ? e.message : e);
    return false;
  }
}

/** What the Message row of this booking and template said before an attempt, when it recorded a sent e-mail. */
interface PriorSent {
  id: string;
  status: "SENT" | "DELIVERED" | "READ" | string;
  sentAt: Date | null;
  providerMessageId: string | null;
}

/** The reason on the row of an e-mail that had no way to go out at all (no Gmail, and EMAIL_PROVIDER=none). */
export { NO_EMAIL_ROUTE_REASON };

/** Puts a row that recorded a sent e-mail back as it was after an attempt that did not send (best effort, never throws). */
async function restoreSentRow(messageId: string | null, prior: PriorSent): Promise<void> {
  if (!messageId) return;
  try {
    await prisma.message.update({
      where: { id: messageId },
      data: { status: prior.status as "SENT" | "DELIVERED" | "READ", error: null, sentAt: prior.sentAt, providerMessageId: prior.providerMessageId },
    });
  } catch (e) {
    console.error("[email:customer] could not restore the record of an earlier sent e-mail", e instanceof Error ? e.message : e);
  }
}

/** Kinds that are sent at most once unless explicitly forced (a "resend" from the dashboard or confirmation page). */
const ONCE_KINDS = new Set<EmailKind>(["booking-confirmation", "receipt"]);

/**
 * Renders a customer booking email from the latest booking/session/payment and sends it, recording a Message row
 * (channel EMAIL, template = kind) for the dashboard. Times are shown in Indian Standard Time (IST).
 *
 * Idempotent for the confirmation/receipt: a re-run of the create-meeting job does not email the customer twice
 * (pass `force` for a deliberate resend). Best-effort and non-throwing like lib/alerts.ts: a broken email channel
 * must not fail the caller.
 */
export async function sendBookingEmail(
  bookingId: string,
  kind: EmailKind,
  opts: { force?: boolean; refundNote?: string | null } = {},
): Promise<void> {
  let messageId: string | null = null;
  let prior: PriorSent | null = null;
  try {
    const booking = await prisma.booking.findUnique({
      where: { id: bookingId },
      include: {
        session: { include: { service: { include: { influencer: true } } } },
        payments: { where: { status: { in: ["CAPTURED", "REFUNDED"] } }, orderBy: { createdAt: "desc" }, take: 1 },
      },
    });
    if (!booking) {
      console.warn(`[email:customer] booking ${bookingId} not found, skipping ${kind}`);
      return;
    }
    if (booking.redactedAt) return; // customer data was erased on request; nowhere to send

    if (ONCE_KINDS.has(kind) && !opts.force) {
      const sent = await prisma.message.findFirst({
        where: { bookingId, channel: "EMAIL", template: kind, status: { in: ["SENT", "DELIVERED", "READ"] } },
        select: { id: true },
      });
      if (sent) return;
    }

    const { session } = booking;
    const { service } = session;
    const { influencer } = service;
    const payment = booking.payments[0] ?? null;

    // A signed self-service link so the customer can reschedule or cancel without a login. Best-effort: if
    // APP_URL/APP_SECRET are unset the link is omitted rather than failing the email.
    let manageUrl: string | null = null;
    try {
      manageUrl = buildSelfServiceUrl(booking.id);
    } catch {
      manageUrl = null;
    }

    const rendered = bookingEmail(kind, {
      customerName: booking.customerName,
      serviceTitle: service.title,
      influencerName: influencer.name,
      durationMin: service.durationMin,
      startTime: session.startTime,
      meetLink: booking.meetLink ?? session.meetLink,
      manageUrl,
      icsUrl: kind === "booking-cancelled" ? null : calendarFileUrl(booking.id, session.endTime),
      payment: payment
        ? { amountMinor: payment.amountMinor, currency: payment.currency, reference: payment.providerPaymentId }
        : null,
      refundNote: opts.refundNote,
      prepNotes: service.prepNotes,
    });

    // Record 'queued' first, then flip to 'sent' once the provider accepts, so a provider error leaves a
    // 'failed' row (recording that we tried) rather than no trace at all.
    // A row that already records a SENT e-mail (a forced resend, a second reschedule) is the record of something that happened: whatever this
    // attempt does, it is put back as it was and never downgraded (createMessage below flips it to "queued" for the time of the attempt).
    prior = await prisma.message.findFirst({
      where: { bookingId, channel: "EMAIL", template: kind, status: { in: ["SENT", "DELIVERED", "READ"] } },
      select: { id: true, status: true, sentAt: true, providerMessageId: true },
    });
    messageId = await createMessage({ bookingId, channel: "email", template: kind, status: "queued" });
    const result = await sendCustomerEmail(influencer.id, {
      to: { email: booking.customerEmail, name: booking.customerName },
      subject: rendered.subject,
      html: rendered.html,
      text: rendered.text,
      tag: kind,
    });
    if (result.via === "none") {
      // No e-mail route: the platform sends none, and the influencer's Gmail is not connected or just failed. Nothing was sent.
      // Gmail tried and failed: say so on the row (the Google panel reads it to show "Gmail not working", see lib/google-tokens.ts).
      // Gmail not in use at all: the row says so too (FAILED with the reason; the enum has no "skipped"), never left as "queued" and never
      // deleted. An e-mail that WAS sent earlier keeps its SENT row. Either way the customer is still reached by WhatsApp or SMS.
      if (prior) await restoreSentRow(messageId, prior);
      else await markMessageFailed(messageId, result.fallbackReason ? `${GMAIL_FAILED_PREFIX} ${result.fallbackReason}` : NO_EMAIL_ROUTE_REASON);
      console.log(`[email:customer] ${kind} not sent for booking ${bookingId}: ${result.fallbackReason ? "Gmail failed" : "no Gmail connection"} and the platform sends no e-mail`);
      return;
    }
    if (messageId) {
      await prisma.message
        .update({
          where: { id: messageId },
          data: { status: "SENT", error: null, sentAt: new Date(), providerMessageId: result.providerMessageId },
        })
        .catch((e) => console.error("[email:customer] could not record sent email", e));
    }
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    if (prior) await restoreSentRow(messageId, prior);
    else await markMessageFailed(messageId, detail);
    console.error("[email:customer] failed to send booking email", detail);
  }
}
