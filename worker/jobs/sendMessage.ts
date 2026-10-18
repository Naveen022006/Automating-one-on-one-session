import { type Job } from "bullmq";
import { isRequestMessageKind, redactPayLinks } from "../../lib/message-kinds";
import { sendMessageForBooking, type MessageOutcome } from "../../lib/messaging";

export interface SendMessageData {
  bookingId: string;
  template: string;
}

/**
 * BullMQ handler for `send-message`. Honours the per-job `template` so the one queue carries every outbound
 * customer message (booking confirmation, reschedule/cancellation notices). Delivery failures (WhatsApp and
 * SMS both down) are transient, so they are rethrown and retried with the queue's exponential backoff; after
 * the attempts are exhausted the worker's `failed` listener records the failure and alerts the influencer.
 * Mirrors worker/jobs/sendReminder.ts.
 */
export async function handleSendMessage(job: Job<SendMessageData>): Promise<MessageOutcome> {
  let outcome: MessageOutcome;
  try {
    outcome = await sendMessageForBooking(job.data.bookingId, job.data.template);
  } catch (e) {
    // A booking-request message may carry the customer's payment link (a bearer link). BullMQ keeps a failed job's reason in Redis and the
    // health page shows it, so a provider that echoed the message back in its error must not leave the link there.
    if (isRequestMessageKind(job.data.template) && e instanceof Error && redactPayLinks(e.message) !== e.message) {
      throw new Error(redactPayLinks(e.message));
    }
    throw e;
  }
  console.log(`[send-message] booking ${job.data.bookingId} (${job.data.template}): ${outcome}`);
  return outcome;
}
