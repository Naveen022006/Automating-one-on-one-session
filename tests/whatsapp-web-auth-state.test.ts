import "dotenv/config";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, test } from "node:test";
import { decryptSecret, parseKeyBytes } from "../lib/crypto";
import { ENCRYPTED_COLUMNS, prismaRotationDb } from "../lib/key-rotation-db";
import { rotateEncryptedColumns } from "../lib/key-rotation";
import {
  AUTH_FLUSH_DELAY_MS,
  EncryptedAuthState,
  openAuthBlob,
  parseAuthBlob,
  sealAuthBlob,
  serializeAuthBlob,
  waWebAad,
  type AuthBlobStorage,
} from "../lib/whatsapp-web/auth-state";

// The encryption key of this file is a throw-away one: nothing here depends on, prints or changes the real TOKEN_ENCRYPTION_KEY.
const KEY_B64 = randomBytes(32).toString("base64");
process.env.TOKEN_ENCRYPTION_KEY = KEY_B64;
delete process.env.TOKEN_ENCRYPTION_KEY_PREVIOUS;

/** A manual timer: nothing fires until the test says so. */
function manualTimers() {
  let next = 1;
  const pending = new Map<number, () => void>();
  return {
    setTimer: (fn: () => void) => {
      const h = next++;
      pending.set(h, fn);
      return h;
    },
    clearTimer: (h: unknown) => void pending.delete(h as number),
    get pending() {
      return pending.size;
    },
    fire: async () => {
      const fns = [...pending.values()];
      pending.clear();
      for (const f of fns) f();
      await new Promise((r) => setImmediate(r));
    },
  };
}

function memoryStorage(initial: string | null = null) {
  const s = { value: initial, saves: 0, clears: 0, failNext: 0 };
  const storage: AuthBlobStorage = {
    load: async () => s.value,
    save: async (sealed) => {
      if (s.failNext > 0) {
        s.failNext--;
        throw new Error("database blinked");
      }
      s.saves++;
      s.value = sealed;
    },
    clear: async () => {
      s.clears++;
      s.value = null;
    },
  };
  return { s, storage };
}

const SAMPLE_CREDS = {
  me: { id: "919999900001:7@s.whatsapp.net" },
  noiseKey: { public: Buffer.from([1, 2, 3, 4]), private: Buffer.from([9, 8, 7, 6]) },
  registered: true,
};

test("the blob is sealed with AES-GCM and bound to the influencer through the AAD", () => {
  assert.equal(waWebAad("inf1"), "wa-web:inf1");
  const sealed = sealAuthBlob("inf1", { v: 1, creds: SAMPLE_CREDS, keys: { session: { "a.0": Buffer.from("secret-session") } } });
  assert.match(sealed, /^v1\./);
  assert.ok(!sealed.includes("secret-session") && !sealed.includes("919999900001"), "nothing readable in the stored text");
  // Round trip: Buffers come back as Buffers, plain data as plain data.
  const back = openAuthBlob("inf1", sealed);
  assert.deepEqual(back.creds, SAMPLE_CREDS);
  assert.ok(Buffer.isBuffer((back.keys.session as Record<string, unknown>)["a.0"]));
  assert.equal(((back.keys.session as Record<string, Buffer>)["a.0"]).toString(), "secret-session");
  // The same ciphertext does not open for another influencer, and not with another key.
  assert.throws(() => openAuthBlob("inf2", sealed));
  const key = parseKeyBytes(KEY_B64)!;
  assert.equal(decryptSecret(sealed, waWebAad("inf1"), key).includes("919999900001"), true, "the right AAD and key do open it");
  assert.throws(() => decryptSecret(sealed, waWebAad("inf2"), key));
  assert.throws(() => decryptSecret(sealed, waWebAad("inf1"), randomBytes(32)));
});

test("Buffers are written the way Baileys' own BufferJSON writes them", () => {
  const json = serializeAuthBlob({ v: 1, keys: { k: { id: new Uint8Array([1, 2, 3]) as never } } });
  assert.equal(JSON.parse(json).keys.k.id.type, "Buffer");
  assert.equal(JSON.parse(json).keys.k.id.data, Buffer.from([1, 2, 3]).toString("base64"));
  assert.throws(() => parseAuthBlob(JSON.stringify({ v: 99, keys: {} })));
  assert.throws(() => parseAuthBlob("{}"));
});

test("an auth state starts empty, serves reads from memory, and writes are coalesced into one save", async () => {
  const t = manualTimers();
  const { s, storage } = memoryStorage();
  const auth = await EncryptedAuthState.open({ influencerId: "inf1", storage, setTimer: t.setTimer, clearTimer: t.clearTimer });
  assert.equal(auth.hasCreds, false);
  assert.equal(auth.getCreds(), undefined);
  assert.deepEqual(auth.getKeys("session", ["x"]), { x: undefined });

  auth.setCreds(SAMPLE_CREDS);
  auth.setKeys({ session: { a: Buffer.from("1"), b: Buffer.from("2") } });
  auth.setKeys({ "pre-key": { "7": { public: Buffer.from("p") } } });
  auth.setKeys({ session: { b: null } }); // delete
  assert.equal(t.pending, 1, "ONE pending write however many changes");
  assert.equal(s.saves, 0, "nothing written yet");
  assert.equal(auth.hasCreds, true);
  assert.equal((auth.getKeys("session", ["a", "b"]).a as Buffer).toString(), "1");
  assert.equal(auth.getKeys("session", ["a", "b"]).b, undefined, "deleted");

  await t.fire();
  assert.equal(s.saves, 1);
  assert.equal(t.pending, 0);
  assert.equal(AUTH_FLUSH_DELAY_MS, 1000);

  // Another burst, then an explicit flush: one more write, the timer is cancelled.
  auth.setKeys({ session: { c: Buffer.from("3") } });
  assert.equal(t.pending, 1);
  await auth.flush();
  assert.equal(s.saves, 2);
  assert.equal(t.pending, 0);
  await auth.flush();
  assert.equal(s.saves, 2, "nothing changed: nothing written");

  // What was stored opens again, equal to what was set.
  const again = await EncryptedAuthState.open({ influencerId: "inf1", storage, setTimer: t.setTimer, clearTimer: t.clearTimer });
  assert.deepEqual(again.getCreds(), SAMPLE_CREDS);
  assert.equal((again.getKeys("session", ["c"]).c as Buffer).toString(), "3");
  assert.deepEqual(Object.keys(again.getKeys("pre-key", ["7"])), ["7"]);
  // Stored for inf1, so another influencer's state cannot open it.
  await assert.rejects(EncryptedAuthState.open({ influencerId: "inf2", storage }));
});

test("never two writes in flight, and a change made during a write is written next", async () => {
  const t = manualTimers();
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const writes: string[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const storage: AuthBlobStorage = {
    load: async () => null,
    save: async (sealed) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      if (writes.length === 0) await gate;
      writes.push(sealed);
      inFlight--;
    },
    clear: async () => {},
  };
  const auth = await EncryptedAuthState.open({ influencerId: "inf1", storage, setTimer: t.setTimer, clearTimer: t.clearTimer });
  auth.setCreds({ me: { id: "x" } });
  const first = auth.flush();
  await new Promise((r) => setImmediate(r));
  auth.setKeys({ session: { a: Buffer.from("late") } });
  const second = auth.flush();
  release();
  await Promise.all([first, second]);
  assert.equal(maxInFlight, 1);
  assert.equal(writes.length, 2);
  assert.equal(openAuthBlob("inf1", writes[1]).keys.session.a instanceof Buffer, true, "the last write holds the late change");
});

test("a failed save is reported, kept dirty and retried; the blob is never part of the report", async () => {
  const t = manualTimers();
  const { s, storage } = memoryStorage();
  const errors: unknown[] = [];
  const auth = await EncryptedAuthState.open({ influencerId: "inf1", storage, setTimer: t.setTimer, clearTimer: t.clearTimer, onSaveError: (e) => errors.push(e) });
  s.failNext = 1;
  auth.setCreds(SAMPLE_CREDS);
  await auth.flush();
  assert.equal(errors.length, 1);
  assert.equal(s.saves, 0);
  assert.equal(t.pending, 1, "a retry is scheduled even though nothing else changed");
  await t.fire();
  assert.equal(s.saves, 1, "the retry wrote it");
  assert.ok(!String(errors[0]).includes("919999900001"));
});

test("wipe deletes the stored login, cancels the pending write and ignores a socket that is still writing", async () => {
  const t = manualTimers();
  const { s, storage } = memoryStorage();
  const auth = await EncryptedAuthState.open({ influencerId: "inf1", storage, setTimer: t.setTimer, clearTimer: t.clearTimer });
  auth.setCreds(SAMPLE_CREDS);
  await auth.flush();
  assert.notEqual(s.value, null);
  auth.setKeys({ session: { a: Buffer.from("pending") } });
  assert.equal(t.pending, 1);
  await auth.wipe();
  assert.equal(s.value, null);
  assert.equal(s.clears, 1);
  assert.equal(t.pending, 0, "the pending write was cancelled");
  assert.equal(auth.isDisposed, true);
  // The dying socket writes once more: it must not bring the login back.
  auth.setCreds(SAMPLE_CREDS);
  auth.setKeys({ session: { z: Buffer.from("zombie") } });
  await auth.flush();
  assert.equal(s.value, null);
  assert.equal(auth.hasCreds, false);
});

test("close flushes what is pending and keeps the login", async () => {
  const t = manualTimers();
  const { s, storage } = memoryStorage();
  const auth = await EncryptedAuthState.open({ influencerId: "inf1", storage, setTimer: t.setTimer, clearTimer: t.clearTimer });
  auth.setCreds(SAMPLE_CREDS);
  await auth.close();
  assert.equal(s.saves, 1);
  assert.notEqual(s.value, null);
  auth.setKeys({ session: { late: Buffer.from("x") } });
  await auth.flush();
  assert.equal(s.saves, 1, "closed: later changes are ignored");
});

// ---- the real table: encryption at rest, cascade, key rotation ----------------------------------------------------------------

const skip = process.env.DATABASE_URL ? false : "DATABASE_URL not set";
const run = `${Date.now()}`;
const created: string[] = [];
let prismaRef: typeof import("../lib/db")["prisma"] | null = null;
let repo: typeof import("../lib/whatsapp-web/session-repo")["prismaSessionRepo"] | null = null;

before(async () => {
  if (skip) return;
  ({ prisma: prismaRef } = await import("../lib/db"));
  ({ prismaSessionRepo: repo } = await import("../lib/whatsapp-web/session-repo"));
});

after(async () => {
  try {
    if (prismaRef && created.length) await prismaRef.influencer.deleteMany({ where: { id: { in: created } } });
  } catch (e) {
    console.error("cleanup failed", e instanceof Error ? e.message : e);
  } finally {
    await prismaRef?.$disconnect();
  }
});

async function makeInfluencer(label: string): Promise<string> {
  const row = await prismaRef!.influencer.create({ data: { slug: `waw-${label}-${run}`, name: `WAW ${label}`, email: `waw-${label}-${run}@example.com` } });
  created.push(row.id);
  return row.id;
}

test("integration: the stored login is ciphertext bound to its influencer, and is gone with the influencer", { skip }, async () => {
  const a = await makeInfluencer("a");
  const b = await makeInfluencer("b");
  await prismaRef!.whatsAppWebSession.create({ data: { influencerId: a } });
  await prismaRef!.whatsAppWebSession.create({ data: { influencerId: b } });

  const auth = await EncryptedAuthState.open({ influencerId: a, storage: repo!.authStorage(a) });
  auth.setCreds(SAMPLE_CREDS);
  auth.setKeys({ session: { "peer.0": Buffer.from("very-secret-ratchet") } });
  await auth.close();

  const row = await prismaRef!.whatsAppWebSession.findUniqueOrThrow({ where: { influencerId: a } });
  assert.match(row.authStateEnc!, /^v1\./);
  assert.ok(!row.authStateEnc!.includes("very-secret-ratchet") && !row.authStateEnc!.includes("919999900001"));

  const reopened = await EncryptedAuthState.open({ influencerId: a, storage: repo!.authStorage(a) });
  assert.deepEqual(reopened.getCreds(), SAMPLE_CREDS);
  await reopened.close();

  // The same ciphertext copied onto another influencer's row does not open there.
  await prismaRef!.whatsAppWebSession.update({ where: { influencerId: b }, data: { authStateEnc: row.authStateEnc } });
  await assert.rejects(EncryptedAuthState.open({ influencerId: b, storage: repo!.authStorage(b) }));

  // Writing to a row that no longer exists is not an error (the influencer was deleted while a socket was still closing).
  await prismaRef!.influencer.delete({ where: { id: b } });
  await repo!.authStorage(b).save("v1.x.y.z");
  assert.equal(await prismaRef!.whatsAppWebSession.count({ where: { influencerId: b } }), 0, "deleting the influencer deleted the session row and its login");

  // wipe() clears the column but keeps the row.
  const again = await EncryptedAuthState.open({ influencerId: a, storage: repo!.authStorage(a) });
  await again.wipe();
  const cleared = await prismaRef!.whatsAppWebSession.findUniqueOrThrow({ where: { influencerId: a } });
  assert.equal(cleared.authStateEnc, null);
});

test("integration: key rotation covers the login column and rewrites it to the new key without touching updated_at", { skip }, async () => {
  const c = await makeInfluencer("c");
  const row = await prismaRef!.whatsAppWebSession.create({ data: { influencerId: c } });
  const auth = await EncryptedAuthState.open({ influencerId: c, storage: repo!.authStorage(c) });
  auth.setCreds(SAMPLE_CREDS);
  await auth.close();
  const before = await prismaRef!.whatsAppWebSession.findUniqueOrThrow({ where: { influencerId: c } });

  const column = ENCRYPTED_COLUMNS.find((x) => x.name === "whatsapp_web_sessions.auth_state_enc");
  assert.ok(column, "the login column is listed for key rotation");
  assert.equal(column.aad(c), waWebAad(c));
  assert.equal(column.ownerColumn, "influencer_id");

  const oldKey = parseKeyBytes(KEY_B64)!;
  const newKey = randomBytes(32);
  const opts = { db: prismaRotationDb(prismaRef!, { ownerIds: [c] }), columns: [column], oldKey, newKey, apply: true };
  const first = await rotateEncryptedColumns(opts);
  assert.deepEqual(first.totals, { scanned: 1, rotated: 1, skipped: 0, failed: 0 }, JSON.stringify(first.failures));
  const after = await prismaRef!.whatsAppWebSession.findUniqueOrThrow({ where: { influencerId: c } });
  assert.notEqual(after.authStateEnc, before.authStateEnc);
  assert.equal(after.updatedAt.getTime(), before.updatedAt.getTime(), "rotating a key is not an edit");
  assert.equal(JSON.parse(decryptSecret(after.authStateEnc!, waWebAad(c), newKey)).creds.registered, true);
  assert.equal(row.id, after.id);
  const second = await rotateEncryptedColumns(opts);
  assert.deepEqual(second.totals, { scanned: 1, rotated: 0, skipped: 1, failed: 0 });
});
