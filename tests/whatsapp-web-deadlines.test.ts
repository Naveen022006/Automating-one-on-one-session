import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { NOTICE_MAX_QUEUE_MS, REMINDER_24H_MIN_LEAD_MS, REQUEST_NOTICE_MAX_QUEUE_MS, isReminderTemplate, webSendDeadline } from "../lib/whatsapp-web/deadline";
import { FakeTransport } from "../lib/whatsapp-web/fake-transport";
import { istDate, kvKeys, MemoryKv } from "../lib/whatsapp-web/kv";
import { MAX_EXPECTED_WAIT_MS, SendQueue, type GuardAnswer, type QueuedSend } from "../lib/whatsapp-web/send-queue";
import { MAX_JOBS_PER_SESSION } from "../worker/whatsapp-web-manager";
import { harness, ManualClock, settle, want } from "./helpers/whatsapp-web";

// Pure tests (fake transport, in-memory counters, a clock moved by hand): what happens to a message that has to WAIT in a linked
// number's queue. A group session's reminders must not hold worker slots for minutes, a reminder must never arrive after its time,
// and a booking cancelled while its message waited must not be messaged.

process.env.TOKEN_ENCRYPTION_KEY = randomBytes(32).toString("base64");

const INF = "inf-deadline";
const A = "+919876500001";

function setup(over: { guard?: (req: QueuedSend) => Promise<GuardAnswer>; minGapMs?: number } = {}) {
  const clock = new ManualClock();
  const kv = new MemoryKv(clock.now);
  const transport = new FakeTransport(INF, { autoConnect: false, log: () => {} });
  const guardCalls: QueuedSend[] = [];
  const queue = new SendQueue({
    influencerId: INF,
    transport: () => transport,
    kv,
    clock,
    minGapMs: over.minGapMs ?? 4_000,
    dailyCap: 1_000,
    guard: async (req) => (guardCalls.push(req), over.guard ? over.guard(req) : true),
  });
  return { clock, kv, transport, queue, guardCalls };
}

async function open(t: FakeTransport) {
  await t.connect({ getCreds: () => undefined, setCreds() {}, getKeys: () => ({}), setKeys() {}, clearKeys() {} }, { onQr() {}, onOpen() {}, onClose() {}, onDelivery() {} });
  t.emitOpen();
}

const req = (n: number, over: Partial<QueuedSend> = {}): QueuedSend => ({ toE164: A, text: `message ${n}`, bookingId: `bk-${n}`, key: `bk-${n}:reminder-15m`, kind: "reminder-15m", ...over });
const today = (s: ReturnType<typeof setup>) => s.kv.getInt(kvKeys.sent(INF, istDate(s.clock.now())));

test("deadlines: a 15-minute reminder until the session starts, a 24-hour reminder until 12 h are left, the rest 30 minutes after they were queued", () => {
  const start = Date.UTC(2026, 10, 12, 10, 0, 0);
  const now = Date.UTC(2026, 10, 11, 9, 0, 0);
  assert.equal(webSendDeadline("reminder-15m", start, now), start);
  assert.equal(webSendDeadline("reminder-24h", start, now), start - REMINDER_24H_MIN_LEAD_MS);
  for (const t of ["booking-confirmation", "reschedule", "cancellation", "request-received"]) assert.equal(webSendDeadline(t, start, now), now + NOTICE_MAX_QUEUE_MS, t);
  assert.equal(NOTICE_MAX_QUEUE_MS, 30 * 60_000);
  // The booking-request messages: the accepted one (it carries the payment link) lives until the time to pay ends; declined and expired for 6 hours.
  const payBy = now + 20 * 3_600_000;
  assert.equal(webSendDeadline("request-approved", start, now, payBy), payBy);
  assert.equal(webSendDeadline("request-approved", start, now), now + NOTICE_MAX_QUEUE_MS, "without a pay-by time it gets the ordinary 30 minutes");
  assert.equal(webSendDeadline("booking-confirmation", start, now, payBy), now + NOTICE_MAX_QUEUE_MS, "only the accepted notice reads the pay-by time");
  for (const t of ["request-declined", "request-expired"]) assert.equal(webSendDeadline(t, start, now), now + REQUEST_NOTICE_MAX_QUEUE_MS, t);
  assert.equal(REQUEST_NOTICE_MAX_QUEUE_MS, 6 * 3_600_000);
  assert.ok(isReminderTemplate("reminder-15m") && isReminderTemplate("reminder-24h") && !isReminderTemplate("reschedule"));
});

test("100 sends queued at once: only the few that fit in the expected wait are accepted, the rest are refused AT ONCE (busy, retryable) and hold nothing", async () => {
  const s = setup();
  await open(s.transport);
  const all = Array.from({ length: 100 }, (_, i) => s.queue.enqueue(req(i + 1, { deadlineAtMs: s.clock.now() + 3_600_000 })));
  await settle();
  // The refused ones are already settled: no clock time passed, nothing slept for them.
  assert.equal(s.clock.slept.length <= 1, true, "at most the gap sleep of the accepted messages is pending");
  const accepted = Math.floor(MAX_EXPECTED_WAIT_MS / 4_000) + 1;
  const results = await s.clock.run(Promise.all(all));
  const ok = results.filter((r) => r.ok).length;
  const busy = results.filter((r) => !r.ok && r.reason === "busy" && r.retryable).length;
  assert.equal(ok, accepted, "the wait a new message may expect is capped");
  assert.equal(busy, 100 - accepted);
  assert.equal(s.transport.sent.length, accepted);
  // The whole backlog took the time of the accepted ones only (never 100 x 4 s = 400 s).
  assert.ok(s.clock.now() - Date.UTC(2026, 10, 9, 10, 0, 0) <= 4_000 * accepted);
});

test("a message that cannot be sent before its deadline is refused at once (expired), without waiting", async () => {
  const s = setup();
  await open(s.transport);
  const first = s.queue.enqueue(req(1));
  const second = s.queue.enqueue(req(2));
  const third = s.queue.enqueue(req(3, { deadlineAtMs: s.clock.now() + 5_000 })); // two gaps ahead = 8 s expected
  assert.deepEqual(await third, { ok: false, reason: "expired", retryable: false });
  await s.clock.run(Promise.all([first, second]));
  assert.equal(s.transport.sent.length, 2);
});

test("a message that was accepted but waited past its deadline is dropped immediately before the send: never sent, its place in the day given back", async () => {
  const s = setup();
  await open(s.transport);
  // The first send is slow (3 s), so the second, which looked fine when it was queued, is late when its turn comes.
  const real = s.transport.sendText.bind(s.transport);
  let slow = true;
  s.transport.sendText = async (to, text) => {
    if (slow) {
      slow = false;
      await s.clock.sleep(3_000);
    }
    return real(to, text);
  };
  const first = s.queue.enqueue(req(1));
  const second = s.queue.enqueue(req(2, { deadlineAtMs: s.clock.now() + 5_000 }));
  const [a, b] = await s.clock.run(Promise.all([first, second]));
  assert.ok(a.ok);
  assert.deepEqual(b, { ok: false, reason: "expired", retryable: false });
  assert.equal(s.transport.sent.length, 1);
  assert.equal(await today(s), 1, "only the message that went out is counted");
});

test("a booking cancelled while its message waited is not messaged: the guard is asked again right before the send", async () => {
  let calls = 0;
  const s = setup({ guard: async () => (++calls <= 2 ? true : "not-sendable") });
  await open(s.transport);
  const first = s.queue.enqueue(req(1)); // guard call 1
  const second = s.queue.enqueue(req(2)); // guard call 2 (when its turn comes), then call 3 after the wait
  const [a, b] = await s.clock.run(Promise.all([first, second]));
  assert.ok(a.ok);
  assert.deepEqual(b, { ok: false, reason: "not-sendable", retryable: false });
  assert.equal(s.transport.sent.length, 1);
  assert.equal(await today(s), 1);
  assert.deepEqual(s.guardCalls.map((g) => g.kind), ["reminder-15m", "reminder-15m", "reminder-15m"], "the message kind reaches the guard");
});

test("a message that did not have to wait asks the guard once", async () => {
  const s = setup();
  await open(s.transport);
  assert.ok((await s.clock.run(s.queue.enqueue(req(1)))).ok);
  assert.equal(s.guardCalls.length, 1);
});

test("one influencer's backlog does not touch another's: each number has its own queue, cap and clock of gaps", async () => {
  const h = harness();
  for (const id of ["inf-x", "inf-y"]) {
    want(h, id);
  }
  await h.tick();
  for (const id of ["inf-x", "inf-y"]) {
    const t = h.last(id);
    t.emitQr("SECRET");
    await settle();
    t.emitOpen({ phoneE164: "+919876500001", deviceLabel: null });
  }
  await settle();
  const msg = (inf: string, n: number) => ({ influencerId: inf, toE164: "+919876500010", text: `m${n}`, bookingId: `b${n}`, key: `${inf}:${n}`, kind: "reminder-15m" });
  // inf-x floods its number: the per-session cap lets MAX_JOBS_PER_SESSION jobs wait, every other one is refused at once.
  const flood = Array.from({ length: 30 }, (_, i) => h.manager.send(msg("inf-x", i)));
  const other = h.manager.send(msg("inf-y", 1));
  await settle();
  const refusedAtOnce = (await Promise.race([Promise.all(flood.slice(MAX_JOBS_PER_SESSION)), settle(50).then(() => null)])) as { ok: boolean; reason?: string; retryable?: boolean }[] | null;
  assert.ok(refusedAtOnce, "the extra jobs were answered without the clock moving");
  assert.ok(refusedAtOnce.every((r) => !r.ok && r.reason === "busy" && r.retryable));
  const results = await h.clock.run(Promise.all([...flood.slice(0, MAX_JOBS_PER_SESSION), other]));
  assert.ok(results.every((r) => r.ok), JSON.stringify(results));
  assert.equal(h.last("inf-y").sent.length, 1, "the other influencer's message went out through its own number");
  assert.equal(h.last("inf-x").sent.length, MAX_JOBS_PER_SESSION);
  // The slots are given back: a later job is accepted again.
  assert.ok((await h.clock.run(h.manager.send(msg("inf-x", 99)))).ok);
  await h.manager.shutdown();
});

test("a refund goes back to the day the place was taken on, even when the wait crossed midnight (India time)", async () => {
  const clock = new ManualClock(Date.UTC(2026, 10, 9, 18, 29, 58)); // two seconds before midnight in India
  const kv = new MemoryKv(clock.now);
  const transport = new FakeTransport(INF, { autoConnect: false, log: () => {} });
  const queue = new SendQueue({ influencerId: INF, transport: () => transport, kv, clock, minGapMs: 4_000, dailyCap: 1_000, guard: async () => true });
  await open(transport);
  const day1 = kvKeys.sent(INF, "2026-11-09");
  const day2 = kvKeys.sent(INF, "2026-11-10");
  const real = transport.sendText.bind(transport);
  let n = 0;
  transport.sendText = async (to, text) => {
    if (n++ === 0) return real(to, text);
    throw new Error("boom"); // the SECOND send fails
  };
  const [a, b] = await clock.run(Promise.all([queue.enqueue(req(1)), queue.enqueue(req(2))]));
  assert.ok(a.ok && !b.ok);
  assert.equal(istDate(clock.now()), "2026-11-10", "the wait crossed midnight");
  assert.equal(await kv.getInt(day1), 1, "the failed message was taken off the day it was counted on");
  assert.equal(await kv.getInt(day2), 0);
});
