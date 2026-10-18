import { Queue } from "bullmq";
import { redisConnection } from "@/lib/queue";
import type { TestJob } from "./test-send";

/**
 * The one-job queue between the web app (which cannot send) and the worker (which holds the linked sockets) for the "send me a test
 * message" button. Imported only when a request really needs it (dynamic import in test-send.ts) and by the worker.
 */

export const WHATSAPP_WEB_TEST_QUEUE = "whatsapp-web-test";

let queue: Queue | null = null;

function getQueue(): Queue {
  if (!queue) {
    queue = new Queue(WHATSAPP_WEB_TEST_QUEUE, { connection: redisConnection() });
    queue.on("error", (e) => console.error(`[queue:${WHATSAPP_WEB_TEST_QUEUE}]`, e instanceof Error ? e.message : e));
  }
  return queue;
}

/** Queues a test message. The job disappears quickly: its answer lives in the shared store, not here. */
export async function enqueueTestJob(job: TestJob): Promise<void> {
  await getQueue().add("test-send", job, {
    jobId: `wa-web-test-${job.influencerId}-${job.requestId}`,
    attempts: 1,
    removeOnComplete: { age: 600 },
    removeOnFail: { age: 3_600 },
  });
}
