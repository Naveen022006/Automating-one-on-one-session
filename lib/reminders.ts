import { alertInfluencer } from "@/lib/alerts";
import { prisma } from "@/lib/db";
import { sendMessageForBooking } from "@/lib/messaging";
import { ensureReminder, type EnsureReminderOutcome, type ReminderKind } from "@/lib/queue";

export type ReminderOutcome = "sent" | "already-sent" | "skipped";

/** The 24-hour template says "tomorrow", so it is not sent once less than this is left (a late job after an outage). */
export const REMINDER_24H_MIN_LEAD_MS = 12 * 60 * 60 * 1_000;
/** The repair job only looks at sessions starting within this window (the 24-hour reminder's fire time plus an hour of slack). */
export const REPAIR_WINDOW_MS = 25 * 60 * 60 * 1_000;
/** Most bookings one repair run looks at, so a run is one small query however many sessions are booked. */
export const REPAIR_MAX_BOOKINGS = 500;
/** Consecutive Redis failures after which a repair run stops instead of waiting out a timeout per booking. */
export const REPAIR_MAX_CONSECUTIVE_FAILURES = 3;

/** Reminders only make sense while the booking is still a live, scheduled session. */
const REMINDER_TEMPLATES: Record<ReminderKind, string> = {
  "24h": "reminder-24h",
  "15m": "reminder-15m",
};

/**
 * The minimal booking shape the reminder needs: the run-time status and the CURRENT session start time. The
 * start time is the fire-time backstop for a reschedule (which leaves the booking SCHEDULED): a stale reminder
 * whose job data was enqueued for the OLD time no longer matches session.startTime and is skipped.
 */
export interface ReminderBooking {
  id: string;
  status: string;
  session: { startTime: Date };
}

export interface ReminderDeps {
  /**
   * Reads the latest booking state at run time. Defaults to a fresh prisma query; injectable so the status
   * check can be unit-tested without a database.
   */
  findBooking: (bookingId: string) => Promise<ReminderBooking | null>;
  /** Delivers the reminder message, reusing the FEAT-002 WhatsApp->SMS fallback and the Message row. */
  sendMessage: typeof sendMessageForBooking;
  alert: typeof alertInfluencer;
  /** The clock; injectable so the staleness rules can be tested without waiting. */
  now: () => Date;
}

const defaultDeps: ReminderDeps = {
  findBooking: (bookingId) =>
    prisma.booking.findUnique({
      where: { id: bookingId },
      select: { id: true, status: true, session: { select: { startTime: true } } },
    }),
  sendMessage: sendMessageForBooking,
  alert: alertInfluencer,
  now: () => new Date(),
};

/**
 * Why a reminder must not go out now, or null when it may. Pure. A reminder job that fires late (the worker was
 * down, Redis lost the delay) would otherwise say "starts in 15 minutes" after the session began, or "your session
 * is tomorrow" a few hours before it. The booking status alone cannot tell: nothing marks a past session COMPLETED.
 */
export function staleReminderReason(kind: ReminderKind, startTime: Date, now: Date): string | null {
  const left = startTime.getTime() - now.getTime();
  if (kind === "15m") return left <= 0 ? "the session has already started" : null;
  // The 24h text says "tomorrow". A session that has already started has a negative lead, so it is covered too.
  return left < REMINDER_24H_MIN_LEAD_MS ? "less than 12 h left" : null;
}

/**
 * Sends a session reminder for a booking.
 *
 * Mirrors lib/meeting.ts: the booking status is re-read from the database at run time and never trusted from
 * the job data captured at enqueue time. If the booking is no longer SCHEDULED (cancelled, completed or
 * failed) the reminder is skipped WITHOUT sending.
 *
 * The run-time guard also backstops a RESCHEDULE. A reschedule leaves the booking SCHEDULED, so the status
 * check alone cannot tell a stale reminder apart from a live one. The job therefore carries the start time it
 * was enqueued for (`expectedStartTime`); when that no longer matches the booking's current session start, the
 * job is a leftover for the old time and is skipped. This is what makes "a rescheduled booking sends only the
 * new reminders" a real run-time guarantee rather than one that depends solely on cancelReminders succeeding.
 *
 * A third guard handles a LATE job (the worker was down, Redis lost the delay): nothing marks a past session
 * COMPLETED, so the clock is checked too. The 15m reminder is skipped once the session has started and the 24h
 * reminder once less than 12 h are left (see staleReminderReason). Skipping writes no Message row, so the repair
 * job (reconcileReminders) never mistakes a skipped reminder for a sent one.
 *
 * When the booking is SCHEDULED and the fire time still matches, the reminder is delivered via the messaging
 * layer (WhatsApp with SMS fallback, recorded on a deterministic Message row keyed on (bookingId, template)).
 * A transient delivery failure is rethrown by the messaging layer so BullMQ retries with backoff.
 */
export async function sendReminderForBooking(
  bookingId: string,
  kind: ReminderKind,
  expectedStartTime?: Date,
  overrides: Partial<ReminderDeps> = {},
): Promise<ReminderOutcome> {
  const deps = { ...defaultDeps, ...overrides };

  const booking = await deps.findBooking(bookingId);
  if (!booking) {
    console.warn(`[send-reminder] booking ${bookingId} not found, skipping`);
    return "skipped";
  }
  // Status read at run time: a booking cancelled or completed since the reminder was enqueued is skipped.
  if (booking.status !== "SCHEDULED") {
    console.log(`[send-reminder] booking ${bookingId} is ${booking.status}, not SCHEDULED; skipping ${kind} reminder`);
    return "skipped";
  }
  // Fire-time backstop: a reschedule keeps the booking SCHEDULED but moves session.startTime. A reminder whose
  // job data was enqueued for a different time is a stale leftover for the old slot; skip it so only the
  // reminders enqueued for the current time ever fire.
  if (expectedStartTime && expectedStartTime.getTime() !== booking.session.startTime.getTime()) {
    console.log(
      `[send-reminder] booking ${bookingId} ${kind} reminder was for ${expectedStartTime.toISOString()} but the ` +
        `session is now ${booking.session.startTime.toISOString()}; skipping stale reminder`,
    );
    return "skipped";
  }
  // Clock guard for a late job: the reason goes in the log; no Message row is written.
  const stale = staleReminderReason(kind, booking.session.startTime, deps.now());
  if (stale) {
    console.log(`[send-reminder] booking ${bookingId} ${kind} reminder skipped: ${stale}`);
    return "skipped";
  }

  const template = REMINDER_TEMPLATES[kind];
  const outcome = await deps.sendMessage(bookingId, template);
  // sendMessageForBooking may also skip (opt-out / non-sendable); surface its outcome as-is.
  return outcome;
}

// --- repair after a worker or Redis outage ---

export interface RepairBooking {
  id: string;
  status: string;
  startTime: Date;
}

export interface SentReminder {
  bookingId: string;
  template: string;
}

export interface ReminderRepair {
  bookingId: string;
  kind: ReminderKind;
  startTime: Date;
}

/**
 * Which reminder jobs should exist right now. Pure. A SCHEDULED booking starting within REPAIR_WINDOW_MS wants a
 * "24h" job while at least 12 h are left and a "15m" job until it starts. A (booking, template) that already has a
 * Message row on any channel is never wanted again, so a reminder that went out (or was attempted) is not repeated.
 */
export function planReminderRepairs(
  bookings: readonly RepairBooking[],
  sentTemplates: Iterable<SentReminder>,
  now: Date,
): ReminderRepair[] {
  const done = new Set<string>();
  for (const m of sentTemplates) done.add(`${m.bookingId}:${m.template}`);
  const plan: ReminderRepair[] = [];
  for (const b of bookings) {
    if (b.status !== "SCHEDULED") continue;
    const left = b.startTime.getTime() - now.getTime();
    if (left <= 0 || left > REPAIR_WINDOW_MS) continue;
    for (const kind of ["24h", "15m"] as ReminderKind[]) {
      if (staleReminderReason(kind, b.startTime, now)) continue;
      if (done.has(`${b.id}:${REMINDER_TEMPLATES[kind]}`)) continue;
      plan.push({ bookingId: b.id, kind, startTime: b.startTime });
    }
  }
  return plan;
}

export interface ReconcileDeps {
  /** SCHEDULED, not erased, starting within the repair window, soonest first, at most `limit`. */
  findUpcoming: (now: Date, limit: number) => Promise<RepairBooking[]>;
  /** Message rows (any channel, any status) that exist for these bookings' reminder templates. One query. */
  findSent: (bookingIds: string[]) => Promise<SentReminder[]>;
  ensure: (kind: ReminderKind, bookingId: string, startTime: Date, now: Date) => Promise<EnsureReminderOutcome>;
}

const defaultReconcileDeps: ReconcileDeps = {
  findUpcoming: async (now, limit) => {
    const rows = await prisma.booking.findMany({
      where: {
        status: "SCHEDULED",
        redactedAt: null,
        session: { startTime: { gt: now, lte: new Date(now.getTime() + REPAIR_WINDOW_MS) } },
      },
      orderBy: { session: { startTime: "asc" } },
      take: limit,
      select: { id: true, status: true, session: { select: { startTime: true } } },
    });
    return rows.map((r) => ({ id: r.id, status: r.status, startTime: r.session.startTime }));
  },
  findSent: (bookingIds) =>
    bookingIds.length === 0
      ? Promise.resolve([])
      : prisma.message.findMany({
          where: { bookingId: { in: bookingIds }, template: { in: Object.values(REMINDER_TEMPLATES) } },
          select: { bookingId: true, template: true },
        }),
  ensure: (kind, bookingId, startTime, now) => ensureReminder(kind, bookingId, startTime, now),
};

export interface ReconcileSummary {
  /** Bookings looked at. */
  checked: number;
  /** Reminder jobs that were missing, or queued for an old time, and have been (re)created. */
  repaired: number;
  /** Reminder jobs that could not be checked (Redis error); the next run tries again. */
  failed: number;
}

/**
 * Re-creates the reminder jobs that should exist but do not (Redis lost its data, an enqueue was lost). Idempotent:
 * jobs have deterministic ids, a job that exists for the right time is left alone, and a reminder already recorded in
 * `messages` is not planned. Bounded: one booking query (REPAIR_MAX_BOOKINGS), one message query, no transaction, and it
 * stops after REPAIR_MAX_CONSECUTIVE_FAILURES Redis errors in a row rather than waiting out a timeout per booking.
 * An overdue "15m" reminder is added with no delay; sendReminderForBooking re-checks the clock when it runs.
 */
export async function reconcileReminders(now: Date, overrides: Partial<ReconcileDeps> = {}): Promise<ReconcileSummary> {
  const deps = { ...defaultReconcileDeps, ...overrides };
  const bookings = await deps.findUpcoming(now, REPAIR_MAX_BOOKINGS);
  const sent = await deps.findSent(bookings.map((b) => b.id));
  const plan = planReminderRepairs(bookings, sent, now);

  const summary: ReconcileSummary = { checked: bookings.length, repaired: 0, failed: 0 };
  let consecutive = 0;
  let lastError: unknown;
  for (const step of plan) {
    try {
      const outcome = await deps.ensure(step.kind, step.bookingId, step.startTime, now);
      consecutive = 0;
      if (outcome === "added" || outcome === "replaced") summary.repaired++;
    } catch (e) {
      summary.failed++;
      lastError = e;
      if (++consecutive >= REPAIR_MAX_CONSECUTIVE_FAILURES) break;
    }
  }
  if (summary.repaired > 0) {
    console.log(`[reminder-repair] checked ${summary.checked} booking(s), repaired ${summary.repaired} reminder job(s)`);
  }
  if (consecutive >= REPAIR_MAX_CONSECUTIVE_FAILURES) {
    const reason = lastError instanceof Error ? lastError.message : String(lastError);
    throw new Error(`reminder repair stopped after ${consecutive} failures in a row (${reason}); repaired ${summary.repaired}`);
  }
  if (summary.failed > 0) {
    console.warn(`[reminder-repair] ${summary.failed} reminder job(s) could not be checked; the next run retries`);
  }
  return summary;
}
