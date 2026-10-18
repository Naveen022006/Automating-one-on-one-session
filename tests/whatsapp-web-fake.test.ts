import assert from "node:assert/strict";
import { test } from "node:test";
import { FAKE_CREDS, FakeTransport, fakePhoneFor, fakeTransportFactory } from "../lib/whatsapp-web/fake-transport";
import { EncryptedAuthState } from "../lib/whatsapp-web/auth-state";
import { WhatsAppWebTransportError, type WhatsAppAuthStore } from "../lib/whatsapp-web/transport";
import { readQrConfig } from "../lib/whatsapp-web/config";
import { harness, settle, want } from "./helpers/whatsapp-web";

// The simulator used by WHATSAPP_QR_FAKE=true: a QR string, then "connected" 12 s later, messages logged instead of sent.

/** Timers moved by hand. */
function timers() {
  let now = 0;
  let next = 1;
  const pending = new Map<number, { at: number; fn: () => void }>();
  return {
    setTimer: (fn: () => void, ms: number) => {
      const h = next++;
      pending.set(h, { at: now + ms, fn });
      return h;
    },
    clearTimer: (h: unknown) => void pending.delete(h as number),
    advance(ms: number) {
      const target = now + ms;
      for (;;) {
        const due = [...pending.entries()].filter(([, t]) => t.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        pending.delete(due[0]);
        now = due[1].at;
        due[1].fn();
      }
      now = target;
    },
    get count() {
      return pending.size;
    },
  };
}

function plainAuth(creds?: unknown): WhatsAppAuthStore & { creds: unknown; cleared: boolean } {
  const s = {
    creds,
    cleared: false,
    getCreds: () => s.creds,
    setCreds: (c: unknown) => void (s.creds = c),
    getKeys: () => ({}),
    setKeys: () => {},
    clearKeys: () => void (s.cleared = true),
  };
  return s;
}

function recorded() {
  const out = { qr: [] as string[], open: [] as { phoneE164: string; deviceLabel: string | null }[], close: 0 };
  return {
    out,
    events: { onQr: (q: string) => out.qr.push(q), onOpen: (i: { phoneE164: string; deviceLabel: string | null }) => out.open.push(i), onClose: () => void out.close++, onDelivery: () => {} },
  };
}

test("a first link: a QR string at once, a new one every 20 s, connected as a made-up number after 12 s", async () => {
  const tm = timers();
  const lines: string[] = [];
  const t = new FakeTransport("inf-fake", { log: (l) => lines.push(l), setTimer: tm.setTimer, clearTimer: tm.clearTimer });
  const auth = plainAuth();
  const r = recorded();
  await t.connect(auth, r.events);
  assert.equal(r.out.qr.length, 1);
  assert.match(r.out.qr[0], /^fake-qr:inf-fake:1$/);
  await assert.rejects(t.sendText("+919876500002", "early"), (e: unknown) => e instanceof WhatsAppWebTransportError && e.code === "not-connected");

  tm.advance(11_999);
  assert.equal(r.out.open.length, 0);
  tm.advance(1);
  assert.equal(r.out.open.length, 1, "connected at 12 s");
  assert.equal(r.out.open[0].phoneE164, fakePhoneFor("inf-fake"));
  assert.match(r.out.open[0].phoneE164, /^\+9199999\d{5}$/);
  assert.deepEqual(auth.creds, { ...FAKE_CREDS, me: { id: fakePhoneFor("inf-fake") } }, "the 'login' is remembered");
  assert.equal(fakePhoneFor("inf-fake"), fakePhoneFor("inf-fake"), "stable per influencer");
  assert.notEqual(fakePhoneFor("inf-fake"), fakePhoneFor("someone-else"));

  const sent = await t.sendText("+919876500002", "Your session is confirmed");
  assert.match(sent.providerMessageId, /^FAKE-/);
  assert.deepEqual(lines, ["[whatsapp-web:fake] would send to +919876500002: Your session is confirmed"]);
  assert.equal(await t.numberExists("+919876500002"), true);
  await t.end();
  assert.equal(tm.count, 0, "no timers left behind");
});

test("a second QR code appears when the first one is not scanned for 20 s, and stops once connected", async () => {
  const tm = timers();
  const t = new FakeTransport("inf-fake", { connectAfterMs: 50_000, log: () => {}, setTimer: tm.setTimer, clearTimer: tm.clearTimer });
  const r = recorded();
  await t.connect(plainAuth(), r.events);
  tm.advance(20_000);
  tm.advance(20_000);
  assert.deepEqual(r.out.qr, ["fake-qr:inf-fake:1", "fake-qr:inf-fake:2", "fake-qr:inf-fake:3"]);
  tm.advance(10_000);
  assert.equal(r.out.open.length, 1);
  tm.advance(100_000);
  assert.equal(r.out.qr.length, 3, "no more codes after connecting");
  await t.end();
});

test("a link made before is restored at once, without a QR code", async () => {
  const tm = timers();
  const t = new FakeTransport("inf-fake", { log: () => {}, setTimer: tm.setTimer, clearTimer: tm.clearTimer });
  const r = recorded();
  await t.connect(plainAuth({ ...FAKE_CREDS, me: { id: "x" } }), r.events);
  assert.equal(r.out.qr.length, 0);
  tm.advance(100);
  assert.equal(r.out.open.length, 1);
  await t.end();
});

test("logout forgets the keys and closes; after end nothing more happens", async () => {
  const tm = timers();
  const t = new FakeTransport("inf-fake", { log: () => {}, setTimer: tm.setTimer, clearTimer: tm.clearTimer });
  const auth = plainAuth();
  const r = recorded();
  await t.connect(auth, r.events);
  await t.logout();
  assert.equal(auth.cleared, true);
  assert.equal(t.loggedOut, true);
  tm.advance(60_000);
  assert.equal(r.out.open.length, 0, "the pending connect never fires");
});

test("scripted failures: sends can be made to fail, the existence answer can be changed", async () => {
  const t = new FakeTransport("inf-fake", { autoConnect: false, log: () => {} });
  await t.connect(plainAuth(), recorded().events);
  t.emitOpen();
  t.exists = (n) => n.endsWith("1");
  assert.equal(await t.numberExists("+919876500001"), true);
  assert.equal(await t.numberExists("+919876500002"), false);
  t.failSendWith(new Error("boom"));
  await assert.rejects(t.sendText("+919876500001", "x"), /boom/);
  assert.ok((await t.sendText("+919876500001", "x")).providerMessageId, "only the scripted number of failures");
});

test("the factory the worker uses for the simulator builds one transport per influencer", () => {
  const a = fakeTransportFactory({ influencerId: "a" });
  const b = fakeTransportFactory({ influencerId: "b" });
  assert.ok(a instanceof FakeTransport && b instanceof FakeTransport && a !== b);
});

test("the simulator is not available in production, whatever the settings", () => {
  const prod = { NODE_ENV: "production", WHATSAPP_QR_ENABLED: "true", WHATSAPP_QR_FAKE: "true", APP_URL: "http://localhost:3000" };
  assert.equal(readQrConfig(prod).fake, false);
  assert.equal(readQrConfig({ ...prod, NODE_ENV: "development" }).fake, true);
});

test("end to end in process: the simulator through the manager and the encrypted login", async () => {
  // The manager with the REAL fake transport (timers by hand), the in-memory table and an auth state encrypted like production.
  const { randomBytes } = await import("node:crypto");
  process.env.TOKEN_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  const tm = timers();
  const h = harness();
  const { WhatsAppWebManager } = await import("../worker/whatsapp-web-manager");
  const lines: string[] = [];
  const fakes: FakeTransport[] = [];
  const manager = new WhatsAppWebManager({
    config: () => h.config,
    repo: h.repo,
    kv: h.kv,
    clock: h.clock,
    transportFactory: ({ influencerId }) => {
      const t = new FakeTransport(influencerId, { log: (l) => lines.push(l), setTimer: tm.setTimer, clearTimer: tm.clearTimer });
      fakes.push(t);
      return t;
    },
    guard: async () => true,
    notify: async () => {},
    log: () => {},
  });
  want(h, "inf-sim");
  await manager.reconcile();
  await settle();
  assert.equal(h.repo.row("inf-sim").status, "PENDING_QR");
  assert.match(JSON.parse((await h.kv.get("wa-web:qr:inf-sim"))!).qr, /^fake-qr:/);
  tm.advance(12_000);
  await settle();
  assert.equal(h.repo.row("inf-sim").status, "LINKED");
  assert.equal(h.repo.row("inf-sim").phoneE164, fakePhoneFor("inf-sim"));
  assert.match(h.repo.row("inf-sim").authStateEnc!, /^v1\./);
  const sent = await h.clock.run(manager.send({ influencerId: "inf-sim", toE164: "+919876500002", text: "hello from the simulator", bookingId: "bk", key: "bk:1" }));
  assert.ok(sent.ok);
  assert.deepEqual(lines, ["[whatsapp-web:fake] would send to +919876500002: hello from the simulator"]);
  await manager.shutdown();
  // A restart restores the simulated link without a code.
  const again = new FakeTransport("inf-sim", { log: () => {}, setTimer: tm.setTimer, clearTimer: tm.clearTimer });
  const state = await EncryptedAuthState.open({ influencerId: "inf-sim", storage: h.repo.authStorage("inf-sim") });
  const r = recorded();
  await again.connect(state, r.events);
  tm.advance(100);
  assert.equal(r.out.qr.length, 0);
  assert.equal(r.out.open.length, 1);
  await again.end();
});
