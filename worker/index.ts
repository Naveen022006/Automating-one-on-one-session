import "dotenv/config";
import { UnrecoverableError, Worker } from "bullmq";
import { sweepExpiredAuthRows } from "../lib/auth/sweep";
import { redactBearerLinks } from "../lib/message-kinds";
import { reportError } from "../lib/observability";
import { expireStaleHoldsAndNotify } from "../lib/request-messages";
import { sweepExpiredBuckets } from "../lib/rate-limit/sweep";
import { reportMeetingFailure, requeuePendingMeetings } from "../lib/meeting";
import { reportMessageFailure } from "../lib/messaging";
import { MEETING_QUEUE, MESSAGE_QUEUE, REMINDER_QUEUE, redisConnection } from "../lib/queue";
import { startGoogleHealth } from "./google-health";
import { handleCreateMeeting, type CreateMeetingData } from "./jobs/createMeeting";
import { handleSendMessage, type SendMessageData } from "./jobs/sendMessage";
import { handleSendReminder, type SendReminderData } from "./jobs/sendReminder";
import { startMonitoring } from "./monitoring";
import { installProcessGuards } from "./process-guards";
import { startReminderReconcile } from "./reminder-reconcile";
import { startWhatsAppSync } from "./whatsapp-sync";
import { startWhatsAppWebMessaging } from "./whatsapp-web-messaging";
import type { WhatsAppWebManager } from "./whatsapp-web-manager";

// deployment-readiness: validate configuration before doing anything (exits 1 with a clear message in production).
import { initEnvOrExit } from "../lib/env";
initEnvOrExit("worker");

installProcessGuards(); // an unhandled rejection is logged and survived; an uncaught exception is logged and still ends the process

const INTERVAL_MS = 30_000;
/** Housekeeping (expired rate-limit buckets, sessions and single-use tokens) runs every SWEEP_EVERY ticks (~10 min). */
const SWEEP_EVERY = 20;
let ticks = 0;

async function sweep() {
  try {
    const buckets = await sweepExpiredBuckets();
    const auth = await sweepExpiredAuthRows();
    if (buckets + auth > 0) console.log(`[worker] swept ${buckets} rate-limit bucket(s), ${auth} expired auth row(s)`);
  } catch (e) {
    reportError(e, { where: "worker:sweep" });
  }
}

async function tick() {
  try {
    // Expires timed-out holds, and tells the customer of each booking REQUEST that lapsed unanswered (lib/request-messages.ts).
    const r = await expireStaleHoldsAndNotify();
    if (r.expired > 0) console.log(`[worker] expired ${r.expired} stale hold(s)${r.requests > 0 ? `, ${r.requests} of them unanswered request(s) (${r.queued} customer message(s) queued)` : ""}`);
  } catch (e) {
    reportError(e, { where: "worker:expire-holds" });
  }
  if (ticks++ % SWEEP_EVERY === 0) await sweep();
}

console.log("[worker] hold expiry running every", INTERVAL_MS / 1000, "s");
void tick();
const timer = setInterval(tick, INTERVAL_MS);
startGoogleHealth(); // daily check that every ACTIVE Google connection still works (worker/google-health.ts)

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
    // A message may carry a payment or manage link (bearer links): log only its redacted reason, never the error object.
    console.error(`[worker] send-message gave up on booking ${job.data.bookingId} (${job.data.template})`, redactBearerLinks(err.message));
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

// --- payment recovery + health monitoring (worker/monitoring.ts): heartbeat, missed-webhook recovery, health monitor ---
startMonitoring();
// --- end payment recovery + health monitoring ---
startWhatsAppSync(); // template status backup for Meta's webhook (worker/whatsapp-sync.ts)
startReminderReconcile(); // re-creates missing reminder jobs after a Redis/worker outage (worker/reminder-reconcile.ts)
// Optional QR-code WhatsApp mode (worker/whatsapp-web.ts): holds the linked devices' sockets. Off unless WHATSAPP_QR_ENABLED=true; when off
// it only applies the kill switch (deletes stored logins). A failure here must never stop the rest of the worker.
let whatsappWeb: WhatsAppWebManager | null = null;
startWhatsAppWebMessaging()
  .then((m) => (whatsappWeb = m))
  .catch((e) => reportError(e, { where: "worker:whatsapp-web-start" }));

async function shutdown(signal: string) {
  console.log(`[worker] ${signal} received, shutting down`);
  clearInterval(timer);
  // Flush the linked devices' stored logins and close their sockets (a few seconds at most), alongside the queue workers.
  await Promise.all([meetings?.close(), messages?.close(), reminders?.close(), whatsappWeb?.shutdown().catch(() => {})]);
  process.exit(0);
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
