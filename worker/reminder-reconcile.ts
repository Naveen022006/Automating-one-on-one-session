import { reconcileReminders, type RepairCursor } from "../lib/reminders";
import { singleFlight } from "./monitoring";

/**
 * Repairs missing reminder jobs. Delayed reminder jobs live only in Redis, so a Redis that lost its data (or an
 * enqueue that failed during an outage) leaves a paid, upcoming booking with no reminder at all. Every 10 minutes,
 * and once shortly after start-up (a restart after an outage is exactly when it matters), this looks at SCHEDULED
 * bookings starting within the next 25 hours and re-creates the reminder jobs that are missing (lib/reminders.ts
 * reconcileReminders). Idempotent, so running it on several workers is harmless; it never overlaps itself, and an
 * error is reported and retried at the next tick rather than thrown out of a timer.
 */

export const RECONCILE_EVERY_MS = 10 * 60_000;
/** First run shortly after start-up, once the reminders worker is listening and the database pool has settled. */
export const RECONCILE_FIRST_RUN_MS = 60_000;

export interface ReconcileOptions {
  /** One repair pass; injectable for tests. */
  run?: (now: Date, after?: RepairCursor) => Promise<unknown>;
  firstRunMs?: number;
  everyMs?: number;
  /** Where a failed pass is reported (default: reportError through singleFlight). */
  onError?: (e: unknown) => void;
}

/** Starts the repair timers. Returns a function that stops them. */
export function startReminderReconcile(opts: ReconcileOptions = {}): () => void {
  if (!process.env.REDIS_URL) {
    console.warn("[worker] reminder repair is off: REDIS_URL is not set");
    return () => {};
  }
  const pass = opts.run ?? ((now: Date, after?: RepairCursor) => reconcileReminders(now, {}, { after }));
  // A pass that stopped at its cap hands over where it got to; the next pass resumes there, and the one after a
  // complete pass starts from the soonest booking again.
  let resumeAfter: RepairCursor | undefined;
  const run = singleFlight(async () => {
    const result = await pass(new Date(), resumeAfter);
    resumeAfter = (result as { next?: RepairCursor | null } | undefined)?.next ?? undefined;
  }, {
    name: "reminder-reconcile",
    onSkip: () => console.warn("[worker] reminder repair is still running; skipping this tick"),
    onError: opts.onError,
  });
  const first = setTimeout(() => void run(), opts.firstRunMs ?? RECONCILE_FIRST_RUN_MS);
  const every = setInterval(() => void run(), opts.everyMs ?? RECONCILE_EVERY_MS);
  first.unref(); // the BullMQ workers keep the process alive; these must not
  every.unref();
  console.log(`[worker] reminder repair running every ${(opts.everyMs ?? RECONCILE_EVERY_MS) / 60_000} min`);
  return () => {
    clearTimeout(first);
    clearInterval(every);
  };
}
