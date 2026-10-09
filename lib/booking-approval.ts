import { prisma } from "@/lib/db";
import { alertInfluencer } from "@/lib/alerts";
import { sendCustomerRendered } from "@/lib/customer-email";
import { requestEmail, type RequestEmailData } from "@/lib/email/templates";
import { formatSessionTime } from "@/lib/format";
import { APPROVED_PAY_HOURS, REQUEST_TTL_HOURS } from "@/lib/holds";
import { buildPayUrl } from "@/lib/self-service";

/**
 * Approval flow for services with `requiresApproval`. A customer's booking starts as REQUESTED (the seat is held
 * for up to REQUEST_TTL_HOURS, nothing is payable). The influencer then approves (-> HELD with a payment deadline,
 * and the customer is emailed a signed payment link) or declines (-> CANCELLED, the customer is told). Nothing is
 * ever charged before approval, so a decline needs no refund.
 */

export class ApprovalError extends Error {
  constructor(
    message: string,
    readonly status = 409,
  ) {
    super(message);
  }
}

/** Never pay later than this long before the session starts, so there is time to create the Meet link. */
export const MIN_LEAD_BEFORE_START_MS = 15 * 60_000;

/** The payment deadline after an approval: 24 hours, but never later than 15 minutes before the session. */
export function paymentDeadline(now: Date, sessionStart: Date): Date | null {
  const deadline = new Date(Math.min(now.getTime() + APPROVED_PAY_HOURS * 3_600_000, sessionStart.getTime() - MIN_LEAD_BEFORE_START_MS));
  // Less than five minutes to pay is not a real chance to pay.
  return deadline.getTime() - now.getTime() >= 5 * 60_000 ? deadline : null;
}

interface Loaded {
  id: string;
  status: string;
  holdExpiresAt: Date | null;
  customerName: string;
  customerEmail: string;
  customerTz: string | null;
  session: { startTime: Date; service: { id: string; title: string; priceMinor: number; currency: string; influencer: { id: string; name: string; timezone: string } } };
}

function emailData(b: Loaded): RequestEmailData {
  return {
    customerName: b.customerName,
    serviceTitle: b.session.service.title,
    influencerName: b.session.service.influencer.name,
    startTime: b.session.startTime,
    tz: b.customerTz ?? b.session.service.influencer.timezone,
  };
}

async function loadOwned(db: Pick<typeof prisma, "booking">, influencerId: string, bookingId: string): Promise<Loaded> {
  const b = await db.booking.findFirst({
    where: { id: bookingId, session: { service: { influencerId } } },
    select: {
      id: true,
      status: true,
      holdExpiresAt: true,
      customerName: true,
      customerEmail: true,
      customerTz: true,
      session: { select: { startTime: true, service: { select: { id: true, title: true, priceMinor: true, currency: true, influencer: { select: { id: true, name: true, timezone: true } } } } } },
    },
  });
  if (!b) throw new ApprovalError("Booking not found", 404);
  return b;
}

/** Emails the customer a receipt of their request and alerts the influencer. Best effort; never throws. */
export async function notifyRequestCreated(bookingId: string): Promise<void> {
  try {
    const b = await prisma.booking.findUnique({
      where: { id: bookingId },
      select: {
        id: true,
        status: true,
        holdExpiresAt: true,
        customerName: true,
        customerEmail: true,
        customerTz: true,
        session: { select: { startTime: true, service: { select: { id: true, title: true, priceMinor: true, currency: true, influencer: { select: { id: true, name: true, timezone: true } } } } } },
      },
    });
    if (!b) return;
    const d = emailData(b);
    await sendCustomerRendered(b.session.service.influencer.id, { email: b.customerEmail, name: b.customerName }, requestEmail("request-received", { ...d, decideWithinHours: REQUEST_TTL_HOURS }), "request-received");
    await alertInfluencer(b.session.service.influencer.id, {
      kind: "booking-request",
      detail: `${b.customerName} asked to book ${b.session.service.title} on ${formatSessionTime(b.session.startTime, b.session.service.influencer.timezone)}. Approve or decline before the held time is released.`,
      bookingId: b.id,
    });
  } catch (e) {
    console.error("[approval] could not send request notifications", e instanceof Error ? e.message : e);
  }
}

/**
 * REQUESTED -> HELD. Conditional on the booking still being a live request, so two clicks (or an approve racing
 * the expiry job) cannot both win. The customer is emailed the payment link afterwards.
 */
export async function approveRequest(influencerId: string, bookingId: string, now = new Date()) {
  const b = await loadOwned(prisma, influencerId, bookingId);
  if (b.status !== "REQUESTED") throw new ApprovalError(b.status === "HELD" ? "This request is already approved." : "This booking is not a pending request.");
  if (!b.holdExpiresAt || b.holdExpiresAt <= now) throw new ApprovalError("This request expired before you answered. The customer can request again.");
  const payBy = paymentDeadline(now, b.session.startTime);
  if (!payBy) throw new ApprovalError("This session starts too soon for the customer to pay. Decline it and ask them to pick another time.");

  const { count } = await prisma.booking.updateMany({
    where: { id: b.id, status: "REQUESTED", holdExpiresAt: { gt: now } },
    data: { status: "HELD", holdExpiresAt: payBy, decidedAt: now, declineReason: null },
  });
  if (count === 0) throw new ApprovalError("This request changed while you were approving it. Refresh and try again.");

  try {
    const payUrl = buildPayUrl(b.id, (payBy.getTime() - now.getTime()) / 1000);
    await sendCustomerRendered(
      b.session.service.influencer.id,
      { email: b.customerEmail, name: b.customerName },
      requestEmail("request-approved", { ...emailData(b), payUrl, payBy, amount: { amountMinor: b.session.service.priceMinor, currency: b.session.service.currency } }),
      "request-approved",
    );
  } catch (e) {
    console.error("[approval] approved but could not email the payment link", e instanceof Error ? e.message : e);
  }
  return { payBy };
}

/** REQUESTED -> CANCELLED with an optional reason shown to the customer. Nothing was charged, so nothing to refund. */
export async function declineRequest(influencerId: string, bookingId: string, reason: string | null, now = new Date()) {
  const b = await loadOwned(prisma, influencerId, bookingId);
  if (b.status !== "REQUESTED") throw new ApprovalError("This booking is not a pending request.");
  const note = reason?.trim().slice(0, 300) || null;
  const { count } = await prisma.booking.updateMany({
    where: { id: b.id, status: "REQUESTED" },
    data: { status: "CANCELLED", decidedAt: now, declineReason: note },
  });
  if (count === 0) throw new ApprovalError("This request changed while you were declining it. Refresh and try again.");
  await sendCustomerRendered(b.session.service.influencer.id, { email: b.customerEmail, name: b.customerName }, requestEmail("request-declined", { ...emailData(b), reason: note }), "request-declined");
}
