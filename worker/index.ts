import "dotenv/config";
import { UnrecoverableError, Worker } from "bullmq";
import { expireStaleHolds } from "../lib/holds";
import { reportMeetingFailure, requeuePendingMeetings } from "../lib/meeting";
import { reportMessageFailure } from "../lib/messaging";
import { MEETING_QUEUE, MESSAGE_QUEUE, REMINDER_QUEUE, redisConnection } from "../lib/queue";
import { handleCreateMeeting, type CreateMeetingData } from "./jobs/createMeeting";
import { handleSendMessage, type SendMessageData } from "./jobs/sendMessage";
import { handleSendReminder, type SendReminderData } from "./jobs/sendReminder";

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
let messages: Worker<SendMessageData> | undefined;
let reminders: Worker<SendReminderData> | undefined;

if (!process.env.REDIS_URL) {
  console.warn("[worker] REDIS_URL is not set: only hold expiry is running, meeting/message jobs will not be processed");
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

  // The messages worker carries every outbound customer message (booking confirmation, reschedule and
  // cancellation notices), keyed by the per-job template. The booking confirmation is enqueued by the
  // create-meeting job after the Meet link is set, so the link is present when it runs.
  messages = new Worker<SendMessageData>(MESSAGE_QUEUE, handleSendMessage, {
    connection: redisConnection(),
    concurrency: 5,
  });
  messages.on("error", (e) => console.error("[worker] messages queue error", e));
  messages.on("failed", (job, err) => {
    if (!job) return;
    // Only act once the retries are exhausted and the error was transient (not wrapped UnrecoverableError).
    const exhausted = job.attemptsMade >= (job.opts.attempts ?? 1);
    if (!exhausted || err instanceof UnrecoverableError) return;
    console.error(`[worker] send-message gave up on booking ${job.data.bookingId} (${job.data.template})`, err);
    void reportMessageFailure(job.data.bookingId, job.data.template, err.message).catch((e) =>
      console.error("[worker] could not record message failure", e),
    );
  });
  console.log(`[worker] processing "${MESSAGE_QUEUE}" queue`);

  reminders = new Worker<SendReminderData>(REMINDER_QUEUE, handleSendReminder, {
    connection: redisConnection(),
    concurrency: 5,
  });
  reminders.on("error", (e) => console.error("[worker] reminders queue error", e));
  reminders.on("failed", (job, err) => {
    if (!job) return;
    // Only act once the retries are exhausted and the error was transient (not wrapped UnrecoverableError).
    const exhausted = job.attemptsMade >= (job.opts.attempts ?? 1);
    if (!exhausted || err instanceof UnrecoverableError) return;
    // The reminder is delivered through the messaging layer, so the final failure is a message delivery
    // failure: mark the Message row FAILED, flag booking.lastError for the dashboard, and alert the influencer.
    const template = `reminder-${job.data.kind}`;
    console.error(`[worker] send-reminder gave up on booking ${job.data.bookingId} (${template})`, err);
    void reportMessageFailure(job.data.bookingId, template, err.message).catch((e) =>
      console.error("[worker] could not record reminder failure", e),
    );
  });
  console.log(`[worker] processing "${REMINDER_QUEUE}" queue`);

  // Recover paid bookings that never got a link (lost enqueue, retries exhausted while Google was down).
  requeuePendingMeetings()
    .then((n) => n > 0 && console.log(`[worker] re-queued ${n} paid booking(s) without a meeting`))
    .catch((e) => console.error("[worker] start-up re-queue failed", e));
}

async function shutdown(signal: string) {
  console.log(`[worker] ${signal} received, shutting down`);
  clearInterval(timer);
  await Promise.all([meetings?.close(), messages?.close(), reminders?.close()]);
  process.exit(0);
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
