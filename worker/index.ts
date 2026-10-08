import "dotenv/config";
import { UnrecoverableError, Worker } from "bullmq";
import { expireStaleHolds } from "../lib/holds";
import { reportMeetingFailure, requeuePendingMeetings } from "../lib/meeting";
import { MEETING_QUEUE, redisConnection } from "../lib/queue";
import { handleCreateMeeting, type CreateMeetingData } from "./jobs/createMeeting";

const INTERVAL_MS = 30_000;

async function tick() {
  try {
    const n = await expireStaleHolds();
    if (n > 0) console.log(`[worker] expired ${n} stale hold(s)`);
  } catch (e) {
    console.error("[worker] expire-holds failed", e);
  }
}

console.log("[worker] hold expiry running every", INTERVAL_MS / 1000, "s");
void tick();
const timer = setInterval(tick, INTERVAL_MS);

let meetings: Worker<CreateMeetingData> | undefined;

if (!process.env.REDIS_URL) {
  console.warn("[worker] REDIS_URL is not set: only hold expiry is running, meeting jobs will not be processed");
} else {
  meetings = new Worker<CreateMeetingData>(MEETING_QUEUE, handleCreateMeeting, {
    connection: redisConnection(),
    concurrency: 5,
  });
  meetings.on("error", (e) => console.error("[worker] meetings queue error", e));
  meetings.on("failed", (job, err) => {
    if (!job) return;
    // Blocked/rejected jobs alert from inside the handler. This catches a transient error that outlived every retry.
    const exhausted = job.attemptsMade >= (job.opts.attempts ?? 1);
    if (!exhausted || err instanceof UnrecoverableError) return;
    console.error(`[worker] create-meeting gave up on booking ${job.data.bookingId}`, err);
    void reportMeetingFailure(job.data.bookingId, err.message).catch((e) =>
      console.error("[worker] could not record meeting failure", e),
    );
  });
  console.log(`[worker] processing "${MEETING_QUEUE}" queue`);

  // Recover paid bookings that never got a link (lost enqueue, retries exhausted while Google was down).
  requeuePendingMeetings()
    .then((n) => n > 0 && console.log(`[worker] re-queued ${n} paid booking(s) without a meeting`))
    .catch((e) => console.error("[worker] start-up re-queue failed", e));
}

async function shutdown(signal: string) {
  console.log(`[worker] ${signal} received, shutting down`);
  clearInterval(timer);
  await meetings?.close();
  process.exit(0);
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
