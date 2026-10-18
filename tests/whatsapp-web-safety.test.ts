import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { BaileysTransport, type BaileysModule } from "../lib/whatsapp-web/baileys-transport";
import { describeError, safely, safeEvents } from "../lib/whatsapp-web/safe";
import type { WhatsAppAuthStore, WhatsAppWebTransportEvents } from "../lib/whatsapp-web/transport";
import { installProcessGuards } from "../worker/process-guards";
import { settle } from "./helpers/whatsapp-web";

// Containment of errors from the WhatsApp library and a process-level net for the worker. Pure: a stand-in library, a stand-in process.

const SECRET = "+919999988888 hello secret text";

test("describeError gives the error's name (and a numeric status), never its message", () => {
  assert.equal(describeError(new TypeError(SECRET)), "TypeError");
  assert.equal(describeError(Object.assign(new Error(SECRET), { output: { statusCode: 428 } })), "Error (status 428)");
  assert.equal(describeError(Object.assign(new Error("x"), { output: { statusCode: "428; drop table" } })), "Error");
  assert.equal(describeError(SECRET), "string");
  assert.equal(describeError(undefined), "undefined");
});

test("safely: a throw, a rejection and a throwing error handler never escape", async () => {
  const seen: unknown[] = [];
  const sync = safely(() => {
    throw new Error("sync");
  }, (e) => seen.push(e));
  const async_ = safely(async () => {
    throw new Error("async");
  }, (e) => seen.push(e));
  const broken = safely(() => {
    throw new Error("x");
  }, () => {
    throw new Error("the logger is broken too");
  });
  assert.equal(sync(), undefined);
  assert.equal(async_(), undefined);
  assert.equal(broken(), undefined);
  await settle();
  assert.deepEqual(seen.map((e) => (e as Error).message), ["sync", "async"]);
  const ok = safely((a: number, b: number) => seen.push(a + b), () => assert.fail("no error here"));
  ok(1, 2);
  assert.equal(seen.at(-1), 3, "arguments pass through");
});

test("the process net: an unhandled rejection is one line with the error name and the worker keeps running; an uncaught exception is only observed", () => {
  const proc = new EventEmitter();
  const lines: string[] = [];
  installProcessGuards(proc as never, (l) => lines.push(l));
  assert.equal(proc.listenerCount("unhandledRejection"), 1);
  assert.equal(proc.listenerCount("uncaughtException"), 0, "Node's default (the process exits) is not replaced");
  assert.equal(proc.listenerCount("uncaughtExceptionMonitor"), 1);
  proc.emit("unhandledRejection", new RangeError(SECRET), Promise.resolve());
  proc.emit("uncaughtExceptionMonitor", new TypeError(SECRET), "uncaughtException");
  assert.equal(lines.length, 2);
  assert.match(lines[0], /unhandled promise rejection \(RangeError\); continuing/);
  assert.match(lines[1], /uncaught exception \(TypeError, uncaughtException\); the process will exit/);
  assert.ok(!lines.join("\n").includes("9999"), "no message text or number in the log");
});

test("installing the net on the real process adds listeners for those two events only", () => {
  const before = { rej: process.listenerCount("unhandledRejection"), exc: process.listenerCount("uncaughtException"), mon: process.listenerCount("uncaughtExceptionMonitor") };
  const uninstall = installProcessGuards(process, () => {});
  assert.equal(process.listenerCount("unhandledRejection"), before.rej + 1);
  assert.equal(process.listenerCount("uncaughtExceptionMonitor"), before.mon + 1);
  assert.equal(process.listenerCount("uncaughtException"), before.exc);
  uninstall();
  assert.equal(process.listenerCount("unhandledRejection"), before.rej);
  assert.equal(process.listenerCount("uncaughtExceptionMonitor"), before.mon);
});

// ---- the adapter ---------------------------------------------------------------------------------------------------------------

type Handler = (payload: never) => void;

function fakeLibrary() {
  const handlers = new Map<string, Handler[]>();
  let keys: { get: (t: string, ids: string[]) => Promise<unknown>; set: (d: unknown) => Promise<void> } | null = null;
  const sock = {
    ev: { on: (name: string, fn: Handler) => void handlers.set(name, [...(handlers.get(name) ?? []), fn]) },
    user: undefined as { id: string } | undefined,
    end: async () => {},
  };
  const lib = {
    makeWASocket: (config: { auth: { keys: typeof keys } }) => ((keys = config.auth.keys), sock),
    initAuthCreds: () => ({ me: { id: "x" } }),
    proto: { Message: { AppStateSyncKeyData: { fromObject: (o: object) => o } } },
    DisconnectReason: { loggedOut: 401, badSession: 500, forbidden: 403, restartRequired: 515, connectionReplaced: 440, multideviceMismatch: 411, unavailableService: 503, timedOut: 408, connectionClosed: 428 },
    jidDecode: (jid: string) => ({ user: jid.split(":")[0].split("@")[0] }),
    DEFAULT_CONNECTION_CONFIG: { browser: ["Mac OS", "Chrome", "14"] },
  };
  return { lib: lib as unknown as BaileysModule, sock, emit: (name: string, payload: unknown) => handlers.get(name)?.forEach((h) => h(payload as never)), keys: () => keys! };
}

const throwingEvents: WhatsAppWebTransportEvents = {
  onQr: () => {
    throw new Error(SECRET);
  },
  onOpen: async () => {
    throw new Error(SECRET);
  },
  onClose: () => {
    throw new Error(SECRET);
  },
  onDelivery: () => {
    throw new Error(SECRET);
  },
};

test("an error thrown by a callback inside the library's events becomes a log line, not an exception or a rejection", async () => {
  const f = fakeLibrary();
  const lines: string[] = [];
  const t = new BaileysTransport(async () => f.lib, (l) => lines.push(l));
  const auth: WhatsAppAuthStore = { getCreds: () => undefined, setCreds: () => { throw new Error(SECRET); }, getKeys: () => { throw new Error(SECRET); }, setKeys: () => { throw new Error(SECRET); }, clearKeys: () => { throw new Error(SECRET); } };
  const rejections: unknown[] = [];
  const onRejection = (r: unknown) => void rejections.push(r);
  process.on("unhandledRejection", onRejection);
  try {
    await t.connect(auth, throwingEvents);
    f.sock.user = { id: "919876500001:12@s.whatsapp.net" };
    assert.doesNotThrow(() => f.emit("connection.update", { qr: "QR" }));
    assert.doesNotThrow(() => f.emit("connection.update", { connection: "open" }));
    assert.doesNotThrow(() => f.emit("connection.update", { connection: "close", lastDisconnect: { error: { output: { statusCode: 401 } } } }));
    assert.doesNotThrow(() => f.emit("creds.update", {}));
    assert.doesNotThrow(() => f.emit("messages.update", [{ key: { id: "m1", fromMe: true }, update: { status: 3 } }, null]));
    // The key store the library calls: a failing store answers "nothing found" / does nothing, and does not throw into the library.
    assert.deepEqual(await f.keys().get("pre-key", ["1"]), {});
    await assert.doesNotReject(f.keys().set({ "pre-key": { 1: {} } }));
    await settle(50);
    assert.deepEqual(rejections, [], "no unhandled rejection");
    assert.ok(lines.length >= 4, lines.join("\n"));
    assert.ok(lines.every((l) => /^adapter: .+ failed \(\w+\)$/.test(l)), lines.join("\n"));
    assert.ok(!lines.join("\n").includes("9999"), "no message text or number in the log");
  } finally {
    process.off("unhandledRejection", onRejection);
  }
});

test("safeEvents wraps all four transport events", async () => {
  const errors: unknown[] = [];
  const wrapped = safeEvents(throwingEvents, (e) => errors.push(e));
  wrapped.onQr("x");
  void wrapped.onOpen({ phoneE164: "+1", deviceLabel: null });
  wrapped.onClose({ reason: "transient", code: "x" });
  wrapped.onDelivery({ providerMessageId: "m", status: "sent" });
  await settle();
  assert.equal(errors.length, 4);
});
