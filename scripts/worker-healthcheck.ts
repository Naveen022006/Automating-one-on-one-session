import { Queue } from "bullmq";
import { MEETING_QUEUE, MESSAGE_QUEUE, REMINDER_QUEUE, redisConnection } from "../lib/queue";

/**
 * Container health check for the worker (it has no HTTP port). Exits 0 when Redis answers and a BullMQ worker is
 * attached to each of the three queues, exits 1 otherwise. Used by HEALTHCHECK in Dockerfile.worker and by
 * docker-compose.yml. Prints one short line and never a connection string.
 *
 * Limits, so nobody over-trusts it: it asks Redis (CLIENT LIST) which workers are connected, so with several worker
 * replicas it cannot tell WHICH replica is missing (it passes while at least one is attached), and it needs a Redis
 * that permits CLIENT LIST (self-hosted Redis does; some managed/serverless Redis offerings do not).
 */

const TIMEOUT_MS = 8_000;

async function main(): Promise<boolean> {
  const connection = redisConnection();
  connection.on("error", () => {});
  const queues = [MEETING_QUEUE, MESSAGE_QUEUE, REMINDER_QUEUE].map((name) => new Queue(name, { connection }));
  try {
    for (const queue of queues) {
      const workers = await queue.getWorkers();
      if (workers.length === 0) {
        console.error(`unhealthy: no worker attached to the "${queue.name}" queue`);
        return false;
      }
    }
    return true;
  } finally {
    await Promise.allSettled(queues.map((q) => q.close()));
    connection.disconnect();
  }
}

const timer = setTimeout(() => {
  console.error("unhealthy: timed out talking to Redis");
  process.exit(1);
}, TIMEOUT_MS);

main()
  .then((healthy) => {
    clearTimeout(timer);
    process.exit(healthy ? 0 : 1);
  })
  .catch(() => {
    console.error("unhealthy: Redis is not reachable");
    process.exit(1);
  });
