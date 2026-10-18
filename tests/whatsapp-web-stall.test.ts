import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { BaileysTransport, QUERY_TIMEOUT_MS, type BaileysModule } from "../lib/whatsapp-web/baileys-transport";
import { FakeTransport } from "../lib/whatsapp-web/fake-transport";
import { MemoryKv } from "../lib/whatsapp-web/kv";
import { SEND_CALL_TIMEOUT_MS, SendQueue, STALL_AFTER_UNKNOWNS, type QueuedSend } from "../lib/whatsapp-web/send-queue";
import { WhatsAppWebTransportError } from "../lib/whatsapp-web/transport";
import { harness, ManualClock, settle, want } from "./helpers/whatsapp-web";

// A send that stalls BEFORE the message is written must fail fast and go the next way; one that stalls AFTER it was handed to the
// socket is unknown; two unknowns in a row mean a half-open connection, which is reconnected. Fake transport, no network.

process.env.TOKEN_ENCRYPTION_KEY = randomBytes(32).toString("base64");
const INF = "inf-stall";
const A = "+919876500001";

const req = (n: number): QueuedSend => ({ toE164: A, text: `m${n}`, bookingId: `bk-${n}`, key: `bk-${n}:k`, kind: "booking-confirmation" });

function queueWith(over: { sendText: (t: FakeTransport) => void; callTimeoutMs?: number }) {
  const clock = new ManualClock();
  const transport = new FakeTransport(INF, { autoConnect: false, log: () => {} });
  over.sendText(transport);
  const stalls: number[] = [];
  const failureCounts: number[] = [];
  const queue = new SendQueue({
    influencerId: INF,
    transport: () => transport,
    kv: new MemoryKv(clock.now),
    clock,
    minGapMs: 0,
    dailyCap: 100,
    callTimeoutMs: over.callTimeoutMs ?? 20,
    guard: async () => true,
    onStall: () => void stalls.push(1),
    onFailureCount: (n) => void failureCounts.push(n),
  });
  return { queue, stalls, failureCounts, transport };
}

test("the adapter's query timeout is far below the queue's wait, so every step before the write fails first", () => {
  assert.equal(QUERY_TIMEOUT_MS, 10_000);
  assert.ok(QUERY_TIMEOUT_MS * 3 < SEND_CALL_TIMEOUT_MS, "device lookup + pre-key fetch + one more query all fit inside the queue's wait");
  assert.ok(QUERY_TIMEOUT_MS < SEND_CALL_TIMEOUT_MS);
});

test("the socket is created with that query timeout (the library default is 60 s)", async () => {
  let config: Record<string, unknown> = {};
  const sock = { ev: { on: () => {} }, user: undefined, end: async () => {} };
  const lib = {
    makeWASocket: (c: Record<string, unknown>) => ((config = c), sock),
    initAuthCreds: () => ({}),
    proto: { Message: { AppStateSyncKeyData: { fromObject: (o: object) => o } } },
    DisconnectReason: {},
    jidDecode: () => ({ user: "1" }),
    DEFAULT_CONNECTION_CONFIG: {},
  } as unknown as BaileysModule;
  await new BaileysTransport(async () => lib).connect({ getCreds: () => undefined, setCreds() {}, getKeys: () => ({}), setKeys() {}, clearKeys() {} }, { onQr() {}, onOpen() {}, onClose() {}, onDelivery() {} });
  assert.equal(config.defaultQueryTimeoutMs, QUERY_TIMEOUT_MS);
});

test("a query that timed out in the library (before anything was written) is 'not connected': fails fast, no unknown, no failure counted", async () => {
  const handlers = new Map<string, (p: never) => void>();
  const timedOut = Object.assign(new Error("Timed Out"), { output: { statusCode: 408 } });
  const sock = {
    ev: { on: (n: string, f: (p: never) => void) => void handlers.set(n, f) },
    user: { id: "919876500001:1@s.whatsapp.net" },
    sendMessage: async () => {
      throw timedOut;
    },
    end: async () => {},
  };
  const lib = {
    makeWASocket: () => sock,
    initAuthCreds: () => ({}),
    proto: { Message: { AppStateSyncKeyData: { fromObject: (o: object) => o } } },
    DisconnectReason: {},
    jidDecode: (jid: string) => ({ user: jid.split(":")[0] }),
    DEFAULT_CONNECTION_CONFIG: { browser: ["a", "b", "c"] },
  } as unknown as BaileysModule;
  const t = new BaileysTransport(async () => lib);
  await t.connect({ getCreds: () => undefined, setCreds() {}, getKeys: () => ({}), setKeys() {}, clearKeys() {} }, { onQr() {}, onOpen() {}, onClose() {}, onDelivery() {} });
  handlers.get("connection.update")!({ connection: "open" } as never);
  await assert.rejects(t.sendText(A, "x"), (e: unknown) => e instanceof WhatsAppWebTransportError && e.code === "not-connected" && e.retryable);

  const s = queueWith({
    sendText: (ft) => {
      ft.sendText = async () => {
        throw new WhatsAppWebTransportError("not connected", "not-connected", true);
      };
    },
  });
  await (async () => {
    const open = s.transport;
    await open.connect({ getCreds: () => undefined, setCreds() {}, getKeys: () => ({}), setKeys() {}, clearKeys() {} }, { onQr() {}, onOpen() {}, onClose() {}, onDelivery() {} });
    open.emitOpen();
  })();
  for (const n of [1, 2, 3]) {
    const r = await s.queue.enqueue(req(n));
    assert.deepEqual(r, { ok: false, reason: "not-connected", retryable: true }, "refused at once, so the message goes the next way");
  }
  assert.deepEqual(s.failureCounts, [], "not counted as a failed send");
  assert.deepEqual(s.stalls, [], "and not as an unanswered one");
});

test("a send handed to the socket that never answers is unknown (no fallback): the queue says so and keeps its place in the day", async () => {
  const s = queueWith({ sendText: (ft) => void (ft.sendText = () => new Promise(() => {})) });
  await s.transport.connect({ getCreds: () => undefined, setCreds() {}, getKeys: () => ({}), setKeys() {}, clearKeys() {} }, { onQr() {}, onOpen() {}, onClose() {}, onDelivery() {} });
  s.transport.emitOpen();
  assert.deepEqual(await s.queue.enqueue(req(1)), { ok: false, reason: "unknown-delivery", retryable: false });
  assert.deepEqual(s.stalls, [], "one unanswered send can be a slow phone");
});

test("two unknowns in a row call for a reconnect, once; an answer in between starts the count again", async () => {
  let mode: "hang" | "ok" = "hang";
  const s = queueWith({
    sendText: (ft) => {
      const real = ft.sendText.bind(ft);
      ft.sendText = (to, text) => (mode === "hang" ? new Promise(() => {}) : real(to, text));
    },
  });
  await s.transport.connect({ getCreds: () => undefined, setCreds() {}, getKeys: () => ({}), setKeys() {}, clearKeys() {} }, { onQr() {}, onOpen() {}, onClose() {}, onDelivery() {} });
  s.transport.emitOpen();
  assert.equal(STALL_AFTER_UNKNOWNS, 2);
  await s.queue.enqueue(req(1));
  mode = "ok";
  assert.ok((await s.queue.enqueue(req(2))).ok);
  mode = "hang";
  await s.queue.enqueue(req(3));
  assert.deepEqual(s.stalls, [], "the answer in between reset the count");
  await s.queue.enqueue(req(4));
  assert.deepEqual(s.stalls, [1]);
  await s.queue.enqueue(req(5));
  assert.deepEqual(s.stalls, [1], "the count restarts after a reconnect was asked for");
});

test("in the manager: two unanswered sends reconnect the number, and the next message is refused as not connected (so it goes the next way)", async () => {
  const h = harness({ config: { minGapMs: 0 }, callTimeoutMs: 20 });
  want(h, INF);
  await h.tick();
  const t = h.last(INF);
  t.emitQr("SECRET");
  await settle();
  t.emitOpen({ phoneE164: "+919876500001", deviceLabel: null });
  await settle();
  t.sendText = () => new Promise(() => {});
  const msg = (n: number) => ({ influencerId: INF, toE164: A, text: `m${n}`, bookingId: `b${n}`, key: `k${n}`, kind: "booking-confirmation" });
  assert.equal((await h.manager.send(msg(1))).ok, false);
  assert.equal(h.manager.openCount, 1, "one unanswered send does not reconnect");
  const second = await h.manager.send(msg(2));
  assert.deepEqual(second, { ok: false, reason: "unknown-delivery", retryable: false });
  await settle();
  assert.equal(h.manager.openCount, 0, "the stalled socket was closed");
  assert.equal(t.ended, true);
  assert.equal(h.repo.row(INF).status, "RECONNECTING");
  assert.ok(h.logs.some((l) => /two sends in a row got no answer; reconnecting/.test(l)));
  assert.deepEqual(await h.manager.send(msg(3)), { ok: false, reason: "not-connected", retryable: true });
  // After the backoff a fresh socket comes up from the stored login.
  await h.clock.advance(2_000);
  await h.tick();
  const fresh = h.last(INF);
  assert.notEqual(fresh, t);
  fresh.emitOpen({ phoneE164: "+919876500001", deviceLabel: null });
  await settle();
  assert.ok((await h.manager.send(msg(4))).ok);
  await h.manager.shutdown();
});
