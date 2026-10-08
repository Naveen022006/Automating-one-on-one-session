import assert from "node:assert/strict";
import { test } from "node:test";
import {
  cancelReminders,
  enqueueReminders,
  reminderJobId,
  type ReminderKind,
  type ReminderQueue,
} from "../lib/queue";
import { sendReminderForBooking, type ReminderBooking, type ReminderDeps } from "../lib/reminders";
import type { MessageOutcome } from "../lib/messaging";

// Pure-logic tests: no Redis and no DB. The booking read, the message send and the queue are all injected as
// fakes, so these exercise the run-time status check and the deterministic job id/delay logic directly.

/** Deps for sendReminderForBooking that record what was sent and report a fixed booking status. */
function reminderFakes(booking: ReminderBooking | null) {
  const sent: Array<{ bookingId: string; template: string }> = [];
  const deps: Partial<ReminderDeps> = {
    findBooking: async () => booking,
    sendMessage: async (bookingId, template): Promise<MessageOutcome> => {
      sent.push({ bookingId, template });
      return "sent";
    },
    alert: async () => {},
  };
  return { deps, sent };
}

/** A SCHEDULED booking whose current session starts at the given time. */
function scheduledBooking(id: string, startTime: Date): ReminderBooking {
  return { id, status: "SCHEDULED", session: { startTime } };
}

/** A fake BullMQ queue that records add() calls and serves getJob() from a seeded set of job ids. */
function fakeQueue(seededJobIds: string[] = []) {
  const added: Array<{ name: string; data: unknown; opts: Record<string, unknown> }> = [];
  const removed: string[] = [];
  const present = new Set(seededJobIds);
  const queue = {
    add: async (name: string, data: unknown, opts: Record<string, unknown>) => {
      added.push({ name, data, opts });
      return { id: opts.jobId } as never;
    },
    getJob: async (id: string) => {
      if (!present.has(id)) return undefined as never;
      return { id, remove: async () => void removed.push(id) } as never;
    },
  } as unknown as ReminderQueue;
  return { queue, added, removed };
}

test("sendReminderForBooking sends when the booking is SCHEDULED", async () => {
  const start = new Date("2026-01-01T10:00:00.000Z");
  const { deps, sent } = reminderFakes(scheduledBooking("bk1", start));
  // No expectedStartTime passed: pure status-based send (back-compat with reminders enqueued before the field).
  const outcome = await sendReminderForBooking("bk1", "24h", undefined, deps);
  assert.equal(outcome, "sent");
  assert.deepEqual(sent, [{ bookingId: "bk1", template: "reminder-24h" }]);
});

test("sendReminderForBooking sends when the expected fire time still matches the session", async () => {
  const start = new Date("2026-01-01T10:00:00.000Z");
  const { deps, sent } = reminderFakes(scheduledBooking("bk1b", start));
  const outcome = await sendReminderForBooking("bk1b", "24h", new Date(start), deps);
  assert.equal(outcome, "sent");
  assert.deepEqual(sent, [{ bookingId: "bk1b", template: "reminder-24h" }]);
});

test("sendReminderForBooking skips a stale reminder whose expected time no longer matches (reschedule backstop)", async () => {
  // Review issue 1: a reschedule leaves the booking SCHEDULED but moves session.startTime. A surviving stale
  // job enqueued for the OLD time must skip itself even though the status check passes.
  const oldStart = new Date("2026-01-01T10:00:00.000Z");
  const newStart = new Date("2026-01-05T10:00:00.000Z");
  const { deps, sent } = reminderFakes(scheduledBooking("bk1c", newStart));
  const outcome = await sendReminderForBooking("bk1c", "15m", oldStart, deps);
  assert.equal(outcome, "skipped");
  assert.deepEqual(sent, []);
});

test("sendReminderForBooking skips a CANCELLED booking and sends nothing", async () => {
  const start = new Date("2026-01-01T10:00:00.000Z");
  const { deps, sent } = reminderFakes({ id: "bk2", status: "CANCELLED", session: { startTime: start } });
  const outcome = await sendReminderForBooking("bk2", "15m", start, deps);
  assert.equal(outcome, "skipped");
  assert.deepEqual(sent, []);
});

test("sendReminderForBooking skips when the booking is gone", async () => {
  const { deps, sent } = reminderFakes(null);
  const outcome = await sendReminderForBooking("bk-missing", "24h", undefined, deps);
  assert.equal(outcome, "skipped");
  assert.deepEqual(sent, []);
});

test("enqueueReminders uses the exact deterministic ids and correct delays", async () => {
  const { queue, added } = fakeQueue();
  const now = Date.now();
  const startTime = new Date(now + 48 * 60 * 60 * 1_000); // 48h out: both reminders are in the future
  await enqueueReminders("bk3", startTime, queue);

  assert.equal(added.length, 2);
  const byKind = new Map(added.map((a) => [(a.data as { kind: ReminderKind }).kind, a]));

  const r24 = byKind.get("24h")!;
  assert.equal(r24.opts.jobId, "reminder-24h-bk3");
  assert.equal(r24.opts.jobId, reminderJobId("24h", "bk3"));
  assert.equal(r24.opts.attempts, 5);
  assert.deepEqual(r24.opts.backoff, { type: "exponential", delay: 5_000 });
  // delay = start - 24h - now ~= 24h; allow a small clock tolerance for test execution time.
  assert.ok(Math.abs((r24.opts.delay as number) - 24 * 60 * 60 * 1_000) < 5_000);
  // The job carries the start time it was enqueued for: the run-time fire-time backstop (review issue 1).
  assert.equal((r24.data as { expectedStartTime: string }).expectedStartTime, startTime.toISOString());

  const r15 = byKind.get("15m")!;
  assert.equal(r15.opts.jobId, "reminder-15m-bk3");
  assert.equal(r15.opts.jobId, reminderJobId("15m", "bk3"));
  assert.ok(Math.abs((r15.opts.delay as number) - (48 * 60 * 60 * 1_000 - 15 * 60 * 1_000)) < 5_000);
});

test("enqueueReminders skips a reminder whose fire time is already past", async () => {
  const { queue, added } = fakeQueue();
  // 10 minutes before the session: T-15m is already in the past, T-24h long past.
  const startTime = new Date(Date.now() + 10 * 60 * 1_000);
  await enqueueReminders("bk4", startTime, queue);
  assert.equal(added.length, 0);
});

test("enqueueReminders enqueues only the still-future reminder", async () => {
  const { queue, added } = fakeQueue();
  // 2 hours out: T-24h is in the past, T-15m is still in the future.
  const startTime = new Date(Date.now() + 2 * 60 * 60 * 1_000);
  await enqueueReminders("bk5", startTime, queue);
  assert.equal(added.length, 1);
  assert.equal(added[0].opts.jobId, "reminder-15m-bk5");
});

test("enqueueReminders replaces a stale existing job for the same id (remove-then-add)", async () => {
  // Review issues 1 & 2: the reminder ids are keyed on (kind, bookingId) only, so a reschedule reuses them.
  // enqueueReminders must drop any surviving stale job before adding, otherwise BullMQ's add would be a no-op
  // and the old delay/expectedStartTime would persist.
  const { queue, added, removed } = fakeQueue(["reminder-24h-bk8", "reminder-15m-bk8"]);
  const startTime = new Date(Date.now() + 48 * 60 * 60 * 1_000);
  await enqueueReminders("bk8", startTime, queue);
  assert.deepEqual(removed.sort(), ["reminder-15m-bk8", "reminder-24h-bk8"]);
  assert.equal(added.length, 2);
  for (const a of added) {
    assert.equal((a.data as { expectedStartTime: string }).expectedStartTime, startTime.toISOString());
  }
});

test("enqueueReminders removes a stale job even when the new fire time is already past", async () => {
  // If the new slot is <15m away the new reminders are skipped, but any surviving stale job for the old time
  // must still be removed so it cannot fire.
  const { queue, added, removed } = fakeQueue(["reminder-24h-bk9", "reminder-15m-bk9"]);
  const startTime = new Date(Date.now() + 10 * 60 * 1_000); // 10 min out: both reminders in the past
  await enqueueReminders("bk9", startTime, queue);
  assert.deepEqual(removed.sort(), ["reminder-15m-bk9", "reminder-24h-bk9"]);
  assert.equal(added.length, 0);
});

test("cancelReminders removes both deterministic ids when present", async () => {
  const { queue, removed } = fakeQueue(["reminder-24h-bk6", "reminder-15m-bk6"]);
  await cancelReminders("bk6", queue);
  assert.deepEqual(removed.sort(), ["reminder-15m-bk6", "reminder-24h-bk6"]);
});

test("cancelReminders is a no-op when the jobs are absent", async () => {
  const { queue, removed } = fakeQueue([]);
  await cancelReminders("bk7", queue);
  assert.deepEqual(removed, []);
});
