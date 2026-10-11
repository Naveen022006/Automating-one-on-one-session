import "dotenv/config";
import assert from "node:assert/strict";
import { after, before, mock, test } from "node:test";
import { prisma } from "../lib/db";
import { ensureReminder, reminderJobId, type ReminderKind, type ReminderQueue } from "../lib/queue";
import {
  REPAIR_MAX_BOOKINGS,
  planReminderRepairs,
  reconcileReminders,
  type ReconcileDeps,
  type RepairBooking,
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

const booking = (id: string, msFromNow: number, status = "SCHEDULED"): RepairBooking => ({ id, status, startTime: at(msFromNow) });

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

test("planReminderRepairs: a Message row on any channel and any status removes that template only", () => {
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

test("ensureReminder: a delayed or waiting job for another time is replaced", async () => {
  const start = at(3 * HOUR);
  for (const state of ["delayed", "waiting"]) {
    const { queue, added, removed, jobs } = statefulQueue([{ id: "reminder-15m-bk4", expectedStartTime: at(9 * HOUR).toISOString(), state }]);
    assert.equal(await ensureReminder("15m", "bk4", start, NOW, queue), "replaced", state);
    assert.deepEqual(removed, ["reminder-15m-bk4"]);
    assert.equal(added.length, 1);
    assert.equal(jobs.get("reminder-15m-bk4")!.data.expectedStartTime, start.toISOString());
  }
});

test("ensureReminder: a job for another time that is active, completed or failed is never touched", async () => {
  for (const state of ["active", "completed", "failed"]) {
    const { queue, added, removed } = statefulQueue([{ id: "reminder-15m-bk5", expectedStartTime: at(9 * HOUR).toISOString(), state }]);
    assert.equal(await ensureReminder("15m", "bk5", at(3 * HOUR), NOW, queue), "kept", state);
    assert.deepEqual([added.length, removed.length], [0, 0], state);
  }
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

// --- reconcileReminders (injected rows and queue) ---

function reconcileDeps(bookings: RepairBooking[], sent: Array<{ bookingId: string; template: string }>, queue: ReminderQueue) {
  const calls: { findUpcoming: number; findSent: number; limit?: number; ids?: string[] } = { findUpcoming: 0, findSent: 0 };
  const deps: ReconcileDeps = {
    findUpcoming: async (_now, limit) => {
      calls.findUpcoming++;
      calls.limit = limit;
      return bookings;
    },
    findSent: async (ids) => {
      calls.findSent++;
      calls.ids = ids;
      return sent;
    },
    ensure: (kind, id, start, now) => ensureReminder(kind, id, start, now, queue),
  };
  return { deps, calls };
}

test("reconcileReminders is idempotent: the second run adds nothing", async () => {
  const { queue, added } = statefulQueue();
  const { deps } = reconcileDeps([booking("r1", 3 * HOUR), booking("r2", 20 * HOUR)], [], queue);
  const first = await reconcileReminders(NOW, deps);
  assert.deepEqual(first, { checked: 2, repaired: 3, failed: 0 }); // r1: 15m; r2: 24h and 15m
  assert.deepEqual(added.map((j) => j.id).sort(), ["reminder-15m-r1", "reminder-15m-r2", "reminder-24h-r2"]);
  const second = await reconcileReminders(NOW, deps);
  assert.deepEqual(second, { checked: 2, repaired: 0, failed: 0 });
  assert.equal(added.length, 3);
});

test("reconcileReminders never re-creates a reminder that already has a Message row", async () => {
  const { queue, added } = statefulQueue();
  const { deps } = reconcileDeps(
    [booking("m1", 3 * HOUR)],
    [{ bookingId: "m1", template: "reminder-15m" }],
    queue,
  );
  assert.deepEqual(await reconcileReminders(NOW, deps), { checked: 1, repaired: 0, failed: 0 });
  assert.equal(added.length, 0);
});

test("reconcileReminders is bounded: one booking query capped at REPAIR_MAX_BOOKINGS, one message query for all ids", async () => {
  const { queue } = statefulQueue();
  const many = Array.from({ length: 40 }, (_, i) => booking(`b${i}`, 3 * HOUR + i * MIN));
  const { deps, calls } = reconcileDeps(many, [], queue);
  await reconcileReminders(NOW, deps);
  assert.equal(REPAIR_MAX_BOOKINGS, 500);
  assert.equal(calls.limit, REPAIR_MAX_BOOKINGS);
  assert.equal(calls.findUpcoming, 1);
  assert.equal(calls.findSent, 1);
  assert.equal(calls.ids?.length, 40);
});

test("reconcileReminders: one failing step does not stop the others", async () => {
  const { queue, added } = statefulQueue();
  const { deps } = reconcileDeps([booking("f1", 3 * HOUR), booking("f2", 4 * HOUR), booking("f3", 5 * HOUR)], [], queue);
  const ensure = deps.ensure;
  deps.ensure = async (kind, id, start, now) => {
    if (id === "f2") throw new Error("redis hiccup");
    return ensure(kind, id, start, now);
  };
  const summary = await reconcileReminders(NOW, deps);
  assert.deepEqual(summary, { checked: 3, repaired: 2, failed: 1 });
  assert.deepEqual(added.map((j) => j.id).sort(), ["reminder-15m-f1", "reminder-15m-f3"]);
});

test("reconcileReminders: Redis down gives up after 3 failures in a row instead of trying every booking", async () => {
  const many = Array.from({ length: 30 }, (_, i) => booking(`d${i}`, 3 * HOUR + i * MIN));
  let attempts = 0;
  const { deps } = reconcileDeps(many, [], statefulQueue().queue);
  deps.ensure = async () => {
    attempts++;
    throw new Error("connect ECONNREFUSED");
  };
  await assert.rejects(reconcileReminders(NOW, deps), /stopped after 3 failures in a row.*ECONNREFUSED/);
  assert.equal(attempts, 3);
});

test("reconcileReminders: a failing database read rejects (the worker tick reports it)", async () => {
  const { deps } = reconcileDeps([], [], statefulQueue().queue);
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

// --- database: the real queries, with a fake queue ---

const run = Date.now();
let influencerId: string | undefined;
const ids: Record<string, string> = {};

async function makeBooking(key: string, startsInMs: number, data: { status?: string; redactedAt?: Date } = {}) {
  const start = new Date(Date.now() + startsInMs);
  start.setMilliseconds(0);
  const service = await prisma.service.findFirstOrThrow({ where: { influencerId } });
  const session = await prisma.session.create({
    data: { serviceId: service.id, startTime: start, endTime: new Date(start.getTime() + 30 * MIN) },
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
    },
  });
  ids[key] = created.id;
  return { id: created.id, start };
}

before(async () => {
  if (skip) return;
  const inf = await prisma.influencer.create({
    data: { slug: `repair-${run}`, name: "Repair Test", email: `repairtest${run}@example.com` },
  });
  influencerId = inf.id;
  await prisma.service.create({ data: { influencerId, title: "1:1", durationMin: 30, priceMinor: 49900 } });
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

  const { queue, added } = statefulQueue();
  const now = new Date();
  const deps: Partial<ReconcileDeps> = { ensure: (kind, bookingId, startTime, at2) => ensureReminder(kind, bookingId, startTime, at2, queue) };
  const mine = () => added.filter((j) => Object.values(ids).some((bookingId) => j.id.endsWith(bookingId)));

  const first = await reconcileReminders(now, deps);
  assert.ok(first.checked >= 1);
  assert.deepEqual(mine().map((j) => j.id), [reminderJobId("15m", id)]); // 24h is not wanted: 3 h left
  const job = mine()[0];
  assert.equal(job.data.expectedStartTime, start.toISOString());
  assert.ok(Math.abs((job.opts.delay as number) - (3 * HOUR - 15 * MIN)) < 10_000);

  await reconcileReminders(new Date(), deps);
  assert.equal(mine().length, 1);
});

test("DB: a reminder that already has a Message row (any channel, any status) is not re-created", { skip }, async () => {
  const { id } = await makeBooking("sent", 6 * HOUR);
  await prisma.message.create({ data: { bookingId: id, channel: "SMS", template: "reminder-15m", status: "FAILED" } });
  const { queue, added } = statefulQueue();
  await reconcileReminders(new Date(), { ensure: (kind, bookingId, startTime, now) => ensureReminder(kind, bookingId, startTime, now, queue) });
  assert.deepEqual(added.filter((j) => j.id.endsWith(id)), []);
});

test("DB: a 20 h booking wants both reminders", { skip }, async () => {
  const { id } = await makeBooking("tomorrow", 20 * HOUR);
  const { queue, added } = statefulQueue();
  await reconcileReminders(new Date(), { ensure: (kind: ReminderKind, bookingId, startTime, now) => ensureReminder(kind, bookingId, startTime, now, queue) });
  assert.deepEqual(
    added.filter((j) => j.id.endsWith(id)).map((j) => j.id).sort(),
    [reminderJobId("15m", id), reminderJobId("24h", id)].sort(),
  );
});
