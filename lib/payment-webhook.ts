import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { activeSeatWhere } from "@/lib/holds";
import { enqueueCreateMeeting } from "@/lib/queue";
import { applyRefundWebhook } from "@/lib/refunds";

export interface RazorpayWebhook {
  event: string;
  payload?: {
    payment?: { entity?: RazorpayPaymentEntity };
    refund?: { entity?: { id: string; payment_id: string; status?: string } };
  };
}
interface RazorpayPaymentEntity {
  id: string;
  order_id?: string;
  amount: number;
  currency: string;
  error_description?: string | null;
}

export type WebhookOutcome = "processed" | "duplicate" | "ignored";

/**
 * Applies one verified Razorpay event. Everything, including the idempotency record and the job
 * enqueue, runs in a single transaction: if anything fails the event is not recorded as seen, so
 * Razorpay's retry processes it again. A replayed event id is a no-op.
 */
export async function handleRazorpayEvent(
  eventId: string,
  event: RazorpayWebhook,
  enqueue: (bookingId: string) => Promise<void> = enqueueCreateMeeting,
): Promise<WebhookOutcome> {
  return prisma.$transaction(
    async (tx) => {
      const inserted = await tx.$executeRaw`
        INSERT INTO webhook_events (id, provider, event_id, type, received_at)
        VALUES (${"we_" + crypto.randomUUID()}, 'razorpay', ${eventId}, ${event.event}, now())
        ON CONFLICT (provider, event_id) DO NOTHING`;
      if (inserted === 0) return "duplicate";

      // Refund outcome for a refund issued from the dashboard (lib/refunds.ts).
      if (event.event === "refund.processed" || event.event === "refund.failed") {
        const refund = event.payload?.refund?.entity;
        if (!refund?.id) return "ignored";
        return (await applyRefundWebhook(event.event, refund, undefined, tx)) ? "processed" : "ignored";
      }

      const entity = event.payload?.payment?.entity;
      if (!entity?.order_id) return "ignored";

      if (event.event === "payment.captured" || event.event === "order.paid") {
        await onCaptured(tx, entity, enqueue);
        return "processed";
      }
      if (event.event === "payment.failed") {
        // A failed attempt does not release the seat: the customer can retry on the same order.
        // The hold expiry job releases it if they never pay.
        await tx.payment.updateMany({
          where: { providerOrderId: entity.order_id, status: "CREATED" },
          data: { failureReason: entity.error_description ?? "payment failed" },
        });
        return "processed";
      }
      return "ignored";
    },
    { timeout: 15_000 },
  );
}

async function onCaptured(
  tx: Prisma.TransactionClient,
  entity: RazorpayPaymentEntity,
  enqueue: (bookingId: string) => Promise<void>,
) {
  const payment = await tx.payment.findUnique({ where: { providerOrderId: entity.order_id! } });
  if (!payment) return; // not an order we created
  if (payment.status === "CAPTURED") return; // payment.captured and order.paid both arrive; first one wins

  await tx.$queryRaw`SELECT id FROM bookings WHERE id = ${payment.bookingId} FOR UPDATE`;
  const booking = await tx.booking.findUniqueOrThrow({
    where: { id: payment.bookingId },
    include: { session: { include: { service: true } } },
  });

  const captured = { status: "CAPTURED" as const, providerPaymentId: entity.id };
  const needsRefund = (reason: string) =>
    tx.payment.update({ where: { id: payment.id }, data: { ...captured, needsRefund: true, failureReason: reason } });

  if (entity.amount !== payment.amountMinor || entity.currency !== payment.currency) {
    await needsRefund("captured amount does not match the order");
    await tx.booking.update({ where: { id: booking.id }, data: { status: "FAILED" } });
    return;
  }

  if (booking.status === "EXPIRED") {
    // Paid after the hold timed out: honour it only if the seat is still free.
    await tx.$queryRaw`SELECT id FROM sessions WHERE id = ${booking.sessionId} FOR UPDATE`;
    const taken = await tx.booking.count({
      where: { sessionId: booking.sessionId, id: { not: booking.id }, ...activeSeatWhere(new Date()) },
    });
    if (taken >= booking.session.service.capacity) {
      await needsRefund("paid after the hold expired and the slot was taken");
      await tx.booking.update({ where: { id: booking.id }, data: { status: "FAILED" } });
      return;
    }
  } else if (booking.status !== "HELD" && booking.status !== "PENDING_PAYMENT") {
    // Already paid, or cancelled/failed: this is a second or late payment.
    await needsRefund(`payment captured while booking was ${booking.status}`);
    return;
  }

  await tx.payment.update({ where: { id: payment.id }, data: captured });
  await tx.booking.update({ where: { id: booking.id }, data: { status: "PAID", holdExpiresAt: null } });
  await enqueue(booking.id);
}
