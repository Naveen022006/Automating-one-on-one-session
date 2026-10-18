import assert from "node:assert/strict";
import { test } from "node:test";
import { baileysAvailable, BaileysTransport, mapDisconnect, mapStatus, type BaileysModule } from "../lib/whatsapp-web/baileys-transport";
import { WhatsAppWebTransportError, type WhatsAppAuthStore, type WhatsAppWebCloseInfo, type WhatsAppWebTransportEvents } from "../lib/whatsapp-web/transport";

// The adapter against a stand-in for the library: no socket is opened and nothing touches the network.

const DisconnectReason = {
  connectionClosed: 428,
  connectionLost: 408,
  connectionReplaced: 440,
  timedOut: 408,
  loggedOut: 401,
  badSession: 500,
  restartRequired: 515,
  multideviceMismatch: 411,
  forbidden: 403,
  unavailableService: 503,
} as const;

type Handler = (payload: never) => void;

function fakeLibrary() {
  const handlers = new Map<string, Handler[]>();
  const calls: string[] = [];
  const sock = {
    ev: {
      on: (name: string, fn: Handler) => {
        handlers.set(name, [...(handlers.get(name) ?? []), fn]);
      },
    },
    user: undefined as { id: string } | undefined,
    onWhatsApp: async (...numbers: string[]) => {
      calls.push(`onWhatsApp:${numbers.join(",")}`);
      return numbers.map((n) => ({ jid: `${n.replace("+", "")}@s.whatsapp.net`, exists: !n.endsWith("0000") }));
    },
    sendMessage: async (jid: string, content: unknown) => {
      calls.push(`sendMessage:${jid}:${JSON.stringify(content)}`);
      return { key: { id: `WAMID-${calls.length}`, fromMe: true }, message: { conversation: "x" } };
    },
    logout: async (msg?: string) => void calls.push(`logout:${msg ?? ""}`),
    end: async () => void calls.push("end"),
  };
  const captured: { config?: Record<string, unknown> } = {};
  const lib = {
    makeWASocket: (config: Record<string, unknown>) => {
      captured.config = config;
      return sock;
    },
    initAuthCreds: () => ({ fresh: true } as Record<string, unknown>),
    proto: { Message: { AppStateSyncKeyData: { fromObject: (o: object) => ({ ...o, wrapped: true }) } } },
    DisconnectReason,
    jidDecode: (jid: string) => ({ user: jid.split(":")[0].split("@")[0] }),
    DEFAULT_CONNECTION_CONFIG: { browser: ["Mac OS", "Chrome", "14.4.1"] },
  };
  const emit = (name: string, payload: unknown) => {
    for (const h of handlers.get(name) ?? []) h(payload as never);
  };
  return { lib: lib as unknown as BaileysModule, sock, captured, handlers, emit, calls };
}

function memoryAuth(initial?: unknown) {
  const state = { creds: initial as unknown, keys: {} as Record<string, Record<string, unknown>>, credSets: 0 };
  const store: WhatsAppAuthStore = {
    getCreds: () => state.creds,
    setCreds: (c) => {
      state.creds = c;
      state.credSets++;
    },
    getKeys: (type, ids) => Object.fromEntries(ids.map((id) => [id, state.keys[type]?.[id]])),
    setKeys: (data) => {
      for (const [type, entries] of Object.entries(data)) for (const [id, v] of Object.entries(entries)) (state.keys[type] ??= {})[id] = v;
    },
    clearKeys: () => (state.keys = {}),
  };
  return { state, store };
}

function recorder() {
  const log = { qr: [] as string[], open: [] as unknown[], close: [] as WhatsAppWebCloseInfo[], delivery: [] as unknown[] };
  const events: WhatsAppWebTransportEvents = {
    onQr: (q) => log.qr.push(q),
    onOpen: (i) => log.open.push(i),
    onClose: (i) => log.close.push(i),
    onDelivery: (i) => log.delivery.push(i),
  };
  return { log, events };
}

async function connected(opts: { creds?: unknown } = {}) {
  const f = fakeLibrary();
  const t = new BaileysTransport(async () => f.lib);
  const a = memoryAuth(opts.creds);
  const r = recorder();
  await t.connect(a.store, r.events);
  return { f, t, a, r };
}

async function opened(opts: { creds?: unknown } = {}) {
  const c = await connected(opts);
  c.f.sock.user = { id: "919876500001:12@s.whatsapp.net" };
  c.f.emit("connection.update", { connection: "open" });
  return c;
}

test("the socket is configured for a quiet, history-free, text-only use", async () => {
  const { f } = await connected();
  const c = f.captured.config!;
  assert.equal(c.markOnlineOnConnect, false);
  assert.equal(c.syncFullHistory, false);
  assert.equal((c.shouldSyncHistoryMessage as () => boolean)(), false, "no history is requested");
  assert.equal(c.generateHighQualityLinkPreview, false);
  assert.equal("browser" in c, false, "the library's own browser identification is kept; nothing is spoofed");
  // The library's logger is replaced by a silent one: it can print QR payloads and phone numbers.
  const logger = c.logger as { level: string; child: () => unknown; info: (...a: unknown[]) => void };
  assert.equal(logger.level, "silent");
  assert.equal(logger.child(), logger);
  assert.doesNotThrow(() => logger.info({ qr: "x" }, "nothing is printed"));
});

test("it listens to the connection, the credentials and the state of OUR messages, and to nothing else", async () => {
  const { f } = await connected();
  assert.deepEqual([...f.handlers.keys()].sort(), ["connection.update", "creds.update", "messages.update"]);
  assert.ok(![...f.handlers.keys()].some((n) => /messages\.upsert|chats|contacts|history|groups|presence|call/.test(n)));
});

test("credentials: fresh ones are created in memory and only kept once a device is linked", async () => {
  const { f, a } = await connected();
  const creds = f.captured.config!.auth as { creds: Record<string, unknown> };
  assert.deepEqual(creds.creds, { fresh: true });
  assert.equal(a.state.credSets, 0, "an unfinished scan leaves nothing behind");
  f.emit("creds.update", {});
  assert.equal(a.state.credSets, 0);
  (creds.creds as Record<string, unknown>).me = { id: "919876500001:12@s.whatsapp.net" }; // what the library does when pairing succeeds
  f.emit("creds.update", {});
  assert.equal(a.state.credSets, 1);
  assert.equal(a.state.creds, creds.creds);

  // A stored login is used as it is.
  const stored = { me: { id: "x" }, registered: true };
  const again = await connected({ creds: stored });
  assert.equal((again.f.captured.config!.auth as { creds: unknown }).creds, stored);
});

test("the Signal key store is backed by the encrypted auth store; app-state keys are rebuilt into the library's type", async () => {
  const { f, a } = await connected();
  const keys = (f.captured.config!.auth as { keys: { get: Function; set: Function; clear: Function } }).keys;
  await keys.set({ session: { "p.1": new Uint8Array([1]) }, "app-state-sync-key": { k1: { keyData: "abc" } } });
  assert.deepEqual(Object.keys(a.state.keys), ["session", "app-state-sync-key"]);
  assert.deepEqual(await keys.get("session", ["p.1", "missing"]), { "p.1": new Uint8Array([1]), missing: undefined });
  assert.deepEqual(await keys.get("app-state-sync-key", ["k1"]), { k1: { keyData: "abc", wrapped: true } });
  await keys.set({ session: { "p.1": null } });
  assert.equal(a.state.keys.session["p.1"], null);
  await keys.clear();
  assert.deepEqual(a.state.keys, {});
});

test("events: a QR code, the connection opening (with the linked number) and closing", async () => {
  const { f, a, r } = await connected();
  f.emit("connection.update", { qr: "2@qr-payload" });
  assert.deepEqual(r.log.qr, ["2@qr-payload"]);
  (f.captured.config!.auth as { creds: Record<string, unknown> }).creds.me = { id: "919876500001:12@s.whatsapp.net" };
  f.sock.user = { id: "919876500001:12@s.whatsapp.net" };
  f.emit("connection.update", { connection: "open" });
  assert.deepEqual(r.log.open, [{ phoneE164: "+919876500001", deviceLabel: "Chrome (Mac OS)" }]);
  assert.equal(a.state.credSets, 1, "the credentials are stored when the device is linked");
  f.emit("connection.update", { connection: "close", lastDisconnect: { error: { output: { statusCode: 401 } } } });
  assert.deepEqual(r.log.close, [{ reason: "logged-out", code: "logged-out" }]);
});

test("close reasons map onto the neutral reasons", () => {
  const cases: [number | undefined, WhatsAppWebCloseInfo][] = [
    [401, { reason: "logged-out", code: "logged-out" }],
    [500, { reason: "logged-out", code: "bad-session" }],
    [403, { reason: "restricted", code: "forbidden" }],
    [515, { reason: "transient", code: "restart-required" }],
    [440, { reason: "transient", code: "replaced" }],
    [411, { reason: "transient", code: "multidevice-mismatch" }],
    [503, { reason: "transient", code: "unavailable" }],
    [408, { reason: "transient", code: "timed-out" }],
    [428, { reason: "transient", code: "connection-closed" }],
    [undefined, { reason: "transient", code: "closed" }],
    [999, { reason: "transient", code: "closed" }],
  ];
  for (const [code, expected] of cases) assert.deepEqual(mapDisconnect(code, DisconnectReason as never), expected, String(code));
  assert.deepEqual([0, 1, 2, 3, 4, 5, 9].map((s) => mapStatus(s)), ["failed", null, "sent", "delivered", "read", "read", null]);
});

test("delivery: only the state of messages we sent is reported; incoming traffic is ignored", async () => {
  const { f, t, r } = await opened();
  const sent = await t.sendText("+919876500002", "hello");
  const id = sent.providerMessageId;
  f.emit("messages.update", [
    { key: { id, fromMe: true }, update: { status: 3 } },
    { key: { id: "SOMEONE-ELSES", fromMe: false }, update: { status: 3 } }, // incoming: ignored
    { key: { id: "UNKNOWN", fromMe: true }, update: { status: 3 } }, // not one of ours
    { key: { id, fromMe: true }, update: { status: 4 } },
    { key: { id, fromMe: true }, update: { status: 1 } }, // pending: nothing to say
  ]);
  assert.deepEqual(r.log.delivery, [
    { providerMessageId: id, status: "delivered" },
    { providerMessageId: id, status: "read" },
  ]);
});

test("sending: nothing before the connection is open; then a plain text message; the number is checked with the library's own lookup", async () => {
  const { f, t } = await connected();
  await assert.rejects(t.sendText("+919876500002", "hi"), (e: unknown) => e instanceof WhatsAppWebTransportError && e.code === "not-connected" && e.retryable);
  await assert.rejects(t.numberExists("+919876500002"), (e: unknown) => e instanceof WhatsAppWebTransportError && e.code === "not-connected");
  f.sock.user = { id: "919876500001:12@s.whatsapp.net" };
  f.emit("connection.update", { connection: "open" });

  assert.equal(await t.numberExists("+919876500002"), true);
  assert.equal(await t.numberExists("+919876500000"), false);
  assert.ok(f.calls.includes("onWhatsApp:+919876500002"));
  const sent = await t.sendText("+919876500002", "Your session is confirmed");
  assert.match(sent.providerMessageId, /^WAMID-/);
  const send = f.calls.find((c) => c.startsWith("sendMessage:"))!;
  assert.equal(send, 'sendMessage:919876500002@s.whatsapp.net:{"text":"Your session is confirmed"}', "plain text only, to the number's own address");
  // Only the library's calls are made: no presence, typing or read-receipt call exists in the fake, so one would have thrown.
  assert.deepEqual(f.calls.filter((c) => !/^(onWhatsApp|sendMessage)/.test(c)), []);

  await assert.rejects(t.sendText("not-a-number", "x"), (e: unknown) => e instanceof WhatsAppWebTransportError && e.code === "invalid-number" && !e.retryable);
});

test("a failure from the library is reported with a code only, never with the destination", async () => {
  const { f, t } = await opened();
  f.sock.sendMessage = async () => {
    throw new Error("could not deliver to 919876500002@s.whatsapp.net");
  };
  await assert.rejects(t.sendText("+919876500002", "hi"), (e: unknown) => {
    assert.ok(e instanceof WhatsAppWebTransportError);
    assert.equal(e.code, "send-failed");
    assert.ok(!e.message.includes("919876500002"), e.message);
    return true;
  });
  f.sock.sendMessage = async () => {
    throw Object.assign(new Error("Connection Closed"), { output: { statusCode: 428 } });
  };
  await assert.rejects(t.sendText("+919876500002", "hi"), (e: unknown) => e instanceof WhatsAppWebTransportError && e.code === "not-connected");
  f.sock.sendMessage = async () => undefined as never;
  await assert.rejects(t.sendText("+919876500002", "hi"), (e: unknown) => e instanceof WhatsAppWebTransportError && e.code === "no-message-id");
});

test("logout unlinks on the phone's side then closes; end is safe twice; nothing is reported after it", async () => {
  const { f, t, r } = await opened();
  await t.logout();
  assert.deepEqual(f.calls.filter((c) => c === "end" || c.startsWith("logout")), ["logout:unlinked from the dashboard", "end"]);
  await t.end();
  assert.equal(f.calls.filter((c) => c === "end").length, 1, "end() once");
  f.emit("connection.update", { connection: "close", lastDisconnect: { error: { output: { statusCode: 401 } } } });
  f.emit("connection.update", { qr: "late" });
  assert.deepEqual(r.log.close, []);
  assert.deepEqual(r.log.qr, []);
  await assert.rejects(t.sendText("+919876500002", "hi"), (e: unknown) => e instanceof WhatsAppWebTransportError && e.code === "not-connected");
});

test("logout still closes when the phone side is already gone", async () => {
  const { f, t } = await opened();
  f.sock.logout = async () => {
    throw new Error("socket closed");
  };
  await t.logout();
  assert.ok(f.calls.includes("end"));
});

test("baileysAvailable says whether the library loads", async () => {
  assert.equal(await baileysAvailable(async () => fakeLibrary().lib), true);
  assert.equal(await baileysAvailable(async () => ({}) as BaileysModule), false);
  assert.equal(await baileysAvailable(async () => Promise.reject(new Error("Cannot find package"))), false);
});

test("the pinned library really exposes everything the adapter relies on (it is loaded, no socket is opened)", async () => {
  const lib = await import("@whiskeysockets/baileys");
  assert.equal(typeof lib.makeWASocket, "function");
  assert.equal(typeof lib.initAuthCreds, "function");
  assert.equal(typeof lib.jidDecode, "function");
  assert.equal(typeof lib.proto.Message.AppStateSyncKeyData.fromObject, "function");
  assert.ok(Array.isArray(lib.DEFAULT_CONNECTION_CONFIG.browser));
  for (const [name, code] of Object.entries(DisconnectReason)) assert.equal((lib.DisconnectReason as unknown as Record<string, number>)[name], code, name);
  const creds = lib.initAuthCreds();
  assert.equal(creds.registered, false, "a fresh login is not registered");
  assert.equal(creds.me, undefined, "and has no device, so nothing is kept for an unfinished scan");
  assert.deepEqual(lib.jidDecode("919876500001:12@s.whatsapp.net")?.user, "919876500001");
  assert.equal(await baileysAvailable(), true);
});
