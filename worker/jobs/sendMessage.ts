import { type Job } from "bullmq";
import { sendMessageForBooking, type MessageOutcome } from "../../lib/messaging";

export interface SendMessageData {
  bookingId: string;
  template: string;
}

/**
 * BullMQ handler for `send-message`. Delivery failures (WhatsApp and SMS both down) are transient, so they are
 * rethrown and retried with the queue's exponential backoff; after the attempts are exhausted the worker's
 * `failed` listener records the failure and alerts the influencer. Mirrors worker/jobs/createMeeting.ts.
 */
export async function handleSendMessage(job: Job<SendMessageData>): Promise<MessageOutcome> {
  const outcome = await sendMessageForBooking(job.data.bookingId, job.data.template);
  console.log(`[send-message] booking ${job.data.bookingId} (${job.data.template}): ${outcome}`);
  return outcome;
}
