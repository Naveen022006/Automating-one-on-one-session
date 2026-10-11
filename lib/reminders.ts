import type { Prisma } from "@/generated/prisma/client";
import { alertInfluencer } from "@/lib/alerts";
import { prisma } from "@/lib/db";
import { RESCHEDULE_TEMPLATE } from "@/lib/message-templates";
import { sendMessageForBooking } from "@/lib/messaging";
import { REMINDER_OFFSETS_MS, ensureReminder, type EnsureReminderOutcome, type ReminderKind } from "@/lib/queue";

export type ReminderOutcome = "sent" | "already-sent" | "skipped";

/** The 24-hour template says "tomorrow", so it is not sent once less than this is left (a late job after an outage). */
export const REMINDER_24H_MIN_LEAD_MS = 12 * 60 * 60 * 1_000;
/** The repair job only looks at sessions starting within this window (the 24-hour reminder's fire time plus an hour of slack). */
export const REPAIR_WINDOW_MS = 25 * 60 * 60 * 1_000;
/** Bookings read per query (keyset pages), so no single query is large however many seats a group session holds. */
export const REPAIR_BATCH_SIZE = 250;
/** Most bookings one repair run looks at; a run that hits it hands its position to the next run. */
export const REPAIR_MAX_BOOKINGS = 2_000;
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
  /**
   * When this booking's reminders were last scheduled: its creation, or the last reschedule if later. enqueueReminders
   * deliberately skips a reminder whose fire time had already passed at that moment (a booking made 20 h before the
   * start never gets a "tomorrow" reminder), so a missing job for such a reminder is not a lost one.
   */
  armedAt: Date;
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

/** Keyset position in the repair scan: the soonest session first, then the booking id. */
export interface RepairCursor {
  startTime: Date;
  id: string;
}

/**
 * Which reminder jobs should exist right now. Pure. A SCHEDULED booking starting within REPAIR_WINDOW_MS wants a
 * "24h" job while at least 12 h are left and a "15m" job until it starts, except a reminder whose fire time (start minus
 * its offset) is earlier than `armedAt`: that one was never scheduled on purpose. A (booking, template) that already has a
 * delivered Message row (see findSent) is never wanted again, so a reminder that went out is not repeated.
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
      if (b.startTime.getTime() - REMINDER_OFFSETS_MS[kind] < b.armedAt.getTime()) continue;
      if (done.has(`${b.id}:${REMINDER_TEMPLATES[kind]}`)) continue;
      plan.push({ bookingId: b.id, kind, startTime: b.startTime });
    }
  }
  return plan;
}

export interface UpcomingQuery {
  now: Date;
  limit: number;
  /** Continue after this position (rows are ordered by session start, then id). */
  after?: RepairCursor;
  /** Restrict the scan to these bookings. Used by tests so they do not depend on what else is in the database. */
  bookingIds?: string[];
}

export interface ReconcileDeps {
  /** SCHEDULED, not erased, starting within the repair window, soonest first, at most `limit`. */
  findUpcoming: (query: UpcomingQuery) => Promise<RepairBooking[]>;
  /** Delivered reminder Message rows (any channel) for these bookings. One query per batch. */
  findSent: (bookingIds: string[]) => Promise<SentReminder[]>;
  /** The booking's CURRENT session start, or null when it is no longer SCHEDULED. Re-read right before a job is touched. */
  readStart: (bookingId: string) => Promise<Date | null>;
  ensure: (
    kind: ReminderKind,
    bookingId: string,
    startTime: Date,
    now: Date,
    stillCurrent: () => Promise<boolean>,
  ) => Promise<EnsureReminderOutcome>;
}

/** Message statuses that mean the customer was sent the message (the same set sendMessageForBooking dedupes on). */
const DELIVERED_STATUSES = ["SENT", "DELIVERED", "READ"] as const;

const defaultReconcileDeps: ReconcileDeps = {
  findUpcoming: async ({ now, limit, after, bookingIds }) => {
    const delivered = (template: string): Prisma.BookingWhereInput => ({
      messages: { some: { template, status: { in: [...DELIVERED_STATUSES] } } },
    });
    const where: Prisma.BookingWhereInput = {
      status: "SCHEDULED",
      redactedAt: null,
      session: { startTime: { gt: now, lte: new Date(now.getTime() + REPAIR_WINDOW_MS) } },
      // A booking whose two reminders both went out has nothing to repair.
      NOT: { AND: [delivered(REMINDER_TEMPLATES["24h"]), delivered(REMINDER_TEMPLATES["15m"])] },
      ...(bookingIds ? { id: { in: bookingIds } } : {}),
      ...(after
        ? {
            AND: [
              {
                OR: [
                  { session: { startTime: { gt: after.startTime } } },
                  { session: { startTime: after.startTime }, id: { gt: after.id } },
                ],
              },
            ],
          }
        : {}),
    };
    const rows = await prisma.booking.findMany({
      where,
      orderBy: [{ session: { startTime: "asc" } }, { id: "asc" }],
      take: limit,
      select: {
        id: true,
        status: true,
        createdAt: true,
        session: { select: { startTime: true } },
        // A reschedule re-arms the reminders for the new time; its notice row is the only trace of when that happened.
        messages: { where: { template: RESCHEDULE_TEMPLATE }, select: { updatedAt: true } },
      },
    });
    return rows.map((r) => ({
      id: r.id,
      status: r.status,
      startTime: r.session.startTime,
      armedAt: new Date(Math.max(r.createdAt.getTime(), ...r.messages.map((m) => m.updatedAt.getTime()))),
    }));
  },
  findSent: (bookingIds) =>
    bookingIds.length === 0
      ? Promise.resolve([])
      : prisma.message.findMany({
          where: {
            bookingId: { in: bookingIds },
            template: { in: Object.values(REMINDER_TEMPLATES) },
            status: { in: [...DELIVERED_STATUSES] },
          },
          select: { bookingId: true, template: true },
        }),
  readStart: async (bookingId) => {
    const row = await prisma.booking.findUnique({
      where: { id: bookingId },
      select: { status: true, session: { select: { startTime: true } } },
    });
    return row && row.status === "SCHEDULED" ? row.session.startTime : null;
  },
  ensure: (kind, bookingId, startTime, now, stillCurrent) => ensureReminder(kind, bookingId, startTime, now, undefined, stillCurrent),
};

export interface ReconcileOptions {
  /** Bookings read per query (default REPAIR_BATCH_SIZE). */
  batchSize?: number;
  /** Bookings looked at per run (default REPAIR_MAX_BOOKINGS). */
  maxBookings?: number;
  /** Resume after this position (the `next` of a run that hit its cap). */
  after?: RepairCursor;
  /** Test scope: only these bookings. */
  bookingIds?: string[];
}

export interface ReconcileSummary {
  /** Bookings looked at. */
  checked: number;
  /** Reminder jobs that were missing, or queued for an old time, and have been (re)created. */
  repaired: number;
  /** Reminder jobs that could not be checked (Redis error); the next run tries again. */
  failed: number;
  /** Where to resume when the run stopped at its cap with bookings left, otherwise null. */
  next: RepairCursor | null;
}

/**
 * Re-creates the reminder jobs that should exist but do not (Redis lost its data, an enqueue was lost). Idempotent:
 * jobs have deterministic ids, a job that exists for the right time is left alone, and a reminder already delivered
 * is not planned. Bounded: the window is read in keyset batches (session start, then id) of REPAIR_BATCH_SIZE up to
 * REPAIR_MAX_BOOKINGS per run, one message query per batch, no transaction. When the cap is hit the summary's `next`
 * says where the next run resumes. It stops after REPAIR_MAX_CONSECUTIVE_FAILURES Redis errors in a row rather than
 * waiting out a timeout per booking. An overdue "15m" reminder is added with no delay; sendReminderForBooking
 * re-checks the clock when it runs. The booking is re-read right before a job is touched, so a reschedule or cancel
 * that lands during the run is not undone.
 */
export async function reconcileReminders(
  now: Date,
  overrides: Partial<ReconcileDeps> = {},
  options: ReconcileOptions = {},
): Promise<ReconcileSummary> {
  const deps = { ...defaultReconcileDeps, ...overrides };
  const batchSize = options.batchSize ?? REPAIR_BATCH_SIZE;
  const maxBookings = options.maxBookings ?? REPAIR_MAX_BOOKINGS;

  const summary: ReconcileSummary = { checked: 0, repaired: 0, failed: 0, next: null };
  let consecutive = 0;
  let lastError: unknown;
  let after = options.after;
  scan: while (summary.checked < maxBookings) {
    const limit = Math.min(batchSize, maxBookings - summary.checked);
    const bookings = await deps.findUpcoming({ now, limit, after, bookingIds: options.bookingIds });
    if (bookings.length === 0) break;
    summary.checked += bookings.length;
    const last = bookings[bookings.length - 1];
    after = { startTime: last.startTime, id: last.id };

    const sent = await deps.findSent(bookings.map((b) => b.id));
    for (const step of planReminderRepairs(bookings, sent, now)) {
      try {
        const stillCurrent = async () => {
          const current = await deps.readStart(step.bookingId);
          return current !== null && current.getTime() === step.startTime.getTime();
        };
        const outcome = await deps.ensure(step.kind, step.bookingId, step.startTime, now, stillCurrent);
        consecutive = 0;
        if (outcome === "added" || outcome === "replaced") summary.repaired++;
      } catch (e) {
        summary.failed++;
        lastError = e;
        if (++consecutive >= REPAIR_MAX_CONSECUTIVE_FAILURES) break scan;
      }
    }
    if (bookings.length < limit) break; // the window is exhausted
    if (summary.checked >= maxBookings) summary.next = after;
  }

  if (summary.repaired > 0) {
    console.log(`[reminder-repair] checked ${summary.checked} booking(s), repaired ${summary.repaired} reminder job(s)`);
  }
  if (summary.next) {
    console.warn(`[reminder-repair] stopped at the cap of ${maxBookings} booking(s); the next run resumes after ${summary.next.startTime.toISOString()}`);
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
