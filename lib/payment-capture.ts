import type { Prisma } from "@/generated/prisma/client";
import { activeSeatWhere } from "@/lib/holds";

/** What the business transition needs to know about a captured Razorpay payment. */
export interface CapturedPaymentEntity {
  id: string;
  order_id?: string;
  amount: number;
  currency: string;
}

/**
 * - `paid`:    the booking is now PAID and `enqueue` was called for it.
 * - `flagged`: the money was captured but the booking cannot be honoured; the payment is recorded as captured with
 *              `needsRefund` set (and the booking marked FAILED where it was waiting for this payment).
 * - `ignored`: not an order we created, or the payment was already applied.
 */
export type CaptureOutcome = "paid" | "flagged" | "ignored";

export interface CaptureResult {
  outcome: CaptureOutcome;
  bookingId?: string;
  /** Why the payment was flagged for refund (outcome `flagged` only). */
  reason?: string;
}

/**
 * The one place a captured payment turns a booking into a paid one. Used by the Razorpay webhook
 * (lib/payment-webhook.ts) and by the missed-webhook recovery job (lib/payment-recovery.ts), so both paths apply
 * exactly the same rules:
 *
 *  - amount or currency differs from the order -> record the capture, flag for refund, booking FAILED
 *  - booking EXPIRED -> pay it only if the seat is still free, otherwise flag for refund and FAILED
 *  - booking HELD / PENDING_PAYMENT -> PAID, hold cleared, create-meeting enqueued
 *  - any other booking state (already paid, cancelled...) -> a second or late payment: flag for refund
 *
 * Must run inside the caller's transaction (idempotency record and `enqueue` belong to it too). Idempotent and safe
 * against the other path running at the same time: every capture takes the booking row lock, and the payment is
 * re-read under that lock, so whichever transaction gets the lock second sees CAPTURED and does nothing.
 */
export async function applyCapturedPayment(
  tx: Prisma.TransactionClient,
  entity: CapturedPaymentEntity,
  enqueue: (bookingId: string) => Promise<void>,
): Promise<CaptureResult> {
  const payment = await tx.payment.findUnique({ where: { providerOrderId: entity.order_id! } });
  if (!payment) return { outcome: "ignored" }; // not an order we created
  if (payment.status === "CAPTURED") return { outcome: "ignored", bookingId: payment.bookingId }; // payment.captured and order.paid both arrive; first one wins

  await tx.$queryRaw`SELECT id FROM bookings WHERE id = ${payment.bookingId} FOR UPDATE`;
  // The webhook and the recovery job can race: the other transaction may have applied this payment while we waited
  // for the booking lock. Without this re-read the loser would see a PAID booking and wrongly flag a refund.
  const current = await tx.payment.findUniqueOrThrow({ where: { id: payment.id }, select: { status: true } });
  if (current.status === "CAPTURED") return { outcome: "ignored", bookingId: payment.bookingId };

  const booking = await tx.booking.findUniqueOrThrow({
    where: { id: payment.bookingId },
    include: { session: { include: { service: true } } },
  });

  const captured = { status: "CAPTURED" as const, providerPaymentId: entity.id, recoveryError: null };
  const needsRefund = async (reason: string): Promise<CaptureResult> => {
    await tx.payment.update({ where: { id: payment.id }, data: { ...captured, needsRefund: true, failureReason: reason } });
    return { outcome: "flagged", bookingId: booking.id, reason };
  };

  if (entity.amount !== payment.amountMinor || entity.currency !== payment.currency) {
    const result = await needsRefund("captured amount does not match the order");
    await tx.booking.update({ where: { id: booking.id }, data: { status: "FAILED" } });
    return result;
  }

  if (booking.status === "EXPIRED") {
    // Paid after the hold timed out: honour it only if the seat is still free.
    await tx.$queryRaw`SELECT id FROM sessions WHERE id = ${booking.sessionId} FOR UPDATE`;
    const taken = await tx.booking.count({
      where: { sessionId: booking.sessionId, id: { not: booking.id }, ...activeSeatWhere(new Date()) },
    });
    if (taken >= booking.session.service.capacity) {
      const result = await needsRefund("paid after the hold expired and the slot was taken");
      await tx.booking.update({ where: { id: booking.id }, data: { status: "FAILED" } });
      return result;
    }
  } else if (booking.status !== "HELD" && booking.status !== "PENDING_PAYMENT") {
    // Already paid, or cancelled/failed: this is a second or late payment.
    return needsRefund(`payment captured while booking was ${booking.status}`);
  }

  await tx.payment.update({ where: { id: payment.id }, data: captured });
  await tx.booking.update({ where: { id: booking.id }, data: { status: "PAID", holdExpiresAt: null } });
  await enqueue(booking.id);
  return { outcome: "paid", bookingId: booking.id };
}
