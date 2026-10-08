import { Queue } from "bullmq";
import IORedis from "ioredis";

export const MEETING_QUEUE = "meetings";
export const MESSAGE_QUEUE = "messages";

export const CREATE_MEETING_ATTEMPTS = 5;

const queues = new Map<string, Queue>();

export function redisConnection(): IORedis {
  const url = process.env.REDIS_URL;
  if (!url) throw new Error("REDIS_URL is not set");
  return new IORedis(url, { maxRetriesPerRequest: null });
}

function getQueue(name: string): Queue {
  let q = queues.get(name);
  if (!q) {
    q = new Queue(name, { connection: redisConnection() });
    queues.set(name, q);
  }
  return q;
}

export const createMeetingJobId = (bookingId: string) => `create-meeting-${bookingId}`;

/**
 * Enqueues the create-meeting job for a paid booking. The job id is deterministic, so enqueueing the
 * same booking twice never produces a second job.
 */
export async function enqueueCreateMeeting(bookingId: string): Promise<void> {
  await getQueue(MEETING_QUEUE).add(
    "create-meeting",
    { bookingId },
    {
      jobId: createMeetingJobId(bookingId),
      attempts: CREATE_MEETING_ATTEMPTS,
      backoff: { type: "exponential", delay: 5_000 },
      removeOnComplete: { age: 7 * 86_400 },
      removeOnFail: false,
    },
  );
}

/**
 * Runs create-meeting again for a booking whose earlier job already finished (failed or completed).
 * Plain `enqueueCreateMeeting` would be a silent no-op there: BullMQ ignores an `add` whose job id still
 * exists, and failed jobs are kept (`removeOnFail: false`). Jobs that are waiting/active/delayed are left alone.
 */
export async function requeueCreateMeeting(bookingId: string): Promise<void> {
  const existing = await getQueue(MEETING_QUEUE).getJob(createMeetingJobId(bookingId));
  if (existing) {
    const state = await existing.getState();
    if (state !== "failed" && state !== "completed") return;
    await existing.remove();
  }
  await enqueueCreateMeeting(bookingId);
}

/**
 * Asks the messaging worker (Phase 4) to send the booking confirmation with the Meet link. The id is
 * deterministic so a retried create-meeting job cannot send the customer two confirmations.
 */
export async function enqueueSendMessage(bookingId: string, template = "booking-confirmation"): Promise<void> {
  await getQueue(MESSAGE_QUEUE).add(
    "send-message",
    { bookingId, template },
    {
      jobId: `send-message-${template}-${bookingId}`,
      attempts: 5,
      backoff: { type: "exponential", delay: 5_000 },
      removeOnComplete: { age: 7 * 86_400 },
      removeOnFail: false,
    },
  );
}
