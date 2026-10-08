import { UnrecoverableError, type Job } from "bullmq";
import { createMeetingForBooking, MeetingBlockedError, MeetingRejectedError, type MeetingOutcome } from "../../lib/meeting";

export interface CreateMeetingData {
  bookingId: string;
}

/**
 * BullMQ handler for `create-meeting`. Errors that retrying cannot fix are wrapped in UnrecoverableError so the
 * job stops at once instead of burning its attempts; everything else (Google 5xx, rate limits, Meet link still
 * pending, network) is rethrown and retried with the queue's exponential backoff.
 */
export async function handleCreateMeeting(job: Job<CreateMeetingData>): Promise<MeetingOutcome> {
  try {
    const outcome = await createMeetingForBooking(job.data.bookingId);
    console.log(`[create-meeting] booking ${job.data.bookingId}: ${outcome}`);
    return outcome;
  } catch (e) {
    if (e instanceof MeetingBlockedError || e instanceof MeetingRejectedError) {
      console.warn(`[create-meeting] booking ${job.data.bookingId}: ${e.message}`);
      throw new UnrecoverableError(e.message);
    }
    throw e;
  }
}
