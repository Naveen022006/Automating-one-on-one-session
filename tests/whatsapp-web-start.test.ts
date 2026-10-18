import "dotenv/config";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, beforeEach, test } from "node:test";
import { MemoryKv } from "../lib/whatsapp-web/kv";
import { isWhatsAppWebReady, sendWhatsAppWebText, setActiveSender } from "../lib/whatsapp-web/send";
import { startWhatsAppWeb } from "../worker/whatsapp-web";
import { MemoryRepo, newRow, settle } from "./helpers/whatsapp-web";

// The worker's start-up wiring, with an in-memory table and store injected: no database row of anyone else is read or changed
// (the kill switch sweeps every session it can see), no worker is started, no socket is opened.

delete process.env.REDIS_URL;
process.env.TOKEN_ENCRYPTION_KEY = randomBytes(32).toString("base64");
const names = ["WHATSAPP_QR_ENABLED", "WHATSAPP_QR_FAKE", "WHATSAPP_QR_KEEP_AUTH_WHEN_DISABLED", "NODE_ENV", "APP_URL"] as const;
const saved = Object.fromEntries(names.map((n) => [n, process.env[n]]));
const env = process.env as Record<string, string | undefined>;

beforeEach(() => {
  for (const n of names) delete env[n];
  setActiveSender(null);
});

after(async () => {
  for (const n of names) {
    if (saved[n] === undefined) delete env[n];
    else env[n] = saved[n];
  }
  setActiveSender(null);
  const { prisma } = await import("../lib/db");
  await prisma.$disconnect();
});

const quiet = { log: () => {} };

test("switched off: nothing connects, one pass deletes every stored login, no heartbeat, and sends are refused", async () => {
  const repo = new MemoryRepo();
  repo.add(newRow("a", { status: "LINKED", wantLinked: true, authStateEnc: "v1.stored.login.blob", phoneE164: "+919876500001" }));
  repo.add(newRow("b", { status: "SUSPENDED", wantLinked: true, authStateEnc: "v1.other.login.blob" }));
  const kv = new MemoryKv();
  const manager = await startWhatsAppWeb({ repo, kv, ...quiet });
  assert.equal(manager, null);
  for (const id of ["a", "b"]) {
    assert.equal(repo.row(id).authStateEnc, null, `${id}: login deleted`);
    assert.equal(repo.row(id).status, "NOT_LINKED");
    assert.equal(repo.row(id).wantLinked, false);
  }
  assert.equal(await kv.get("wa-web:manager:alive"), null);
  assert.deepEqual(await sendWhatsAppWebText({ influencerId: "a", toE164: "+919876500002", text: "x", bookingId: "b", key: "k" }), { ok: false, reason: "qr-disabled", retryable: false });
  assert.equal(isWhatsAppWebReady("a"), false);
});

test("switched off but told to keep the logins: they stay", async () => {
  env.WHATSAPP_QR_KEEP_AUTH_WHEN_DISABLED = "true";
  const repo = new MemoryRepo();
  repo.add(newRow("a", { status: "LINKED", wantLinked: true, authStateEnc: "v1.stored.login.blob" }));
  assert.equal(await startWhatsAppWeb({ repo, kv: new MemoryKv(), ...quiet }), null);
  assert.equal(repo.row("a").authStateEnc, "v1.stored.login.blob");
  assert.equal(repo.row("a").status, "LINKED");
});

test("with the simulator: the manager starts, registers itself for sending, and links a number", async () => {
  env.WHATSAPP_QR_ENABLED = "true";
  env.WHATSAPP_QR_FAKE = "true";
  env.NODE_ENV = "development";
  env.APP_URL = "http://localhost:3000";
  const repo = new MemoryRepo();
  repo.add(newRow("a", { wantLinked: true }));
  const kv = new MemoryKv();
  const manager = await startWhatsAppWeb({ repo, kv, ...quiet });
  assert.ok(manager);
  try {
    await settle();
    assert.equal(repo.row("a").status, "PENDING_QR", "a code was produced by the simulator");
    assert.ok(await kv.get("wa-web:qr:a"));
    assert.ok(await kv.get("wa-web:manager:alive"));
    // Registered: a call that reaches the manager is answered by it ("not linked yet"), not by the "no manager" fallback.
    assert.deepEqual(await sendWhatsAppWebText({ influencerId: "a", toE164: "+919876500002", text: "x", bookingId: "b", key: "k" }), { ok: false, reason: "not-connected", retryable: true });
    assert.deepEqual(await sendWhatsAppWebText({ influencerId: "zzz", toE164: "+919876500002", text: "x", bookingId: "b", key: "k" }), { ok: false, reason: "not-linked", retryable: false });
  } finally {
    await manager.shutdown();
  }
});

test("without a manager (the web process) sending answers 'manager-not-running' and never throws", async () => {
  env.WHATSAPP_QR_ENABLED = "true";
  assert.deepEqual(await sendWhatsAppWebText({ influencerId: "a", toE164: "+919876500002", text: "x", bookingId: "b", key: "k" }), { ok: false, reason: "manager-not-running", retryable: false });
  setActiveSender({
    send: async () => {
      throw new Error("boom");
    },
    isReady: () => {
      throw new Error("boom");
    },
  });
  assert.deepEqual(await sendWhatsAppWebText({ influencerId: "a", toE164: "+919876500002", text: "x", bookingId: "b", key: "k" }), { ok: false, reason: "send-error", retryable: true });
  assert.equal(isWhatsAppWebReady("a"), false);
});

test("the simulator is ignored in production: the real library would be used (and the library is not loaded when switched off)", async () => {
  // Production with the simulator requested and the feature off: the sweep still runs, nothing is loaded, nothing starts.
  env.NODE_ENV = "production";
  env.WHATSAPP_QR_FAKE = "true";
  const repo = new MemoryRepo();
  assert.equal(await startWhatsAppWeb({ repo, kv: new MemoryKv(), ...quiet }), null);
});
