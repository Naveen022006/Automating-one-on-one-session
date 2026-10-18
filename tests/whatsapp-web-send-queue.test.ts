import assert from "node:assert/strict";
import { test } from "node:test";
import { FakeTransport } from "../lib/whatsapp-web/fake-transport";
import { istDate, kvKeys, MemoryKv } from "../lib/whatsapp-web/kv";
import { SendQueue, type QueuedSend, type SendQueueDeps } from "../lib/whatsapp-web/send-queue";
import { WhatsAppWebTransportError } from "../lib/whatsapp-web/transport";
import { ManualClock, settle } from "./helpers/whatsapp-web";

// Pure tests: a fake transport, an in-memory counter store and a clock the test moves by hand. No network, no database.

const INF = "inf-queue";
const A = "+919876500001";
const B = "+919876500002";

function setup(over: Partial<SendQueueDeps> = {}) {
  const clock = new ManualClock();
  const kv = new MemoryKv(clock.now);
  const transport = new FakeTransport(INF, { autoConnect: false, log: () => {} });
  const trips: string[] = [];
  const failureCounts: number[] = [];
  const sentIds: string[] = [];
  const errors: string[] = [];
  let guardAllows = true;
  const guardCalls: QueuedSend[] = [];
  const queue = new SendQueue({
    influencerId: INF,
    transport: () => (current.t ? transport : null),
    kv,
    clock,
    minGapMs: 4_000,
    dailyCap: 150,
    guard: async (req) => (guardCalls.push(req), guardAllows),
    onSent: ({ providerMessageId }) => void sentIds.push(providerMessageId),
    onFailureCount: (n) => void failureCounts.push(n),
    onTrip: (reason) => void trips.push(reason),
    onError: ({ code }) => void errors.push(code),
    ...over,
  });
  const current = { t: true };
  return { clock, kv, transport, queue, trips, failureCounts, sentIds, errors, guardCalls, current, allow: (v: boolean) => (guardAllows = v) };
}

async function open(t: FakeTransport) {
  await t.connect({ getCreds: () => undefined, setCreds() {}, getKeys: () => ({}), setKeys() {}, clearKeys() {} }, { onQr() {}, onOpen() {}, onClose() {}, onDelivery() {} });
  t.emitOpen();
}

const req = (n: number, to = A, over: Partial<QueuedSend> = {}): QueuedSend => ({ toE164: to, text: `message ${n}`, bookingId: `bk-${n}`, key: `bk-${n}:confirmation`, ...over });

test("messages go out one at a time, first in first out, at least the fixed gap apart", async () => {
  const s = setup();
  await open(s.transport);
  const times: number[] = [];
  const realSend = s.transport.sendText.bind(s.transport);
  s.transport.sendText = async (to, text) => (times.push(s.clock.now()), realSend(to, text));
  const results = await s.clock.run(Promise.all([1, 2, 3].map((n) => s.queue.enqueue(req(n)))));
  assert.ok(results.every((r) => r.ok), JSON.stringify(results));
  assert.deepEqual(s.transport.sent.map((m) => m.text), ["message 1", "message 2", "message 3"], "FIFO");
  assert.equal(times.length, 3);
  assert.ok(times[1] - times[0] >= 4_000 && times[2] - times[1] >= 4_000, `gaps: ${times[1] - times[0]}, ${times[2] - times[1]}`);
  assert.deepEqual([times[1] - times[0], times[2] - times[1]], [4_000, 4_000], "a fixed gap, no randomness");
  assert.equal(s.sentIds.length, 3);
});

test("the gap is the same every time (no jitter): five sends, five identical gaps", async () => {
  const s = setup();
  await open(s.transport);
  const times: number[] = [];
  const realSend = s.transport.sendText.bind(s.transport);
  s.transport.sendText = async (to, text) => (times.push(s.clock.now()), realSend(to, text));
  await s.clock.run(Promise.all([1, 2, 3, 4, 5].map((n) => s.queue.enqueue(req(n)))));
  const gaps = times.slice(1).map((t, i) => t - times[i]);
  assert.deepEqual(gaps, [4_000, 4_000, 4_000, 4_000]);
});

test("the daily cap counts per Indian calendar day and refuses without retry advice", async () => {
  const s = setup({ dailyCap: 3, minGapMs: 1_000 });
  await open(s.transport);
  const results = await s.clock.run(Promise.all([1, 2, 3, 4, 5].map((n) => s.queue.enqueue(req(n)))));
  assert.deepEqual(results.map((r) => r.ok), [true, true, true, false, false]);
  const refused = results[3];
  assert.ok(!refused.ok && refused.reason === "daily-cap" && refused.retryable === false);
  assert.equal(s.transport.sent.length, 3);
  const today = istDate(s.clock.now());
  assert.equal(await s.kv.getInt(kvKeys.sent(INF, today)), 3, "refused attempts are given back");

  // Next Indian day (IST midnight = 18:30 UTC): the count starts again.
  const nextMidnightUtc = Date.UTC(2026, 10, 9, 18, 30, 0);
  await s.clock.advance(nextMidnightUtc - s.clock.now() + 1_000);
  assert.notEqual(istDate(s.clock.now()), today);
  const again = await s.clock.run(s.queue.enqueue(req(9)));
  assert.ok(again.ok);
});

test("the IST date rolls over at 18:30 UTC", () => {
  assert.equal(istDate(Date.UTC(2026, 10, 9, 18, 29, 59)), "2026-11-09");
  assert.equal(istDate(Date.UTC(2026, 10, 9, 18, 30, 0)), "2026-11-10");
  assert.equal(istDate(Date.UTC(2026, 11, 31, 20, 0, 0)), "2027-01-01");
});

test("a number is checked once before the first message to it, and the answer is remembered", async () => {
  const s = setup({ minGapMs: 1_000 });
  await open(s.transport);
  await s.clock.run(Promise.all([s.queue.enqueue(req(1, A)), s.queue.enqueue(req(2, A)), s.queue.enqueue(req(3, B))]));
  assert.deepEqual(s.transport.existsChecks, [A, B], "A once, B once");
  assert.equal(s.transport.sent.length, 3);
  // Order of calls for the first message: the check comes before the send.
  assert.deepEqual(s.transport.calls.filter((c) => c !== "connect").slice(0, 2), ["numberExists", "sendText"]);
});

test("a number that is not on WhatsApp is not messaged, is not a failure, and does not use up the day", async () => {
  const s = setup({ minGapMs: 1_000 });
  await open(s.transport);
  s.transport.exists = (e164) => e164 !== B;
  const [ok, no, no2] = await s.clock.run(Promise.all([s.queue.enqueue(req(1, A)), s.queue.enqueue(req(2, B)), s.queue.enqueue(req(3, B))]));
  assert.ok(ok.ok);
  assert.ok(!no.ok && no.reason === "not-on-whatsapp" && no.retryable === false);
  assert.ok(!no2.ok && no2.reason === "not-on-whatsapp");
  assert.deepEqual(s.transport.sent.map((m) => m.to), [A]);
  assert.deepEqual(s.transport.existsChecks, [A, B], "the negative answer is remembered too");
  assert.equal(s.queue.consecutiveFailures, 0);
  assert.equal(await s.kv.getInt(kvKeys.sent(INF, istDate(s.clock.now()))), 1, "only the real send counts");
});

test("only booking messages: no real booking for this number means no message and no contact with WhatsApp at all", async () => {
  const s = setup();
  await open(s.transport);
  s.allow(false);
  const r = await s.clock.run(s.queue.enqueue(req(1)));
  assert.ok(!r.ok && r.reason === "no-booking" && r.retryable === false);
  assert.deepEqual(s.transport.calls.filter((c) => c !== "connect"), [], "not even an existence check");
  assert.deepEqual(s.guardCalls.map((g) => [g.bookingId, g.toE164]), [["bk-1", A]]);
  assert.equal(await s.kv.getInt(kvKeys.sent(INF, istDate(s.clock.now()))), 0);
});

test("bad requests are refused before they are queued", async () => {
  const s = setup();
  await open(s.transport);
  const bad = async (patch: Partial<QueuedSend>, reason: string) => {
    const r = await s.queue.enqueue({ ...req(1), ...patch });
    assert.ok(!r.ok && r.reason === reason && r.retryable === false, `${reason}: ${JSON.stringify(r)}`);
  };
  await bad({ toE164: "9876500001" }, "invalid-number");
  await bad({ toE164: "+0123456789" }, "invalid-number");
  await bad({ toE164: "+91987" }, "invalid-number");
  await bad({ text: "   " }, "empty-text");
  await bad({ bookingId: "" }, "missing-booking");
  await bad({ key: "" }, "missing-booking");
  assert.equal(s.guardCalls.length, 0);
});

test("the same key is sent once: a repeat while queued, or after success, gets the first result", async () => {
  const s = setup();
  await open(s.transport);
  const p1 = s.queue.enqueue(req(1));
  const p2 = s.queue.enqueue(req(1));
  const [r1, r2] = await s.clock.run(Promise.all([p1, p2]));
  assert.deepEqual(r1, r2);
  assert.equal(s.transport.sent.length, 1);
  const r3 = await s.queue.enqueue(req(1));
  assert.deepEqual(r3, r1);
  assert.equal(s.transport.sent.length, 1, "a retried job does not send twice");
  // A failed attempt is not remembered as done: the retry really tries again.
  s.transport.failSendWith(new WhatsAppWebTransportError("x", "send-failed", true));
  const f = await s.clock.run(s.queue.enqueue(req(2)));
  assert.ok(!f.ok);
  const retry = await s.clock.run(s.queue.enqueue(req(2)));
  assert.ok(retry.ok);
});

test("the circuit breaker opens after three failed sends in a row and stops everything at once", async () => {
  const s = setup({ minGapMs: 1_000 });
  await open(s.transport);
  const err = () => new WhatsAppWebTransportError("boom", "send-failed", true);
  s.transport.failSendWith(err(), err(), err());
  const results = await s.clock.run(Promise.all([1, 2, 3, 4, 5].map((n) => s.queue.enqueue(req(n)))));
  assert.deepEqual(results.map((r) => (r.ok ? "ok" : r.reason)), ["send-failed", "send-failed", "circuit-open", "circuit-open", "circuit-open"]);
  assert.ok(results.slice(2).every((r) => !r.ok && r.retryable === false), "no retry advice: the caller falls back at once");
  assert.deepEqual(s.trips, ["3-failed-sends"], "tripped exactly once");
  assert.equal(s.queue.tripped, true);
  assert.deepEqual(s.failureCounts, [1, 2, 3]);
  assert.equal(s.transport.sent.length, 0);
  // From now on nothing is even queued.
  const later = await s.queue.enqueue(req(6));
  assert.ok(!later.ok && later.reason === "circuit-open" && !later.retryable);
});

test("a success in between resets the failure count; a dropped connection is not a failed send", async () => {
  const s = setup({ minGapMs: 1_000 });
  await open(s.transport);
  const err = () => new WhatsAppWebTransportError("boom", "send-failed", true);
  s.transport.failSendWith(err(), err());
  const out = await s.clock.run(Promise.all([1, 2, 3].map((n) => s.queue.enqueue(req(n)))));
  assert.deepEqual(out.map((r) => r.ok), [false, false, true]);
  assert.equal(s.queue.consecutiveFailures, 0, "reset by the success");
  s.transport.failSendWith(new WhatsAppWebTransportError("down", "not-connected", true), new WhatsAppWebTransportError("down", "not-connected", true), new WhatsAppWebTransportError("down", "not-connected", true));
  const dropped = await s.clock.run(Promise.all([4, 5, 6].map((n) => s.queue.enqueue(req(n)))));
  assert.ok(dropped.every((r) => !r.ok && r.reason === "not-connected" && r.retryable));
  assert.equal(s.queue.tripped, false);
  assert.deepEqual(s.trips, []);
});

test("a failing existence check counts as a failure too", async () => {
  const s = setup({ minGapMs: 1_000, breakerThreshold: 2 });
  await open(s.transport);
  s.transport.exists = () => {
    throw new Error("usync failed");
  };
  const out = await s.clock.run(Promise.all([1, 2, 3].map((n) => s.queue.enqueue(req(n, `+91987650000${n}`)))));
  assert.deepEqual(out.map((r) => (r.ok ? "ok" : r.reason)), ["send-failed", "circuit-open", "circuit-open"]);
  assert.deepEqual(s.trips, ["2-failed-sends"]);
});

test("while the number is not connected nothing waits: the answer is immediate and retryable", async () => {
  const s = setup();
  s.current.t = false;
  const r = await s.queue.enqueue(req(1));
  assert.ok(!r.ok && r.reason === "not-connected" && r.retryable === true);
  assert.equal(s.guardCalls.length, 0);
});

test("stop() answers everything still waiting with a retryable refusal", async () => {
  const s = setup({ minGapMs: 60_000 });
  await open(s.transport);
  const first = s.queue.enqueue(req(1));
  await settle();
  const second = s.queue.enqueue(req(2));
  const third = s.queue.enqueue(req(3));
  await s.clock.advance(100);
  s.queue.stop();
  const results = await s.clock.run(Promise.all([first, second, third]));
  assert.ok(results[0].ok, "the one already sending finishes");
  for (const r of results.slice(1)) assert.ok(!r.ok && r.reason === "not-connected" && r.retryable);
  assert.equal(s.transport.sent.length, 1);
  assert.equal((await s.queue.enqueue(req(4))).ok, false);
});

test("a counter store that is down refuses with retry advice instead of sending past the limit", async () => {
  const kv = new MemoryKv();
  kv.incr = async () => {
    throw new Error("redis down");
  };
  const s = setup({ kv });
  await open(s.transport);
  const r = await s.queue.enqueue(req(1));
  assert.ok(!r.ok && r.reason === "limits-unavailable" && r.retryable);
  assert.equal(s.transport.sent.length, 0);
});

test("a booking check that cannot be made refuses with retry advice (the message is never sent unchecked)", async () => {
  const s = setup({ guard: async () => Promise.reject(new Error("db down")) });
  await open(s.transport);
  const r = await s.queue.enqueue(req(1));
  assert.ok(!r.ok && r.reason === "guard-unavailable" && r.retryable);
  assert.equal(s.transport.sent.length, 0);
});

test("a send that never answers is given up after the call timeout", async () => {
  const s = setup({ callTimeoutMs: 50, minGapMs: 1_000 });
  await open(s.transport);
  s.transport.sendText = () => new Promise(() => {});
  const r = await s.queue.enqueue(req(1));
  assert.ok(!r.ok && r.reason === "send-failed" && r.retryable);
  assert.equal(s.queue.consecutiveFailures, 1);
});
