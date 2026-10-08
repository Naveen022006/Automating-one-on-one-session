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
  const { deps, sent } = reminderFakes({ id: "bk1", status: "SCHEDULED" });
  const outcome = await sendReminderForBooking("bk1", "24h", deps);
  assert.equal(outcome, "sent");
  assert.deepEqual(sent, [{ bookingId: "bk1", template: "reminder-24h" }]);
});

test("sendReminderForBooking skips a CANCELLED booking and sends nothing", async () => {
  const { deps, sent } = reminderFakes({ id: "bk2", status: "CANCELLED" });
  const outcome = await sendReminderForBooking("bk2", "15m", deps);
  assert.equal(outcome, "skipped");
  assert.deepEqual(sent, []);
});

test("sendReminderForBooking skips when the booking is gone", async () => {
  const { deps, sent } = reminderFakes(null);
  const outcome = await sendReminderForBooking("bk-missing", "24h", deps);
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
