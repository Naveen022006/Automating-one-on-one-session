import { type Job } from "bullmq";
import { sendReminderForBooking, type ReminderOutcome } from "../../lib/reminders";
import type { ReminderKind } from "../../lib/queue";

export interface SendReminderData {
  bookingId: string;
  kind: ReminderKind;
}

/**
 * BullMQ handler for `send-reminder`. The reminder re-reads the booking status at run time, so a cancelled or
 * rescheduled booking is skipped cleanly. Delivery failures (WhatsApp and SMS both down) are transient and are
 * rethrown so they retry with the queue's exponential backoff; after the attempts are exhausted the worker's
 * `failed` listener records the failure and alerts the influencer. Mirrors worker/jobs/sendMessage.ts.
 */
export async function handleSendReminder(job: Job<SendReminderData>): Promise<ReminderOutcome> {
  const outcome = await sendReminderForBooking(job.data.bookingId, job.data.kind);
  console.log(`[send-reminder] booking ${job.data.bookingId} (${job.data.kind}): ${outcome}`);
  return outcome;
}
