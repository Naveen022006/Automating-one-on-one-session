import { type Job } from "bullmq";
import { sendReminderForBooking, type ReminderOutcome } from "../../lib/reminders";
import type { ReminderKind } from "../../lib/queue";

export interface SendReminderData {
  bookingId: string;
  kind: ReminderKind;
  /**
   * ISO start time this reminder was enqueued for. The handler passes it to sendReminderForBooking as the
   * fire-time backstop: a reschedule moves session.startTime, so a stale reminder whose expectedStartTime no
   * longer matches the booking's current session is skipped. Optional for backward compatibility with any
   * reminder enqueued before this field existed (those simply skip the fire-time check).
   */
  expectedStartTime?: string;
}

/**
 * BullMQ handler for `send-reminder`. The reminder re-reads the booking status at run time, so a cancelled or
 * rescheduled booking is skipped cleanly. Delivery failures (WhatsApp and SMS both down) are transient and are
 * rethrown so they retry with the queue's exponential backoff; after the attempts are exhausted the worker's
 * `failed` listener records the failure and alerts the influencer. Mirrors worker/jobs/sendMessage.ts.
 */
export async function handleSendReminder(job: Job<SendReminderData>): Promise<ReminderOutcome> {
  const expectedStartTime = job.data.expectedStartTime ? new Date(job.data.expectedStartTime) : undefined;
  const outcome = await sendReminderForBooking(job.data.bookingId, job.data.kind, expectedStartTime);
  console.log(`[send-reminder] booking ${job.data.bookingId} (${job.data.kind}): ${outcome}`);
  return outcome;
}
