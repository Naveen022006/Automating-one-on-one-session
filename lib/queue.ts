import { Queue } from "bullmq";
import IORedis from "ioredis";

export const MEETING_QUEUE = "meetings";

let queue: Queue | undefined;

function getQueue(): Queue {
  if (!queue) {
    const url = process.env.REDIS_URL;
    if (!url) throw new Error("REDIS_URL is not set");
    queue = new Queue(MEETING_QUEUE, { connection: new IORedis(url, { maxRetriesPerRequest: null }) });
  }
  return queue;
}

/**
 * Enqueues the create-meeting job for a paid booking. The job id is deterministic, so enqueueing the
 * same booking twice never produces a second job.
 */
export async function enqueueCreateMeeting(bookingId: string): Promise<void> {
  await getQueue().add(
    "create-meeting",
    { bookingId },
    {
      jobId: `create-meeting-${bookingId}`,
      attempts: 5,
      backoff: { type: "exponential", delay: 5_000 },
      removeOnComplete: { age: 7 * 86_400 },
      removeOnFail: false,
    },
  );
}
