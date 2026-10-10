import { prisma } from "@/lib/db";
import { applyCapturedPayment, type CaptureOptions } from "@/lib/payment-capture";
import { requeueCreateMeeting } from "@/lib/queue";
import { applyRefundWebhook } from "@/lib/refunds";

export interface RazorpayWebhook {
  event: string;
  payload?: {
    payment?: { entity?: RazorpayPaymentEntity };
    refund?: { entity?: { id: string; payment_id: string; amount?: number; status?: string } };
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
  // requeueCreateMeeting, not the plain enqueue: it first clears a finished (completed or failed) job with this booking's
  // id, which BullMQ would otherwise treat as "already queued" and silently skip, leaving a paid booking with no job.
  enqueue: (bookingId: string) => Promise<void> = requeueCreateMeeting,
  capture: CaptureOptions = {},
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
        // The capture rules live in lib/payment-capture.ts, shared with the missed-webhook recovery job.
        await applyCapturedPayment(tx, entity, enqueue, capture);
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
