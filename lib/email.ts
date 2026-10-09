import { appUrl } from "@/lib/brand";
import { prisma } from "@/lib/db";
import { customerZone } from "@/lib/format";
import { sendCustomerEmail } from "@/lib/customer-email";
import { createMessage, markMessageFailed } from "@/lib/messages";
import { buildSelfServiceUrl } from "@/lib/self-service";
import { transportFromEnv, type EmailSendResult, type EmailTransport, type OutgoingEmail } from "@/lib/email/providers";
import { bookingEmail, type BookingEmailKind } from "@/lib/email/templates";
import type { RenderedEmail } from "@/lib/email/layout";

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

/** Account emails (verify, reset, alerts). Best-effort: returns false instead of throwing. */
export async function sendAccountEmail(
  to: { email: string; name?: string },
  rendered: RenderedEmail,
  tag: string,
): Promise<boolean> {
  try {
    await sendEmail({ to, subject: rendered.subject, html: rendered.html, text: rendered.text, tag });
    return true;
  } catch (e) {
    console.error(`[email:${tag}] failed`, e instanceof Error ? e.message : e);
    return false;
  }
}

/** Kinds that are sent at most once unless explicitly forced (a "resend" from the dashboard or confirmation page). */
const ONCE_KINDS = new Set<EmailKind>(["booking-confirmation", "receipt"]);

/**
 * Renders a customer booking email from the latest booking/session/payment and sends it, recording a Message row
 * (channel EMAIL, template = kind) for the dashboard. Times are shown in the customer's timezone.
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
      tz: customerZone(booking.customerTz, influencer.timezone),
      meetLink: booking.meetLink ?? session.meetLink,
      manageUrl,
      icsUrl: kind === "booking-cancelled" ? null : `${appUrl()}/api/bookings/${encodeURIComponent(booking.id)}/ics`,
      payment: payment
        ? { amountMinor: payment.amountMinor, currency: payment.currency, reference: payment.providerPaymentId }
        : null,
      refundNote: opts.refundNote,
      prepNotes: service.prepNotes,
    });

    // Record 'queued' first, then flip to 'sent' once the provider accepts, so a provider error leaves a
    // 'failed' row (recording that we tried) rather than no trace at all.
    messageId = await createMessage({ bookingId, channel: "email", template: kind, status: "queued" });
    const result = await sendCustomerEmail(influencer.id, {
      to: { email: booking.customerEmail, name: booking.customerName },
      subject: rendered.subject,
      html: rendered.html,
      text: rendered.text,
      tag: kind,
    });
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
    await markMessageFailed(messageId, detail);
    console.error("[email:customer] failed to send booking email", detail);
  }
}
