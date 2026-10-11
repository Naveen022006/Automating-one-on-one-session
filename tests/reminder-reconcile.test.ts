import "dotenv/config";
import assert from "node:assert/strict";
import { after, before, mock, test } from "node:test";
import { prisma } from "../lib/db";
import { ensureReminder, reminderJobId, type ReminderQueue } from "../lib/queue";
import {
  REPAIR_BATCH_SIZE,
  REPAIR_MAX_BOOKINGS,
  planReminderRepairs,
  reconcileReminders,
  type ReconcileDeps,
  type ReconcileOptions,
  type RepairBooking,
  type UpcomingQuery,
} from "../lib/reminders";
import { startReminderReconcile } from "../worker/reminder-reconcile";

// The queue, the clock and the worker timers are all injected: no Redis is ever contacted. Only the last group of
// tests uses the database (skipped without DATABASE_URL) and it creates and deletes its own timestamped rows.
const skip = process.env.DATABASE_URL ? false : "DATABASE_URL not set";

const HOUR = 60 * 60 * 1_000;
const MIN = 60 * 1_000;
const NOW = new Date("2026-03-10T08:00:00.000Z");
const at = (msFromNow: number) => new Date(NOW.getTime() + msFromNow);

type FakeJob = { id: string; data: { expectedStartTime?: string }; opts: Record<string, unknown>; state: string };

/** A stateful fake of the reminders queue: add() stores the job, getJob() serves it with getState() and remove(). */
function statefulQueue(seed: Array<{ id: string; expectedStartTime?: string; state: string }> = []) {
  const jobs = new Map<string, FakeJob>();
  for (const s of seed) jobs.set(s.id, { id: s.id, data: { expectedStartTime: s.expectedStartTime }, opts: {}, state: s.state });
  const added: FakeJob[] = [];
  const removed: string[] = [];
  const queue = {
    add: async (_name: string, data: { expectedStartTime: string }, opts: { jobId: string; delay: number }) => {
      if (jobs.has(opts.jobId)) return jobs.get(opts.jobId) as never; // BullMQ ignores a duplicate id
      const job: FakeJob = { id: opts.jobId, data, opts, state: opts.delay > 0 ? "delayed" : "waiting" };
      jobs.set(opts.jobId, job);
      added.push(job);
      return job as never;
    },
    getJob: async (id: string) => {
      const job = jobs.get(id);
      if (!job) return undefined as never;
      return {
        id,
        data: job.data,
        getState: async () => job.state,
        remove: async () => {
          jobs.delete(id);
          removed.push(id);
        },
      } as never;
    },
  } as unknown as ReminderQueue;
  return { queue, jobs, added, removed };
}

/** A booking row as the repair scan sees it. `armedAgoMs` is how long ago its reminders were scheduled (default: long ago). */
const booking = (id: string, msFromNow: number, status = "SCHEDULED", armedAgoMs = 1_000 * HOUR): RepairBooking => ({
  id,
  status,
  startTime: at(msFromNow),
  armedAt: at(-armedAgoMs),
});

// --- planReminderRepairs (pure) ---

test("planReminderRepairs: window edges and the 12 h rule for the 24h reminder", () => {
  const plan = planReminderRepairs(
    [
      booking("far", 25 * HOUR + 1), // outside the 25 h window
      booking("edge25", 25 * HOUR), // inside: both reminders wanted
      booking("edge12", 12 * HOUR), // 24h still wanted at exactly 12 h left
      booking("edge12m", 12 * HOUR - 1), // 24h no longer wanted, 15m is
      booking("soon", 5 * MIN),
      booking("starting", 0), // starts now: nothing
      booking("past", -1 * HOUR), // already started: nothing
    ],
    [],
    NOW,
  );
  const summary = plan.map((p) => `${p.bookingId}:${p.kind}`);
  assert.deepEqual(summary, ["edge25:24h", "edge25:15m", "edge12:24h", "edge12:15m", "edge12m:15m", "soon:15m"]);
  assert.equal(plan[0].startTime.getTime(), at(25 * HOUR).getTime());
});

test("planReminderRepairs: a delivered Message row removes that template only", () => {
  const plan = planReminderRepairs(
    [booking("a", 20 * HOUR), booking("b", 20 * HOUR), booking("c", 20 * HOUR)],
    [
      { bookingId: "a", template: "reminder-24h" }, // 24h done on a: only 15m left
      { bookingId: "b", template: "reminder-24h" },
      { bookingId: "b", template: "reminder-15m" }, // both done on b: nothing
      { bookingId: "c", template: "booking-confirmation" }, // unrelated template: ignored
    ],
    NOW,
  );
  assert.deepEqual(
    plan.map((p) => `${p.bookingId}:${p.kind}`),
    ["a:15m", "c:24h", "c:15m"],
  );
});

test("planReminderRepairs: only SCHEDULED bookings are planned", () => {
  const plan = planReminderRepairs(
    ["CANCELLED", "EXPIRED", "FAILED", "HELD", "PENDING_PAYMENT", "PAID", "COMPLETED"].map((s, i) => booking(`s${i}`, 3 * HOUR, s)),
    [],
    NOW,
  );
  assert.deepEqual(plan, []);
});

test("planReminderRepairs: a 24h reminder whose fire time was already past when the booking was armed is not 'lost' (E1)", () => {
  // Start in 20 h, so the 24h fire time was 4 h ago.
  const kinds = (armedAgoMs: number) =>
    planReminderRepairs([booking("x", 20 * HOUR, "SCHEDULED", armedAgoMs)], [], NOW).map((p) => p.kind);
  assert.deepEqual(kinds(0), ["15m"]); // booked just now, 20 h out: enqueueReminders skipped the 24h on purpose
  assert.deepEqual(kinds(3 * HOUR), ["15m"]); // armed 3 h ago: the fire time (4 h ago) was before that
  assert.deepEqual(kinds(4 * HOUR + 1), ["24h", "15m"]); // armed a moment before the fire time: the 24h job should exist
  assert.deepEqual(kinds(4 * HOUR), ["24h", "15m"]); // armed exactly at the fire time: not "earlier", still wanted
  assert.deepEqual(kinds(4 * HOUR - 1), ["15m"]); // armed 1 ms after the fire time: skipped
  assert.deepEqual(kinds(5 * HOUR), ["24h", "15m"]);
});

test("planReminderRepairs: a 15m reminder whose fire time was already past when the booking was armed is not 'lost' (E1)", () => {
  // Start in 10 min, so the 15m fire time was 5 min ago.
  const kinds = (armedAgoMs: number) =>
    planReminderRepairs([booking("y", 10 * MIN, "SCHEDULED", armedAgoMs)], [], NOW).map((p) => p.kind);
  assert.deepEqual(kinds(0), []); // confirmed 10 min before the start: no "starts in 15 minutes" afterwards
  assert.deepEqual(kinds(4 * MIN), []);
  assert.deepEqual(kinds(5 * MIN), ["15m"]); // armed exactly at the fire time
  assert.deepEqual(kinds(6 * MIN), ["15m"]);
  assert.deepEqual(kinds(2 * HOUR), ["15m"]); // the job was lost in an outage: wanted, and added overdue
});

// --- ensureReminder (fake queue) ---

test("ensureReminder: no job -> adds with the deterministic id, the same options as enqueueReminders and the real delay", async () => {
  const { queue, added } = statefulQueue();
  const start = at(48 * HOUR);
  assert.equal(await ensureReminder("24h", "bk1", start, NOW, queue), "added");
  assert.equal(added.length, 1);
  const job = added[0];
  assert.equal(job.id, "reminder-24h-bk1");
  assert.equal(job.opts.delay, 24 * HOUR);
  assert.equal(job.opts.attempts, 5);
  assert.deepEqual(job.opts.backoff, { type: "exponential", delay: 5_000 });
  assert.deepEqual(job.opts.removeOnComplete, { age: 7 * 86_400 });
  assert.equal(job.opts.removeOnFail, false);
  assert.deepEqual(job.data, { bookingId: "bk1", kind: "24h", expectedStartTime: start.toISOString() });
});

test("ensureReminder: an overdue 15m reminder is added with delay 0", async () => {
  const { queue, added } = statefulQueue();
  assert.equal(await ensureReminder("15m", "bk2", at(5 * MIN), NOW, queue), "added");
  assert.equal(added[0].opts.delay, 0);
});

test("ensureReminder: a job for the same start time is left alone in every state", async () => {
  const start = at(3 * HOUR);
  for (const state of ["delayed", "waiting", "active", "completed", "failed"]) {
    const { queue, added, removed } = statefulQueue([{ id: reminderJobId("15m", "bk3"), expectedStartTime: start.toISOString(), state }]);
    assert.equal(await ensureReminder("15m", "bk3", start, NOW, queue), "kept", state);
    assert.deepEqual([added.length, removed.length], [0, 0], state);
  }
});

test("ensureReminder: a job for another time is replaced in every state except active (E2)", async () => {
  const start = at(3 * HOUR);
  for (const state of ["delayed", "waiting", "completed", "failed"]) {
    const { queue, added, removed, jobs } = statefulQueue([{ id: "reminder-15m-bk4", expectedStartTime: at(9 * HOUR).toISOString(), state }]);
    assert.equal(await ensureReminder("15m", "bk4", start, NOW, queue), "replaced", state);
    assert.deepEqual(removed, ["reminder-15m-bk4"], state);
    assert.equal(added.length, 1, state);
    assert.equal(jobs.get("reminder-15m-bk4")!.data.expectedStartTime, start.toISOString(), state);
  }
});

test("ensureReminder: a job for another time that is running right now is never touched", async () => {
  const { queue, added, removed } = statefulQueue([{ id: "reminder-15m-bk5", expectedStartTime: at(9 * HOUR).toISOString(), state: "active" }]);
  assert.equal(await ensureReminder("15m", "bk5", at(3 * HOUR), NOW, queue), "kept");
  assert.deepEqual([added.length, removed.length], [0, 0]);
});

test("ensureReminder: a job picked up while it was being replaced (locked) is left alone", async () => {
  const { queue } = statefulQueue();
  const locked = {
    add: queue.add,
    getJob: async () =>
      ({
        data: { expectedStartTime: at(9 * HOUR).toISOString() },
        getState: async () => "delayed",
        remove: async () => {
          throw new Error("Job reminder-15m-bk6 could not be removed because it is locked by another worker");
        },
      }) as never,
  } as unknown as ReminderQueue;
  assert.equal(await ensureReminder("15m", "bk6", at(3 * HOUR), NOW, locked), "kept");
});

test("ensureReminder: a Redis call that never answers fails the step instead of hanging", async () => {
  const hung = {
    add: async () => new Promise(() => {}),
    getJob: async () => new Promise(() => {}),
  } as unknown as ReminderQueue;
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const p = assert.rejects(ensureReminder("15m", "bk7", at(3 * HOUR), NOW, hung), /timed out/);
    mock.timers.tick(5_000);
    await p;
  } finally {
    mock.timers.reset();
  }
});

test("ensureReminder: the booking is re-checked right before the queue is touched; if it moved on nothing happens (E3)", async () => {
  const start = at(3 * HOUR);
  // The correct (new) job exists for a different time than the one the repair read: it must not be removed.
  const seeded = [{ id: "reminder-15m-bk8", expectedStartTime: at(5 * HOUR).toISOString(), state: "delayed" }];
  const stale = statefulQueue(seeded);
  assert.equal(await ensureReminder("15m", "bk8", start, NOW, stale.queue, async () => false), "stale");
  assert.deepEqual([stale.added.length, stale.removed.length], [0, 0]);
  // And with no job at all, nothing is added for the old time.
  const none = statefulQueue();
  assert.equal(await ensureReminder("15m", "bk8", start, NOW, none.queue, async () => false), "stale");
  assert.equal(none.added.length, 0);
  // When the booking is still where it was read, the same call goes ahead.
  const fine = statefulQueue(seeded);
  assert.equal(await ensureReminder("15m", "bk8", start, NOW, fine.queue, async () => true), "replaced");
  // A job that is already right is left without even asking.
  let asked = 0;
  const right = statefulQueue([{ id: "reminder-15m-bk8", expectedStartTime: start.toISOString(), state: "delayed" }]);
  assert.equal(await ensureReminder("15m", "bk8", start, NOW, right.queue, async () => (asked++, true)), "kept");
  assert.equal(asked, 0);
});

// --- reconcileReminders (injected rows and queue) ---

interface FakeWorld {
  bookings: RepairBooking[];
  sent?: Array<{ bookingId: string; template: string }>;
  /** What readStart answers per booking id (default: the start the scan saw). */
  currentStart?: Record<string, Date | null>;
}

function reconcileDeps(world: FakeWorld, queue: ReminderQueue) {
  const calls = { findUpcoming: [] as UpcomingQuery[], findSent: [] as string[][] };
  const sorted = [...world.bookings].sort((a, b) => a.startTime.getTime() - b.startTime.getTime() || a.id.localeCompare(b.id));
  const deps: ReconcileDeps = {
    // A faithful in-memory keyset scan: ordered by (startTime, id), strictly after the cursor, at most `limit`.
    findUpcoming: async (query) => {
      calls.findUpcoming.push(query);
      const { after, limit } = query;
      return sorted
        .filter(
          (b) =>
            !after ||
            b.startTime.getTime() > after.startTime.getTime() ||
            (b.startTime.getTime() === after.startTime.getTime() && b.id > after.id),
        )
        .slice(0, limit);
    },
    findSent: async (ids) => {
      calls.findSent.push(ids);
      return world.sent ?? [];
    },
    readStart: async (id) => {
      const override = world.currentStart?.[id];
      if (override !== undefined) return override;
      return world.bookings.find((b) => b.id === id)?.startTime ?? null;
    },
    ensure: (kind, id, start, now, stillCurrent) => ensureReminder(kind, id, start, now, queue, stillCurrent),
  };
  return { deps, calls };
}

test("reconcileReminders is idempotent: the second run adds nothing", async () => {
  const { queue, added } = statefulQueue();
  const { deps } = reconcileDeps({ bookings: [booking("r1", 3 * HOUR), booking("r2", 20 * HOUR)] }, queue);
  const first = await reconcileReminders(NOW, deps);
  assert.deepEqual(first, { checked: 2, repaired: 3, failed: 0, next: null }); // r1: 15m; r2: 24h and 15m
  assert.deepEqual(added.map((j) => j.id).sort(), ["reminder-15m-r1", "reminder-15m-r2", "reminder-24h-r2"]);
  const second = await reconcileReminders(NOW, deps);
  assert.deepEqual(second, { checked: 2, repaired: 0, failed: 0, next: null });
  assert.equal(added.length, 3);
});

test("reconcileReminders never re-creates a reminder that was already delivered", async () => {
  const { queue, added } = statefulQueue();
  const { deps } = reconcileDeps({ bookings: [booking("m1", 3 * HOUR)], sent: [{ bookingId: "m1", template: "reminder-15m" }] }, queue);
  assert.deepEqual(await reconcileReminders(NOW, deps), { checked: 1, repaired: 0, failed: 0, next: null });
  assert.equal(added.length, 0);
});

test("reconcileReminders does not add a reminder that was skipped on purpose when the booking was made (E1)", async () => {
  const { queue, added } = statefulQueue();
  const fresh = booking("late", 20 * HOUR, "SCHEDULED", 30 * MIN); // booked 30 min ago for 20 h from now
  const { deps } = reconcileDeps({ bookings: [fresh] }, queue);
  await reconcileReminders(NOW, deps);
  assert.deepEqual(added.map((j) => j.id), ["reminder-15m-late"]);
});

test("reconcileReminders pages through the window with a (startTime, id) keyset: nobody is skipped or repeated, ties included (E4)", async () => {
  const { queue, added } = statefulQueue();
  // 10 bookings in one group session (same start) plus 3 later ones; batches of 4.
  const group = Array.from({ length: 10 }, (_, i) => booking(`g${String(i).padStart(2, "0")}`, 3 * HOUR));
  const later = [booking("z1", 4 * HOUR), booking("z2", 5 * HOUR), booking("z3", 5 * HOUR)];
  const { deps, calls } = reconcileDeps({ bookings: [...later, ...group] }, queue);
  const summary = await reconcileReminders(NOW, deps, { batchSize: 4 });
  assert.deepEqual(summary, { checked: 13, repaired: 13, failed: 0, next: null });
  assert.equal(added.length, 13);
  assert.equal(new Set(added.map((j) => j.id)).size, 13);
  assert.ok(calls.findUpcoming.every((q) => q.limit <= 4), "every query is a small page");
  assert.equal(calls.findUpcoming.length, 4); // 4 + 4 + 4 + 1
  assert.ok(calls.findSent.every((ids) => ids.length <= 4), "one message query per page");
  assert.equal(calls.findUpcoming[0].after, undefined);
  assert.deepEqual(calls.findUpcoming[1].after, { startTime: at(3 * HOUR), id: "g03" });
});

test("reconcileReminders: a run that hits its cap says where to resume, and resuming covers the rest (E4)", async () => {
  const { queue, added } = statefulQueue();
  const all = Array.from({ length: 10 }, (_, i) => booking(`c${String(i).padStart(2, "0")}`, 3 * HOUR + i * MIN));
  const { deps, calls } = reconcileDeps({ bookings: all }, queue);

  const first = await reconcileReminders(NOW, deps, { batchSize: 3, maxBookings: 7 });
  assert.equal(first.checked, 7);
  assert.deepEqual(first.next, { startTime: at(3 * HOUR + 6 * MIN), id: "c06" });
  assert.deepEqual(calls.findUpcoming.map((q) => q.limit), [3, 3, 1]); // never reads past the cap
  assert.equal(added.length, 7);

  const second = await reconcileReminders(NOW, deps, { batchSize: 3, maxBookings: 7, after: first.next! });
  assert.deepEqual(second, { checked: 3, repaired: 3, failed: 0, next: null });
  assert.equal(added.length, 10);
});

test("reconcileReminders is bounded by default: pages of REPAIR_BATCH_SIZE, at most REPAIR_MAX_BOOKINGS per run", async () => {
  assert.equal(REPAIR_BATCH_SIZE, 250);
  assert.equal(REPAIR_MAX_BOOKINGS, 2_000);
  const { queue } = statefulQueue();
  const { deps, calls } = reconcileDeps({ bookings: Array.from({ length: 600 }, (_, i) => booking(`p${i}`, 3 * HOUR + i * MIN)) }, queue);
  await reconcileReminders(NOW, deps);
  assert.deepEqual(calls.findUpcoming.map((q) => q.limit), [250, 250, 250]);
});

test("reconcileReminders: a reschedule that lands during the run is not undone (E3)", async () => {
  const { queue, added, removed } = statefulQueue();
  const moved = booking("mv", 3 * HOUR);
  const cancelled = booking("cx", 4 * HOUR);
  const { deps } = reconcileDeps(
    { bookings: [moved, cancelled, booking("ok", 5 * HOUR)], currentStart: { mv: at(9 * HOUR), cx: null } },
    queue,
  );
  const summary = await reconcileReminders(NOW, deps);
  assert.deepEqual(summary, { checked: 3, repaired: 1, failed: 0, next: null });
  assert.deepEqual(added.map((j) => j.id), ["reminder-15m-ok"]);
  assert.deepEqual(removed, []);
});

test("reconcileReminders: one failing step does not stop the others", async () => {
  const { queue, added } = statefulQueue();
  const { deps } = reconcileDeps({ bookings: [booking("f1", 3 * HOUR), booking("f2", 4 * HOUR), booking("f3", 5 * HOUR)] }, queue);
  const ensure = deps.ensure;
  deps.ensure = async (kind, id, start, now, current) => {
    if (id === "f2") throw new Error("redis hiccup");
    return ensure(kind, id, start, now, current);
  };
  const summary = await reconcileReminders(NOW, deps);
  assert.deepEqual(summary, { checked: 3, repaired: 2, failed: 1, next: null });
  assert.deepEqual(added.map((j) => j.id).sort(), ["reminder-15m-f1", "reminder-15m-f3"]);
});

test("reconcileReminders: Redis down gives up after 3 failures in a row instead of trying every booking", async () => {
  const many = Array.from({ length: 30 }, (_, i) => booking(`d${i}`, 3 * HOUR + i * MIN));
  let attempts = 0;
  const { deps, calls } = reconcileDeps({ bookings: many }, statefulQueue().queue);
  deps.ensure = async () => {
    attempts++;
    throw new Error("connect ECONNREFUSED");
  };
  await assert.rejects(reconcileReminders(NOW, deps, { batchSize: 10 }), /stopped after 3 failures in a row.*ECONNREFUSED/);
  assert.equal(attempts, 3);
  assert.equal(calls.findUpcoming.length, 1, "no further pages are read once it gives up");
});

test("reconcileReminders: a failing database read rejects (the worker tick reports it)", async () => {
  const { deps } = reconcileDeps({ bookings: [] }, statefulQueue().queue);
  deps.findUpcoming = async () => {
    throw new Error("db down");
  };
  await assert.rejects(reconcileReminders(NOW, deps), /db down/);
});

// --- worker/reminder-reconcile.ts ---

async function settle() {
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
}

test("startReminderReconcile: first run at 60 s, then every 10 minutes, never overlapping itself", async () => {
  const saved = process.env.REDIS_URL;
  process.env.REDIS_URL = "redis://unused.invalid:6379";
  mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const runs: Date[] = [];
  let release: (() => void) | undefined;
  let hold = false;
  const stop = startReminderReconcile({
    run: async (now) => {
      runs.push(now);
      if (hold) await new Promise<void>((r) => (release = r));
    },
  });
  try {
    mock.timers.tick(59_000);
    await settle();
    assert.equal(runs.length, 0);
    mock.timers.tick(1_000);
    await settle();
    assert.equal(runs.length, 1);
    mock.timers.tick(10 * 60_000);
    await settle();
    assert.equal(runs.length, 2);
    // A pass that is still running makes the next tick a no-op.
    hold = true;
    mock.timers.tick(10 * 60_000);
    await settle();
    assert.equal(runs.length, 3);
    mock.timers.tick(10 * 60_000);
    await settle();
    assert.equal(runs.length, 3);
    release?.();
    await settle();
    hold = false;
    mock.timers.tick(10 * 60_000);
    await settle();
    assert.equal(runs.length, 4);
  } finally {
    stop();
    mock.timers.reset();
    if (saved === undefined) delete process.env.REDIS_URL;
    else process.env.REDIS_URL = saved;
  }
});

test("startReminderReconcile: a failing pass is reported and the loop keeps running", async () => {
  const saved = process.env.REDIS_URL;
  process.env.REDIS_URL = "redis://unused.invalid:6379";
  mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const errors: string[] = [];
  let calls = 0;
  const stop = startReminderReconcile({
    run: async () => {
      calls++;
      if (calls === 1) throw new Error("repair blew up");
    },
    onError: (e) => errors.push(e instanceof Error ? e.message : String(e)),
  });
  try {
    mock.timers.tick(60_000);
    await settle();
    assert.deepEqual(errors, ["repair blew up"]);
    mock.timers.tick(10 * 60_000);
    await settle();
    assert.equal(calls, 2);
    assert.equal(errors.length, 1);
  } finally {
    stop();
    mock.timers.reset();
    if (saved === undefined) delete process.env.REDIS_URL;
    else process.env.REDIS_URL = saved;
  }
});

test("startReminderReconcile: does nothing without REDIS_URL", async () => {
  const saved = process.env.REDIS_URL;
  delete process.env.REDIS_URL;
  mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  let calls = 0;
  const stop = startReminderReconcile({ run: async () => void calls++ });
  try {
    mock.timers.tick(60 * 60_000);
    await settle();
    assert.equal(calls, 0);
  } finally {
    stop();
    mock.timers.reset();
    if (saved !== undefined) process.env.REDIS_URL = saved;
  }
});


// --- database: the real queries, with a fake queue. Every run is scoped to this test's own booking ids, so the result
// does not depend on how many upcoming bookings the shared database holds. ---

const run = Date.now();
let influencerId: string | undefined;
const serviceIds: string[] = [];
const ids: Record<string, string> = {};

interface MakeOptions {
  status?: string;
  redactedAt?: Date;
  /** Both createdAt and updatedAt are set this long ago (a booking armed long before the test). Default: now. */
  armedAgoMs?: number;
  /** createdAt only, when it should be older than updatedAt (a request that waited for approval). */
  createdAgoMs?: number;
  decidedAt?: Date;
  service?: 0 | 1;
  startAt?: Date;
}

async function makeBooking(key: string, startsInMs: number, data: MakeOptions = {}) {
  const start = data.startAt ?? new Date(Date.now() + startsInMs);
  start.setMilliseconds(0);
  const session = await prisma.session.create({
    data: { serviceId: serviceIds[data.service ?? 0], startTime: start, endTime: new Date(start.getTime() + 30 * MIN) },
  });
  const created = await prisma.booking.create({
    data: {
      sessionId: session.id,
      status: (data.status ?? "SCHEDULED") as never,
      customerName: "Repair Tester",
      customerEmail: `repair${run}_${key}@example.com`,
      whatsappE164: "+910000000000",
      whatsappOptIn: true,
      redactedAt: data.redactedAt,
      decidedAt: data.decidedAt,
      ...(data.armedAgoMs !== undefined
        ? { createdAt: new Date(Date.now() - (data.createdAgoMs ?? data.armedAgoMs)), updatedAt: new Date(Date.now() - data.armedAgoMs) }
        : {}),
    },
  });
  ids[key] = created.id;
  return { id: created.id, start };
}

/** Runs the repair against the real queries for the given own bookings, adding to the returned fake queue. */
async function repair(bookingIds: string[], options: ReconcileOptions = {}) {
  const q = statefulQueue();
  const summary = await reconcileReminders(
    new Date(),
    { ensure: (kind, bookingId, startTime, now, stillCurrent) => ensureReminder(kind, bookingId, startTime, now, q.queue, stillCurrent) },
    { ...options, bookingIds },
  );
  return { ...q, summary };
}

before(async () => {
  if (skip) return;
  const inf = await prisma.influencer.create({
    data: { slug: `repair-${run}`, name: "Repair Test", email: `repairtest${run}@example.com` },
  });
  influencerId = inf.id;
  for (const title of ["1:1 a", "1:1 b"]) {
    serviceIds.push((await prisma.service.create({ data: { influencerId, title, durationMin: 30, priceMinor: 49900 } })).id);
  }
});

after(async () => {
  try {
    if (influencerId) await prisma.influencer.delete({ where: { id: influencerId } });
  } catch (e) {
    console.error("cleanup failed", e);
  } finally {
    await prisma.$disconnect();
  }
});

test("DB: a SCHEDULED booking in 3 h with no Message rows gets exactly one 15m job, a second run adds nothing", { skip }, async () => {
  const { id, start } = await makeBooking("soon", 3 * HOUR);
  // Neighbours that must never be planned: out of the window, already started, cancelled, erased.
  await makeBooking("far", 30 * HOUR);
  await makeBooking("past", -1 * HOUR);
  await makeBooking("cancelled", 4 * HOUR, { status: "CANCELLED" });
  await makeBooking("erased", 5 * HOUR, { redactedAt: new Date() });
  const own = Object.values(ids);

  const first = await repair(own);
  assert.equal(first.summary.checked, 1, "only the SCHEDULED, upcoming, not erased booking is read");
  assert.deepEqual([...first.jobs.keys()], [reminderJobId("15m", id)]); // 24h is not wanted: 3 h left
  const job = first.added[0];
  assert.equal(job.data.expectedStartTime, start.toISOString());
  assert.ok(Math.abs((job.opts.delay as number) - (3 * HOUR - 15 * MIN)) < 10_000);

  // Same queue, second run: nothing more is added.
  const again = await reconcileReminders(
    new Date(),
    { ensure: (kind, bookingId, startTime, now, stillCurrent) => ensureReminder(kind, bookingId, startTime, now, first.queue, stillCurrent) },
    { bookingIds: own },
  );
  assert.equal(again.repaired, 0);
  assert.equal(first.added.length, 1);
});

test("DB: only a delivered reminder blocks the repair; a failed or re-armed (pending) one does not", { skip }, async () => {
  const { id } = await makeBooking("sent", 6 * HOUR);
  await prisma.message.create({ data: { bookingId: id, channel: "SMS", template: "reminder-15m", status: "FAILED" } });
  assert.deepEqual([...(await repair([id])).jobs.keys()], [reminderJobId("15m", id)], "FAILED does not block");

  await prisma.message.update({
    where: { bookingId_channel_template: { bookingId: id, channel: "SMS", template: "reminder-15m" } },
    data: { status: "PENDING" }, // what rearmMessage does on a reschedule
  });
  assert.deepEqual([...(await repair([id])).jobs.keys()], [reminderJobId("15m", id)], "PENDING does not block");

  await prisma.message.update({
    where: { bookingId_channel_template: { bookingId: id, channel: "SMS", template: "reminder-15m" } },
    data: { status: "SENT" },
  });
  const sent = await repair([id]);
  assert.deepEqual([...sent.jobs.keys()], [], "SENT blocks");
  assert.equal(sent.summary.checked, 1);
});

test("DB: a booking whose reminders were both delivered is left out of the scan in SQL", { skip }, async () => {
  const { id } = await makeBooking("done", 20 * HOUR, { armedAgoMs: 3 * 86_400_000 });
  await prisma.message.create({ data: { bookingId: id, channel: "WHATSAPP", template: "reminder-24h", status: "DELIVERED" } });
  assert.equal((await repair([id])).summary.checked, 1, "one delivered: still read");
  await prisma.message.create({ data: { bookingId: id, channel: "WHATSAPP", template: "reminder-15m", status: "READ" } });
  const both = await repair([id]);
  assert.equal(both.summary.checked, 0);
  assert.equal(both.added.length, 0);
});

test("DB: a booking made 20 h before the start never gets the 24h reminder; one made days ahead does (E1)", { skip }, async () => {
  const fresh = await makeBooking("fresh20", 20 * HOUR); // created now
  const old = await makeBooking("old20", 20 * HOUR + MIN, { armedAgoMs: 3 * 86_400_000 });
  const freshJobs = [...(await repair([fresh.id])).jobs.keys()];
  assert.deepEqual(freshJobs, [reminderJobId("15m", fresh.id)]);
  const oldJobs = [...(await repair([old.id])).jobs.keys()].sort();
  assert.deepEqual(oldJobs, [reminderJobId("15m", old.id), reminderJobId("24h", old.id)].sort());
});

test("DB: a booking confirmed 10 minutes before the start gets no 'starts in 15 minutes' afterwards (E1)", { skip }, async () => {
  const lastMinute = await makeBooking("lastmin", 10 * MIN); // created now, starts in 10 min
  const lost = await makeBooking("lostjob", 10 * MIN + 1_000, { armedAgoMs: 2 * HOUR });
  assert.deepEqual([...(await repair([lastMinute.id])).jobs.keys()], []);
  assert.deepEqual([...(await repair([lost.id])).jobs.keys()], [reminderJobId("15m", lost.id)]);
});

test("DB: a reschedule re-arms the reminders, so a 24h that fell before the reschedule is not 'lost' (E1/E5)", { skip }, async () => {
  const plain = await makeBooking("plain", 14 * HOUR, { armedAgoMs: 5 * 86_400_000 });
  const moved = await makeBooking("moved", 14 * HOUR + MIN, { armedAgoMs: 5 * 86_400_000 });
  // lib/manage.ts stamps the booking row at the moment of the reschedule (nothing else about the booking changes).
  await prisma.booking.update({ where: { id: moved.id }, data: { updatedAt: new Date() } });
  assert.deepEqual([...(await repair([plain.id])).jobs.keys()].sort(), [reminderJobId("15m", plain.id), reminderJobId("24h", plain.id)].sort());
  assert.deepEqual([...(await repair([moved.id])).jobs.keys()], [reminderJobId("15m", moved.id)]);
});

test("DB: armedAt does not move when delivery callbacks touch Message rows (R1)", { skip }, async () => {
  // Armed 5 days ago, 14 h to go: both reminders are wanted. A reschedule-notice row that a late WhatsApp callback has
  // just updated (and a reminder row too) must not turn the 24h reminder into "skipped on purpose".
  const { id } = await makeBooking("stable", 14 * HOUR, { armedAgoMs: 5 * 86_400_000 });
  const notice = await prisma.message.create({
    data: { bookingId: id, channel: "WHATSAPP", template: "reschedule", status: "SENT", providerMessageId: `wamid.stable.${run}` },
  });
  await prisma.message.update({ where: { id: notice.id }, data: { status: "READ" } }); // a callback: updatedAt moves to now
  assert.deepEqual(
    [...(await repair([id])).jobs.keys()].sort(),
    [reminderJobId("15m", id), reminderJobId("24h", id)].sort(),
  );
});

test("DB: an approval request approved 18 h before the start gets no 24h reminder, a booking confirmed days ahead does (R2)", { skip }, async () => {
  const startsIn = 17 * HOUR;
  // Requested 5 days ago, approved (and paid, meeting created) one hour ago: the 24h fire time (7 h ago) is long before that.
  const approved = await makeBooking("approved", startsIn, {
    armedAgoMs: HOUR,
    createdAgoMs: 5 * 86_400_000,
    decidedAt: new Date(Date.now() - HOUR),
  });
  // Same shape, but the row was only ever touched at creation, 5 days ago.
  const early = await makeBooking("early", startsIn + MIN, { armedAgoMs: 5 * 86_400_000 });
  assert.deepEqual([...(await repair([approved.id])).jobs.keys()], [reminderJobId("15m", approved.id)]);
  assert.deepEqual(
    [...(await repair([early.id])).jobs.keys()].sort(),
    [reminderJobId("15m", early.id), reminderJobId("24h", early.id)].sort(),
  );
  // decidedAt alone is also a lower bound, even if updatedAt were older.
  const decidedOnly = await makeBooking("decided", startsIn + 2 * MIN, { armedAgoMs: 5 * 86_400_000, decidedAt: new Date(Date.now() - HOUR) });
  assert.deepEqual([...(await repair([decidedOnly.id])).jobs.keys()], [reminderJobId("15m", decidedOnly.id)]);
});

test("DB: a late delivery callback for the OLD reminder cannot make the re-armed one look sent (R1)", { skip }, async () => {
  const { rearmMessage, applyWhatsAppStatusUpdate } = await import("../lib/messaging");
  const { id } = await makeBooking("late", 5 * HOUR, { armedAgoMs: 2 * 86_400_000 });
  const row = () =>
    prisma.message.findUniqueOrThrow({ where: { bookingId_channel_template: { bookingId: id, channel: "WHATSAPP", template: "reminder-15m" } } });
  const oldId = `wamid.old.${run}`;
  const newId = `wamid.new.${run}`;
  await prisma.message.create({
    data: { bookingId: id, channel: "WHATSAPP", template: "reminder-15m", status: "SENT", providerMessageId: oldId, sentAt: new Date() },
  });

  // The session is rescheduled: the sent reminder is re-armed, losing its provider id and send time.
  await rearmMessage(id, "reminder-15m");
  const rearmed = await row();
  assert.equal(rearmed.status, "PENDING");
  assert.equal(rearmed.providerMessageId, null);
  assert.equal(rearmed.sentAt, null);

  // Hours later WhatsApp reports the old message as delivered and read: nothing may change.
  assert.equal(await applyWhatsAppStatusUpdate({ providerMessageId: oldId, status: "DELIVERED" }), 0);
  assert.equal(await applyWhatsAppStatusUpdate({ providerMessageId: oldId, status: "READ" }), 0);
  assert.equal((await row()).status, "PENDING");
  assert.deepEqual([...(await repair([id])).jobs.keys()], [reminderJobId("15m", id)], "the repair still wants the new reminder");

  // The new reminder goes out; only callbacks for ITS id apply, and only forward.
  await prisma.message.update({
    where: { bookingId_channel_template: { bookingId: id, channel: "WHATSAPP", template: "reminder-15m" } },
    data: { status: "SENT", providerMessageId: newId, sentAt: new Date() },
  });
  assert.equal(await applyWhatsAppStatusUpdate({ providerMessageId: oldId, status: "READ" }), 0);
  assert.equal((await row()).status, "SENT");
  assert.equal(await applyWhatsAppStatusUpdate({ providerMessageId: newId, status: "DELIVERED" }), 1);
  assert.equal(await applyWhatsAppStatusUpdate({ providerMessageId: newId, status: "READ" }), 1);
  assert.equal(await applyWhatsAppStatusUpdate({ providerMessageId: newId, status: "DELIVERED" }), 0, "READ is never pulled back");
  assert.equal((await row()).status, "READ");
  assert.deepEqual([...(await repair([id])).jobs.keys()], [], "now it really is delivered");
});

test("DB: the keyset scan reads every booking once, including two sessions that start at the same instant (E4)", { skip }, async () => {
  const shared = new Date(Date.now() + 7 * HOUR);
  const a = await makeBooking("ks_a", 0, { startAt: new Date(shared), service: 0 });
  const b = await makeBooking("ks_b", 0, { startAt: new Date(shared), service: 1 });
  const c = await makeBooking("ks_c", 8 * HOUR);
  const r = await repair([a.id, b.id, c.id], { batchSize: 1 });
  assert.equal(r.summary.checked, 3);
  assert.deepEqual(
    [...r.jobs.keys()].sort(),
    [a.id, b.id, c.id].map((id) => reminderJobId("15m", id)).sort(),
  );
  assert.equal(r.added.length, 3);

  const capped = await repair([a.id, b.id, c.id], { batchSize: 1, maxBookings: 2 });
  assert.equal(capped.summary.checked, 2);
  assert.ok(capped.summary.next);
  const rest = await repair([a.id, b.id, c.id], { batchSize: 1, maxBookings: 2, after: capped.summary.next! });
  assert.equal(rest.summary.checked, 1);
  assert.equal(rest.summary.next, null);
});

test("DB: readStart sees a booking that moved or was cancelled since the scan (E3)", { skip }, async () => {
  const { id, start } = await makeBooking("readstart", 5 * HOUR);
  const q = statefulQueue();
  const summary = await reconcileReminders(
    new Date(),
    {
      // Between the scan and the queue call the customer cancels.
      ensure: async (kind, bookingId, startTime, now, stillCurrent) => {
        await prisma.booking.update({ where: { id }, data: { status: "CANCELLED" } });
        return ensureReminder(kind, bookingId, startTime, now, q.queue, stillCurrent);
      },
    },
    { bookingIds: [id] },
  );
  assert.equal(summary.repaired, 0);
  assert.equal(q.added.length, 0);
  assert.ok(start);
});
