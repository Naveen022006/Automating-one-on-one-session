import type { Job } from "bullmq";
import { sendBookingMessage } from "../../lib/messaging";

/**
 * BullMQ processor for the send-message queue. Delegates to lib/messaging.sendBookingMessage, which
 * tries WhatsApp first and falls back to SMS. The job is enqueued by the create-meeting job after the
 * Meet link is set; a still-missing link raises a retryable error so BullMQ retries the job later.
 */
export async function processSendMessage(job: Job<{ bookingId: string; template?: string }>): Promise<void> {
  const { bookingId } = job.data;
  const result = await sendBookingMessage(bookingId);
  if (result.skipped) {
    console.log(`[worker] send-message ${bookingId}: skipped (not opted in)`);
  } else {
    console.log(`[worker] send-message ${bookingId}: sent via ${result.channel}`);
  }
}
