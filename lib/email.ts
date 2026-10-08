import { prisma } from "@/lib/db";
import { createMessage, markMessageFailed, markMessageSent } from "@/lib/messages";

/** Which customer email we are sending. */
export type EmailKind = "booking-confirmation" | "receipt";

export interface BookingEmail {
  kind: EmailKind;
  subject: string;
  body: string;
}

/**
 * Delivery hook. Phase 4 (real SMTP/email provider) replaces the default, which only writes a structured log
 * line - there is no SMTP in this environment yet. Mirrors the AlertSender hook in lib/alerts.ts.
 */
export type EmailSender = (to: { name: string; email: string }, email: BookingEmail) => Promise<void>;

const logSender: EmailSender = async (to, email) => {
  console.log(
    "[email:customer]",
    JSON.stringify({ to: to.email, name: to.name, kind: email.kind, subject: email.subject }),
  );
};

let sender: EmailSender = logSender;
export function setEmailSender(next: EmailSender): void {
  sender = next;
}

function formatPrice(minor: number, currency: string): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(minor / 100);
}

/**
 * Renders a confirmation/receipt from the booking + payment + session + service and sends it through the
 * current EmailSender, recording a Message row (channel 'email') for the dashboard. Best-effort and
 * non-throwing like lib/alerts.ts: a broken email channel must not fail the caller.
 */
export async function sendBookingEmail(bookingId: string, kind: EmailKind): Promise<void> {
  let messageId: string | null = null;
  try {
    const booking = await prisma.booking.findUnique({
      where: { id: bookingId },
      include: {
        session: { include: { service: { include: { influencer: true } } } },
        payments: { where: { status: "CAPTURED" }, orderBy: { createdAt: "desc" }, take: 1 },
      },
    });
    if (!booking) {
      console.warn(`[email:customer] booking ${bookingId} not found, skipping ${kind}`);
      return;
    }

    const { session } = booking;
    const { service } = session;
    const { influencer } = service;
    const payment = booking.payments[0] ?? null;

    const when = session.startTime.toISOString();
    const link = booking.meetLink ?? session.meetLink;
    const email = renderEmail({ kind, service, influencer, when, link, payment });

    // Record 'queued' first, then flip to 'sent' once the sender returns, so a sender that throws leaves a
    // 'failed' row (recording that we tried) rather than no trace at all.
    messageId = await createMessage({ bookingId, channel: "email", template: kind, status: "queued" });
    await sender({ name: booking.customerName, email: booking.customerEmail }, email);
    await markMessageSent(messageId);
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    await markMessageFailed(messageId, detail);
    console.error("[email:customer] failed to send booking email", e);
  }
}

function renderEmail(args: {
  kind: EmailKind;
  service: { title: string; priceMinor: number; currency: string };
  influencer: { name: string };
  when: string;
  link: string | null;
  payment: { amountMinor: number; currency: string } | null;
}): BookingEmail {
  const { kind, service, influencer, when, link, payment } = args;
  const price = payment ? formatPrice(payment.amountMinor, payment.currency) : formatPrice(service.priceMinor, service.currency);
  const lines: string[] = [];

  if (kind === "receipt") {
    lines.push(`Thank you for your payment of ${price}.`);
    lines.push(`Session: ${service.title} with ${influencer.name}`);
    lines.push(`When: ${when} (UTC)`);
    if (link) lines.push(`Meeting link: ${link}`);
    return { kind, subject: `Receipt for ${service.title}`, body: lines.join("\n") };
  }

  lines.push(`Your booking for ${service.title} with ${influencer.name} is confirmed.`);
  lines.push(`When: ${when} (UTC)`);
  if (link) lines.push(`Join here: ${link}`);
  else lines.push("Your meeting link will follow shortly.");
  return { kind, subject: `Booking confirmed: ${service.title}`, body: lines.join("\n") };
}
