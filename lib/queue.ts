import { Queue } from "bullmq";
import IORedis from "ioredis";
import { within } from "@/lib/timeout";

export const MEETING_QUEUE = "meetings";
export const MESSAGE_QUEUE = "messages";
export const REMINDER_QUEUE = "reminders";

export const CREATE_MEETING_ATTEMPTS = 5;
export const REMINDER_ATTEMPTS = 5;

/** How long before the session each reminder fires. */
export const REMINDER_OFFSETS_MS: Record<ReminderKind, number> = {
  "24h": 24 * 60 * 60 * 1_000,
  "15m": 15 * 60 * 1_000,
};

export type ReminderKind = "24h" | "15m";

const queues = new Map<string, Queue>();

/**
 * BullMQ needs `maxRetriesPerRequest: null`, so a command issued while Redis is down waits until it comes back. Anything
 * that must not hang (a page, the monitor, a database transaction waiting to queue a job) bounds its wait with `within`
 * from lib/timeout.ts (see getQueueCounts and `applyCapturedPayment`).
 */
export function redisConnection(): IORedis {
  const url = process.env.REDIS_URL;
  if (!url) throw new Error("REDIS_URL is not set");
  return new IORedis(url, { maxRetriesPerRequest: null });
}

function getQueue(name: string): Queue {
  let q = queues.get(name);
  if (!q) {
    q = new Queue(name, { connection: redisConnection() });
    // Without a listener an 'error' event (Redis dropped) is thrown as an uncaught exception.
    q.on("error", (e) => console.error(`[queue:${name}]`, e instanceof Error ? e.message : e));
    queues.set(name, q);
  }
  return q;
}

/** The queues the system health page watches. */
export const QUEUE_NAMES = [MEETING_QUEUE, MESSAGE_QUEUE, REMINDER_QUEUE] as const;

export interface QueueCounts {
  waiting: number;
  active: number;
  failed: number;
  delayed: number;
}

/**
 * Job counts of one queue, over the process-wide cached queue (one Redis connection per queue per process, so
 * calling this from a page or a monitor never opens another). Rejects if Redis does not answer within `timeoutMs`.
 */
export async function getQueueCounts(name: string, timeoutMs = 3_000): Promise<QueueCounts> {
  const counts = await within(getQueue(name).getJobCounts("waiting", "active", "failed", "delayed"), timeoutMs, `queue ${name} counts`);
  return { waiting: counts.waiting ?? 0, active: counts.active ?? 0, failed: counts.failed ?? 0, delayed: counts.delayed ?? 0 };
}

export interface FailedJobInfo {
  queue: string;
  id: string;
  name: string;
  bookingId: string | null;
  failedReason: string;
  attemptsMade: number;
  failedAt: Date | null;
}

/** The most recent failed jobs of a queue (they are kept: `removeOnFail: false`), newest first. */
export async function getFailedJobs(name: string, limit = 10, timeoutMs = 3_000): Promise<FailedJobInfo[]> {
  const jobs = await within(getQueue(name).getFailed(0, Math.max(0, limit - 1)), timeoutMs, `queue ${name} failed jobs`);
  return jobs
    .map((j) => ({
      queue: name,
      id: String(j.id ?? ""),
      name: j.name,
      bookingId: typeof j.data?.bookingId === "string" ? (j.data.bookingId as string) : null,
      failedReason: String(j.failedReason ?? "").slice(0, 300),
      attemptsMade: j.attemptsMade,
      failedAt: j.finishedOn ? new Date(j.finishedOn) : null,
    }))
    .sort((a, b) => (b.failedAt?.getTime() ?? 0) - (a.failedAt?.getTime() ?? 0));
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
export async function enqueueSendMessage(
  bookingId: string,
  template = "booking-confirmation",
  /**
   * Makes the job id unique for a deliberate repeat (a resend, a second reschedule). Without it the default id is
   * deterministic, so a retried create-meeting job can never send the customer two confirmations.
   */
  dedupeSuffix?: string,
): Promise<void> {
  await getQueue(MESSAGE_QUEUE).add(
    "send-message",
    { bookingId, template },
    {
      jobId: `send-message-${template}-${bookingId}${dedupeSuffix ? `-${dedupeSuffix}` : ""}`,
      attempts: 5,
      backoff: { type: "exponential", delay: 5_000 },
      removeOnComplete: { age: 7 * 86_400 },
      removeOnFail: false,
    },
  );
}

/**
 * Deterministic reminder job id. The spec mandates exactly `reminder-24h-<bookingId>` and
 * `reminder-15m-<bookingId>` so a reschedule/cancel can look the jobs up and remove or replace them.
 */
export const reminderJobId = (kind: ReminderKind, bookingId: string) => `reminder-${kind}-${bookingId}`;

/**
 * Schedules the two session reminders (T-24h and T-15m) as delayed jobs with deterministic ids. Each job's
 * `delay` is how long from now until its fire time; a reminder whose fire time is already in the past (e.g. a
 * booking confirmed less than 15 minutes before the session) is skipped rather than fired immediately.
 *
 * Each job carries the start time it was enqueued for (`expectedStartTime`); the reminder handler re-reads the
 * booking at run time and skips a reminder whose expected time no longer matches the booking's current session
 * (a reschedule) or whose booking is no longer SCHEDULED (a cancel), so a stale job that outlived
 * cancelReminders is harmless. Any existing job for a given id is removed before the new one is added, so a
 * reschedule really installs reminders for the new time rather than being swallowed as a duplicate-id no-op.
 */
/**
 * The slice of the BullMQ Queue the reminder helpers use. Declared so a test can pass a fake recorder and
 * assert the job ids/delays without a real Redis connection.
 */
export interface ReminderQueue {
  add: Queue["add"];
  getJob: Queue["getJob"];
}

/** Bound on each Redis call of the repair job, so an unreachable Redis fails a step instead of hanging the worker. */
const ENSURE_REDIS_TIMEOUT_MS = 5_000;

export type EnsureReminderOutcome = "added" | "replaced" | "kept" | "stale";

export async function enqueueReminders(
  bookingId: string,
  startTime: Date,
  queue: ReminderQueue = getQueue(REMINDER_QUEUE),
): Promise<void> {
  const now = Date.now();
  const start = startTime.getTime();
  // The reminder job ids are keyed on (kind, bookingId) only, NOT the time, so a reschedule reuses the same
  // ids. BullMQ ignores an `add` whose job id already exists, so a stale delayed job (still carrying the OLD
  // delay and OLD expectedStartTime) would survive a plain re-enqueue. Remove any existing job first so the
  // new reminder really is installed for the new time. Combined with the expectedStartTime carried in the job
  // data (checked at run time), this makes "a rescheduled booking sends only the new reminders" robust even if
  // a job had already promoted past the delayed state.
  for (const kind of ["24h", "15m"] as ReminderKind[]) {
    const delay = start - REMINDER_OFFSETS_MS[kind] - now;
    const existing = await queue.getJob(reminderJobId(kind, bookingId));
    if (existing) await existing.remove();
    if (delay <= 0) {
      // The fire time has already passed; do not send a stale reminder.
      continue;
    }
    await queue.add(
      "send-reminder",
      // expectedStartTime is the run-time backstop: the handler compares it against the booking's current
      // session.startTime and skips a reminder whose job data no longer matches (a surviving stale job).
      { bookingId, kind, expectedStartTime: startTime.toISOString() },
      {
        jobId: reminderJobId(kind, bookingId),
        delay,
        attempts: REMINDER_ATTEMPTS,
        backoff: { type: "exponential", delay: 5_000 },
        removeOnComplete: { age: 7 * 86_400 },
        removeOnFail: false,
      },
    );
  }
}

/**
 * Makes sure ONE reminder job exists for the given start time, without disturbing a healthy one. Used by the repair
 * job (reconcileReminders); unlike enqueueReminders it never removes a job that is already right, and an overdue
 * reminder is added with no delay rather than skipped (the handler re-checks the clock when it runs).
 *
 * - no job with the deterministic id: add it (`added`);
 * - a job for the same start time, in any state: leave it (`kept`);
 * - a job for ANOTHER start time (a reschedule happened while Redis or the worker was away): remove it and add one
 *   for this time (`replaced`), whether it is delayed, waiting, completed or failed. A completed or failed leftover
 *   only skipped itself on the time mismatch, and the Message rows still stop a delivered reminder from being
 *   repeated. The one exception is an `active` job, which is running right now and is left alone (`kept`);
 * - `stillCurrent` is asked right before anything is removed or added; when it says the booking has moved on (a
 *   reschedule or cancel landed after the repair read it) nothing is touched (`stale`).
 * Every Redis call is bounded with `within`.
 */
export async function ensureReminder(
  kind: ReminderKind,
  bookingId: string,
  startTime: Date,
  now: Date,
  queue: ReminderQueue = getQueue(REMINDER_QUEUE),
  stillCurrent?: () => Promise<boolean>,
): Promise<EnsureReminderOutcome> {
  const jobId = reminderJobId(kind, bookingId);
  const existing = await within(queue.getJob(jobId), ENSURE_REDIS_TIMEOUT_MS, `reminder job ${jobId} lookup`);
  if (existing && existing.data?.expectedStartTime === startTime.toISOString()) return "kept";
  if (existing) {
    const state = await within(existing.getState(), ENSURE_REDIS_TIMEOUT_MS, `reminder job ${jobId} state`);
    if (state === "active") return "kept";
  }
  // Last look at the booking before touching the queue: a reschedule that landed since the repair read it must not
  // make us remove the (correct) new job and add one for the old time.
  if (stillCurrent && !(await stillCurrent())) return "stale";
  let outcome: EnsureReminderOutcome = "added";
  if (existing) {
    try {
      await within(existing.remove(), ENSURE_REDIS_TIMEOUT_MS, `reminder job ${jobId} removal`);
    } catch (e) {
      // Picked up by the worker between the state read and the removal (BullMQ refuses to remove a locked job): it
      // is running, so leave it. Anything else is a real Redis problem.
      if (/lock/i.test(e instanceof Error ? e.message : String(e))) return "kept";
      throw e;
    }
    outcome = "replaced";
  }
  const delay = Math.max(0, startTime.getTime() - REMINDER_OFFSETS_MS[kind] - now.getTime());
  await within(
    queue.add(
      "send-reminder",
      { bookingId, kind, expectedStartTime: startTime.toISOString() },
      {
        jobId,
        delay,
        attempts: REMINDER_ATTEMPTS,
        backoff: { type: "exponential", delay: 5_000 },
        removeOnComplete: { age: 7 * 86_400 },
        removeOnFail: false,
      },
    ),
    ENSURE_REDIS_TIMEOUT_MS,
    `reminder job ${jobId} add`,
  );
  return outcome;
}

/**
 * Drops both reminder jobs for a booking, in whatever state they are in. Called on reschedule (before
 * enqueueing fresh reminders for the new time) and on cancel. Follows the requeueCreateMeeting getJob/remove
 * idiom; a missing job is a no-op.
 */
export async function cancelReminders(
  bookingId: string,
  queue: ReminderQueue = getQueue(REMINDER_QUEUE),
): Promise<void> {
  for (const kind of ["24h", "15m"] as ReminderKind[]) {
    const existing = await queue.getJob(reminderJobId(kind, bookingId));
    if (existing) await existing.remove();
  }
}
