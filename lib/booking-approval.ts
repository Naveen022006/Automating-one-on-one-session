import { prisma } from "@/lib/db";
import { alertInfluencer } from "@/lib/alerts";
import { sendCustomerRendered } from "@/lib/customer-email";
import { requestEmail, type RequestEmailData } from "@/lib/email/templates";
import { formatSessionTime } from "@/lib/format";
import { APPROVED_PAY_HOURS, REQUEST_TTL_HOURS } from "@/lib/holds";
import { REQUEST_APPROVED_TEMPLATE, REQUEST_DECLINED_TEMPLATE, type RequestMessageKind } from "@/lib/message-kinds";
import { queueRequestMessage, type QueueOutcome, type WhatsAppContact } from "@/lib/request-messages";
import { buildPayUrl } from "@/lib/self-service";

/**
 * Approval flow for services with `requiresApproval`. A customer's booking starts as REQUESTED (the seat is held
 * for up to REQUEST_TTL_HOURS, nothing is payable). The influencer then approves (-> HELD with a payment deadline,
 * and the customer is sent a signed payment link by e-mail and WhatsApp) or declines (-> CANCELLED, the customer is
 * told the same two ways). Nothing is ever charged before approval, so a decline needs no refund.
 *
 * The WhatsApp messages (lib/request-messages.ts) are queued after the database change has committed, as a job that holds only the
 * booking id and the template: the worker builds the text, and the payment link, when it sends. Queueing is best effort and never
 * changes the answer, except that `whatsappQueued` tells the dashboard whether the customer's WhatsApp is on its way.
 */

/** The seam a test replaces so no job reaches a real queue. */
export interface ApprovalDeps {
  queueMessage: (booking: { id: string; influencerId: string } & WhatsAppContact, template: RequestMessageKind) => Promise<QueueOutcome>;
}
const defaultDeps: ApprovalDeps = { queueMessage: (booking, template) => queueRequestMessage(booking, template) };

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
  whatsappOptIn: boolean;
  whatsappE164: string | null;
  redactedAt: Date | null;
  session: { startTime: Date; service: { id: string; title: string; priceMinor: number; currency: string; influencer: { id: string; name: string } } };
}

function emailData(b: Pick<Loaded, "customerName" | "session">): RequestEmailData {
  return {
    customerName: b.customerName,
    serviceTitle: b.session.service.title,
    influencerName: b.session.service.influencer.name,
    startTime: b.session.startTime,
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
      whatsappOptIn: true,
      whatsappE164: true,
      redactedAt: true,
      session: { select: { startTime: true, service: { select: { id: true, title: true, priceMinor: true, currency: true, influencer: { select: { id: true, name: true } } } } } },
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
        session: { select: { startTime: true, service: { select: { id: true, title: true, priceMinor: true, currency: true, influencer: { select: { id: true, name: true } } } } } },
      },
    });
    if (!b) return;
    const d = emailData(b);
    await sendCustomerRendered(b.session.service.influencer.id, { email: b.customerEmail, name: b.customerName }, requestEmail("request-received", { ...d, decideWithinHours: REQUEST_TTL_HOURS }), "request-received");
    await alertInfluencer(b.session.service.influencer.id, {
      kind: "booking-request",
      detail: `${b.customerName} asked to book ${b.session.service.title} on ${formatSessionTime(b.session.startTime)}. Approve or decline before the held time is released.`,
      bookingId: b.id,
    });
  } catch (e) {
    console.error("[approval] could not send request notifications", e instanceof Error ? e.message : e);
  }
}

/**
 * REQUESTED -> HELD. Conditional on the booking still being a live request, so two clicks (or an approve racing
 * the expiry job) cannot both win. The customer is sent the payment link afterwards: by e-mail and as a queued message (built when it is
 * sent) over the best route that exists (lib/message-route.ts). `messageRoute` says which route that is, `messageQueued` whether the job is
 * really on the queue. When the customer was not e-mailed and no message is on its way, the link is handed back to the host (`payUrl`).
 */
export async function approveRequest(influencerId: string, bookingId: string, now = new Date(), deps: ApprovalDeps = defaultDeps) {
  const b = await loadOwned(prisma, influencerId, bookingId);
  if (b.status !== "REQUESTED") throw new ApprovalError(b.status === "HELD" ? "This request is already approved." : "This booking is not a pending request.");
  // The customer's data was erased on request: there is no one to send a payment link to. Decline it instead.
  if (b.redactedAt) throw new ApprovalError("The customer's details were erased at their request, so this request cannot be approved. Decline it.");
  if (!b.holdExpiresAt || b.holdExpiresAt <= now) throw new ApprovalError("This request expired before you answered. The customer can request again.");
  // A suspended account takes no new payments, so it cannot approve a request into a payable hold. Declining stays allowed.
  const standing = await prisma.influencer.findUnique({ where: { id: influencerId }, select: { suspendedAt: true } });
  if (standing?.suspendedAt) throw new ApprovalError("Your account is suspended, so requests cannot be approved.", 409);
  const payBy = paymentDeadline(now, b.session.startTime);
  if (!payBy) throw new ApprovalError("This session starts too soon for the customer to pay. Decline it and ask them to pick another time.");

  const { count } = await prisma.booking.updateMany({
    where: { id: b.id, status: "REQUESTED", holdExpiresAt: { gt: now }, session: { service: { influencer: { suspendedAt: null } } } },
    data: { status: "HELD", holdExpiresAt: payBy, decidedAt: now, declineReason: null },
  });
  if (count === 0) throw new ApprovalError("This request changed while you were approving it. Refresh and try again.");

  // The WhatsApp message first: it is only a queued job, so it is quick, and it must not wait for a slow e-mail. The booking is HELD now,
  // so the worker finds it payable whenever it runs, and builds the link then (the job carries no link).
  const message = await deps.queueMessage({ ...b, influencerId }, REQUEST_APPROVED_TEMPLATE);

  // The payment link also goes out by e-mail: through the influencer's Gmail, or the platform's provider when it has one (doc/15: with
  // EMAIL_PROVIDER=none and no Gmail nothing is sent). `emailed` says whether it went out; when it did not, the link is handed back to the
  // influencer (who is allowed to see it: it is their customer's payment) so they can send it themselves, instead of the customer waiting
  // for a message that will never come.
  let emailed = false;
  let payUrl: string | null = null;
  try {
    payUrl = buildPayUrl(b.id, (payBy.getTime() - now.getTime()) / 1000);
    emailed = await sendCustomerRendered(
      b.session.service.influencer.id,
      { email: b.customerEmail, name: b.customerName },
      requestEmail("request-approved", { ...emailData(b), payUrl, payBy, amount: { amountMinor: b.session.service.priceMinor, currency: b.session.service.currency } }),
      "request-approved",
    );
  } catch (e) {
    console.error("[approval] approved but could not email the payment link", e instanceof Error ? e.message : e);
  }
  // The link is the host's to hand over only when nothing else will: not e-mailed and no message on its way.
  return { payBy, emailed, payUrl: emailed || message.queued ? null : payUrl, messageRoute: message.route, messageQueued: message.queued };
}

/**
 * REQUESTED -> CANCELLED with an optional reason shown to the customer. Nothing was charged, so nothing to refund. The customer is told
 * by e-mail and as a queued message over the best route that exists; `messageRoute` and `messageQueued` say which and whether it is on its way.
 */
export async function declineRequest(influencerId: string, bookingId: string, reason: string | null, now = new Date(), deps: ApprovalDeps = defaultDeps) {
  const b = await loadOwned(prisma, influencerId, bookingId);
  if (b.status !== "REQUESTED") throw new ApprovalError("This booking is not a pending request.");
  const note = reason?.trim().slice(0, 300) || null;
  const { count } = await prisma.booking.updateMany({
    where: { id: b.id, status: "REQUESTED" },
    data: { status: "CANCELLED", decidedAt: now, declineReason: note },
  });
  if (count === 0) throw new ApprovalError("This request changed while you were declining it. Refresh and try again.");
  const message = await deps.queueMessage({ ...b, influencerId }, REQUEST_DECLINED_TEMPLATE);
  await sendCustomerRendered(b.session.service.influencer.id, { email: b.customerEmail, name: b.customerName }, requestEmail("request-declined", { ...emailData(b), reason: note }), "request-declined");
  return { messageRoute: message.route, messageQueued: message.queued };
}
