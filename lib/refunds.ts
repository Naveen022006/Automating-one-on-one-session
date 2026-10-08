import { alertInfluencer } from "@/lib/alerts";
import { prisma } from "@/lib/db";
import { createRefund, type RazorpayRefund } from "@/lib/payments";

export { NOTICE_MS, describeRefundPolicy, refundDecision, type CancelActor, type RefundPolicy } from "@/lib/refund-policy";

export class RefundError extends Error {}
export class RefundNotAllowedError extends Error {}

export interface RefundDeps {
  createRefund: (input: Parameters<typeof createRefund>[0]) => Promise<RazorpayRefund>;
  alert: typeof alertInfluencer;
}
const defaultDeps: RefundDeps = { createRefund: (i) => createRefund(i), alert: alertInfluencer };

/**
 * Issues a Razorpay refund for a captured payment and records it. Safe against double clicks and concurrent
 * calls: the payment is first "claimed" (refundStatus = 'requested') with a conditional update, so only one
 * caller ever reaches Razorpay. On a Razorpay error the claim is released and the error rethrown.
 *
 * The payment moves to REFUNDED as soon as Razorpay accepts the refund; `refundStatus` then tracks Razorpay's
 * own status ("pending" -> "processed", or "failed", which re-flags the payment, see applyRefundWebhook).
 */
export async function refundPayment(
  paymentId: string,
  opts: { influencerId?: string; amountMinor?: number; reason?: string } = {},
  overrides: Partial<RefundDeps> = {},
): Promise<{ refundId: string; status: string; amountMinor: number }> {
  const deps = { ...defaultDeps, ...overrides };
  const payment = await prisma.payment.findFirst({
    where: {
      id: paymentId,
      ...(opts.influencerId ? { booking: { session: { service: { influencerId: opts.influencerId } } } } : {}),
    },
  });
  if (!payment) throw new RefundNotAllowedError("Payment not found");
  if (payment.status !== "CAPTURED" || !payment.providerPaymentId) {
    throw new RefundNotAllowedError(
      payment.status === "REFUNDED" ? "This payment was already refunded" : "Only captured payments can be refunded",
    );
  }
  const amountMinor = opts.amountMinor ?? payment.amountMinor;
  if (!Number.isInteger(amountMinor) || amountMinor <= 0 || amountMinor > payment.amountMinor) {
    throw new RefundNotAllowedError("Refund amount must be between 1 and the amount paid");
  }

  const claimed = await prisma.payment.updateMany({
    where: { id: payment.id, status: "CAPTURED", refundId: null, OR: [{ refundStatus: null }, { refundStatus: "failed" }] },
    data: { refundStatus: "requested" },
  });
  if (claimed.count === 0) throw new RefundNotAllowedError("A refund for this payment is already in progress");

  let refund: RazorpayRefund;
  try {
    refund = await deps.createRefund({
      providerPaymentId: payment.providerPaymentId,
      amountMinor,
      receipt: `refund_${payment.id}`,
      notes: { paymentId: payment.id, bookingId: payment.bookingId, reason: (opts.reason ?? "").slice(0, 200) },
    });
  } catch (e) {
    await prisma.payment.update({ where: { id: payment.id }, data: { refundStatus: null } });
    throw new RefundError(e instanceof Error ? e.message : String(e));
  }

  await prisma.payment.update({
    where: { id: payment.id },
    data: {
      status: "REFUNDED",
      needsRefund: false,
      refundId: refund.id,
      refundStatus: refund.status,
      refundAmountMinor: refund.amount ?? amountMinor,
      refundedAt: new Date(),
    },
  });
  return { refundId: refund.id, status: refund.status, amountMinor: refund.amount ?? amountMinor };
}

/** Applies a Razorpay `refund.processed` / `refund.failed` webhook to the stored payment. */
export async function applyRefundWebhook(
  event: "refund.processed" | "refund.failed",
  refund: { id: string; payment_id: string; status?: string },
  alert: typeof alertInfluencer = alertInfluencer,
  db: Pick<typeof prisma, "payment"> = prisma,
): Promise<boolean> {
  const payment = await db.payment.findFirst({
    where: { OR: [{ refundId: refund.id }, { providerPaymentId: refund.payment_id }] },
    include: { booking: { select: { id: true, session: { select: { service: { select: { influencerId: true } } } } } } },
  });
  if (!payment) return false;
  if (event === "refund.processed") {
    await db.payment.update({
      where: { id: payment.id },
      data: { status: "REFUNDED", refundId: refund.id, refundStatus: "processed", needsRefund: false },
    });
    return true;
  }
  await db.payment.update({
    where: { id: payment.id },
    data: { status: "CAPTURED", refundId: null, refundStatus: "failed", needsRefund: true },
  });
  // Alert after the caller's transaction commits would be ideal; alertInfluencer never throws, so a failed alert
  // cannot roll the webhook back.
  void alert(payment.booking.session.service.influencerId, {
    kind: "refund-failed",
    detail: "Razorpay could not complete a refund. The payment is flagged again so you can retry from the dashboard.",
    bookingId: payment.booking.id,
  });
  return true;
}
