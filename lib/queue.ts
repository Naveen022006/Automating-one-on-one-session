import { Queue } from "bullmq";
import IORedis from "ioredis";

export const MEETING_QUEUE = "meetings";
export const MESSAGE_QUEUE = "messages";
export const REMINDER_QUEUE = "reminders";

export const CREATE_MEETING_ATTEMPTS = 5;
export const REMINDER_ATTEMPTS = 5;

/** How long before the session each reminder fires. */
const REMINDER_OFFSETS_MS: Record<ReminderKind, number> = {
  "24h": 24 * 60 * 60 * 1_000,
  "15m": 15 * 60 * 1_000,
};

export type ReminderKind = "24h" | "15m";

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
