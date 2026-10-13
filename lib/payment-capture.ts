import type { Prisma } from "@/generated/prisma/client";
import { activeSeatWhere } from "@/lib/holds";
import { ENQUEUE_TIMEOUT_MS, within } from "@/lib/timeout";

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

export interface CaptureOptions {
  /** Runs inside the transaction right before the booking is queued (the recovery job writes its audit entry here). */
  beforeEnqueue?: (bookingId: string) => Promise<void>;
  /** How long to wait for `enqueue` before throwing (which rolls the transaction back). Default {@link ENQUEUE_TIMEOUT_MS}. */
  enqueueTimeoutMs?: number;
  /** The current time (tests). */
  now?: Date;
}

/**
 * The one place a captured payment turns a booking into a paid one. Used by the Razorpay webhook
 * (lib/payment-webhook.ts) and by the missed-webhook recovery job (lib/payment-recovery.ts), so both paths apply
 * exactly the same rules:
 *
 *  - amount or currency differs from the order -> record the capture, flag for refund, booking FAILED
 *  - a booking that is not waiting for payment (already paid, cancelled...) -> a second or late payment: flag for refund
 *  - the session has already started -> too late to honour it: flag for refund, booking FAILED
 *  - booking EXPIRED, or HELD/PENDING_PAYMENT with a lapsed hold -> pay it only if the seat is still free, otherwise flag
 *    for refund and FAILED
 *  - booking HELD / PENDING_PAYMENT -> PAID, hold cleared, create-meeting enqueued
 *
 * Must run inside the caller's transaction (idempotency record and `enqueue` belong to it too). Idempotent and safe
 * against the other path running at the same time: every capture takes the booking row lock, and the payment is
 * re-read under that lock, so whichever transaction gets the lock second sees CAPTURED and does nothing.
 *
 * `enqueue` is bounded: the BullMQ connection waits forever while Redis is down, which would otherwise hold this
 * transaction open until it times out. On timeout (or any error) it throws and everything rolls back, so the payment
 * stays unapplied and is retried, instead of the booking being paid with no job queued.
 */
export async function applyCapturedPayment(
  tx: Prisma.TransactionClient,
  entity: CapturedPaymentEntity,
  enqueue: (bookingId: string) => Promise<void>,
  opts: CaptureOptions = {},
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
  const refuseAndFail = async (reason: string): Promise<CaptureResult> => {
    const result = await needsRefund(reason);
    await tx.booking.update({ where: { id: booking.id }, data: { status: "FAILED" } });
    return result;
  };

  if (entity.amount !== payment.amountMinor || entity.currency !== payment.currency) {
    return refuseAndFail("captured amount does not match the order");
  }

  if (booking.status !== "EXPIRED" && booking.status !== "HELD" && booking.status !== "PENDING_PAYMENT") {
    // Already paid, or cancelled/failed: this is a second or late payment.
    return needsRefund(`payment captured while booking was ${booking.status}`);
  }

  const now = opts.now ?? new Date();
  // A capture can surface days late (recovery looks back a week). Never book a session that has already begun.
  if (booking.session.startTime.getTime() <= now.getTime()) {
    return refuseAndFail("paid after the session had already started");
  }

  // A HELD/PENDING_PAYMENT booking whose hold has lapsed stopped occupying its seat (activeSeatWhere) before the worker's
  // sweep marks it EXPIRED, which takes up to 30 s and never happens while the worker is down: treat it as expired too.
  const lapsed = booking.holdExpiresAt !== null && booking.holdExpiresAt <= now;
  if (booking.status === "EXPIRED" || lapsed) {
    // Paid after the hold timed out: honour it only if the seat is still free.
    await tx.$queryRaw`SELECT id FROM sessions WHERE id = ${booking.sessionId} FOR UPDATE`;
    const taken = await tx.booking.count({
      where: { sessionId: booking.sessionId, id: { not: booking.id }, ...activeSeatWhere(now) },
    });
    if (taken >= booking.session.service.capacity) {
      return refuseAndFail("paid after the hold expired and the slot was taken");
    }
  }

  await tx.payment.update({ where: { id: payment.id }, data: captured });
  await tx.booking.update({ where: { id: booking.id }, data: { status: "PAID", holdExpiresAt: null } });
  await opts.beforeEnqueue?.(booking.id);
  await within(enqueue(booking.id), opts.enqueueTimeoutMs ?? ENQUEUE_TIMEOUT_MS, "queueing the create-meeting job");
  return { outcome: "paid", bookingId: booking.id };
}
