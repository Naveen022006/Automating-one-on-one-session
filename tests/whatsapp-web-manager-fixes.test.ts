import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { kvKeys, MemoryKv, RedisKv, type RedisKvClient } from "../lib/whatsapp-web/kv";
import { LEASE_TTL_MS } from "../worker/whatsapp-web-manager";
import { harness, newRow, settle, want, type Harness } from "./helpers/whatsapp-web";

// Fixes from the review of the whole QR-code feature, at the manager's level: in-memory session table, fake transport, hand-moved clock.

process.env.TOKEN_ENCRYPTION_KEY = randomBytes(32).toString("base64");
delete process.env.TOKEN_ENCRYPTION_KEY_PREVIOUS;

const INF = "inf-fix";
const PHONE = "+919876500001";
const CREDS = { me: { id: "919876500001:3@s.whatsapp.net" }, registered: true };

/** Makes the next `n` deletes of a stored login fail (set `failures.n`), as a database that blinks would. Install BEFORE the session starts. */
function flakyDeletes(h: Harness) {
  const failures = { n: 0 };
  const real = h.repo.authStorage.bind(h.repo);
  h.repo.authStorage = (id: string) => ({ ...real(id), clear: async () => (failures.n-- > 0 ? Promise.reject(new Error("database down")) : real(id).clear()) });
  return failures;
}

async function linked(h: Harness, id = INF) {
  want(h, id);
  await h.tick();
  const t = h.last(id);
  t.emitQr(`SECRET-QR-PAYLOAD-${id}`);
  await settle();
  t.authStore.setCreds(CREDS);
  t.emitOpen({ phoneE164: PHONE, deviceLabel: "Chrome (Mac OS)" });
  await settle();
  return t;
}

// ---- W8: a login that could not be deleted is not reported as gone ---------------------------------------------------------------

test("disconnect: when deleting the stored login fails the row is NOT marked not-linked; the next pass deletes it and only then marks it", async () => {
  const h = harness();
  const failures = flakyDeletes(h);
  await linked(h);
  assert.ok(h.repo.row(INF).authStateEnc, "the login is stored once the number is linked");
  failures.n = 1;

  h.repo.row(INF).wantLinked = false; // the influencer pressed disconnect
  await h.tick();
  assert.equal(h.repo.row(INF).status, "LINKED", "not NOT_LINKED: the login is still there");
  assert.ok(h.logs.some((l) => /could not delete the stored login/.test(l)));
  assert.ok(h.repo.row(INF).authStateEnc);

  await h.tick(); // no socket any more, the row is still listed: the delete is retried
  assert.equal(h.repo.row(INF).authStateEnc, null);
  assert.equal(h.repo.row(INF).status, "NOT_LINKED");
  assert.equal(h.repo.row(INF).phoneE164, null);
  await h.manager.shutdown();
});

test("a stopped row that still holds a login is revisited and cleaned, keeping its status", async () => {
  const h = harness();
  h.repo.add(newRow("inf-a", { status: "NOT_LINKED", wantLinked: false, authStateEnc: "sealed-leftover" }));
  h.repo.add(newRow("inf-b", { status: "LOGGED_OUT", wantLinked: false, lastErrorCode: "logged-out", authStateEnc: "sealed-leftover" }));
  h.repo.add(newRow("inf-c", { status: "NOT_LINKED", wantLinked: false, authStateEnc: null }));
  await h.tick();
  assert.equal(h.repo.row("inf-a").authStateEnc, null);
  assert.equal(h.repo.row("inf-b").authStateEnc, null);
  assert.equal(h.repo.row("inf-b").status, "LOGGED_OUT", "the reason the number stopped is not lost");
  assert.equal(h.repo.row("inf-b").lastErrorCode, "logged-out");
  assert.deepEqual(h.repo.updates, [], "only the login was removed, no status was rewritten");
  await h.manager.shutdown();
});

test("the kill switch retries a delete that failed", async () => {
  const h = harness();
  const failures = flakyDeletes(h);
  await linked(h);
  failures.n = 2; // the teardown's delete and the same pass's second try both fail
  h.config.enabled = false;
  await h.tick();
  assert.equal(h.repo.row(INF).status, "LINKED", "not reported as gone while the login is still stored");
  await h.tick();
  assert.equal(h.repo.row(INF).authStateEnc, null);
  assert.equal(h.repo.row(INF).status, "NOT_LINKED");
  await h.manager.shutdown();
});

// ---- W13: the device is unlinked on the phone where the socket is open -------------------------------------------------------

test("an influencer who is deleted while linked: the device is logged out on the phone, the socket closed and the login wiped", async () => {
  const h = harness();
  const t = await linked(h);
  h.repo.rows.delete(INF); // the row is gone (the influencer was deleted, the foreign key cascaded)
  await h.tick();
  assert.equal(t.loggedOut, true, "logout was called on the open socket");
  assert.equal(t.ended, true);
  assert.equal(h.manager.openCount, 0);
  await h.manager.shutdown();
});

test("a force-disconnect (the web side clears the request and the stored login): the open socket is logged out", async () => {
  const h = harness();
  const t = await linked(h);
  h.repo.row(INF).wantLinked = false;
  h.repo.row(INF).authStateEnc = null;
  await h.tick();
  assert.equal(t.loggedOut, true);
  assert.equal(h.repo.row(INF).status, "NOT_LINKED");
  await h.manager.shutdown();
});

test("a socket that never opened is not logged out when its row disappears (there is nothing to unlink)", async () => {
  const h = harness();
  want(h, INF);
  await h.tick();
  const t = h.last(INF);
  h.repo.rows.delete(INF);
  await h.tick();
  assert.equal(t.loggedOut, false);
  assert.equal(t.ended, true);
  await h.manager.shutdown();
});

// ---- W4: one worker at a time holds the linked sockets ---------------------------------------------------------------------------

const open = (...hs: Harness[]) => hs.flatMap((h) => h.transports).filter((t) => !t.ended).length;

test("a second worker on the same database stays idle, says so once, and opens no socket", async () => {
  const h1 = harness();
  await linked(h1);
  assert.equal(h1.manager.leaseHeld, true);
  const h2 = h1.restart();
  for (let i = 0; i < 4; i++) {
    await h1.clock.advance(2_000);
    await h1.tick(); // the first worker keeps renewing
    await h2.tick();
  }
  assert.equal(h2.transports.length, 0, "the second worker never created a transport");
  assert.equal(h2.manager.leaseHeld, false);
  assert.equal(h2.logs.filter((l) => /another worker holds the lease/.test(l)).length, 1, "logged once, not every pass");
  assert.equal(open(h1, h2), 1);
  await h1.manager.shutdown();
  await h2.manager.shutdown();
});

test("a worker that crashed is replaced once its lease runs out, never before; one socket per number at every step", async () => {
  const h1 = harness();
  const t1 = await linked(h1);
  const h2 = h1.restart();
  await h2.tick();
  assert.equal(h2.transports.length, 0);
  // h1 dies without a word: its sockets go with the process, its lease stays until it runs out.
  await t1.end();
  await h1.clock.advance(LEASE_TTL_MS - 1_000);
  await h2.tick();
  assert.equal(h2.transports.length, 0, "not yet");
  await h1.clock.advance(2_000);
  await h2.tick();
  assert.equal(h2.manager.leaseHeld, true);
  assert.equal(h2.transports.length, 1, "the new worker restores the number from the stored login");
  assert.equal(open(h1, h2), 1);
  await h2.manager.shutdown();
});

test("a worker that was only stalled and wakes up after another took over closes its sockets and writes nothing", async () => {
  const h1 = harness();
  await linked(h1);
  const stored = h1.repo.row(INF).authStateEnc;
  assert.ok(stored);
  const h2 = h1.restart();
  await h1.clock.advance(LEASE_TTL_MS + 1_000); // h1's loop did not run for that long
  await h2.tick(); // h2 takes the lease (and its socket opens)
  assert.equal(h2.manager.leaseHeld, true);
  h2.last(INF).emitOpen({ phoneE164: PHONE, deviceLabel: null });
  await settle();
  const storedByNewOwner = h2.repo.row(INF).authStateEnc;
  const updatesBefore = h1.repo.updates.length;
  await h1.tick(); // h1 wakes up: cannot renew, cannot take it
  assert.equal(h1.manager.leaseHeld, false);
  assert.equal(h1.manager.openCount, 0);
  assert.equal(open(h1, h2), 1, "only the new owner's socket is open");
  assert.ok(h1.logs.some((l) => /lease on the linked numbers was lost/.test(l)));
  assert.equal(h1.repo.updates.length, updatesBefore, "the old worker changed no status");
  assert.equal(h1.repo.row(INF).authStateEnc, storedByNewOwner, "and wrote or deleted no login");
  await h1.manager.shutdown();
  await h2.manager.shutdown();
});

test("a worker that stalled but nobody else took over takes the lease back and keeps its sockets", async () => {
  const h = harness();
  const t = await linked(h);
  await h.clock.advance(LEASE_TTL_MS + 5_000);
  await h.tick();
  assert.equal(h.manager.leaseHeld, true);
  assert.equal(t.ended, false);
  assert.ok(h.logs.some((l) => /had run out; nobody else had taken it/.test(l)));
  await h.manager.shutdown();
});

test("shutdown gives the lease back, so the next worker starts at once", async () => {
  const h1 = harness();
  await linked(h1);
  const h2 = h1.restart();
  await h1.manager.shutdown();
  assert.equal(await h1.kv.get(kvKeys.lease), null);
  await h2.tick();
  assert.equal(h2.manager.leaseHeld, true);
  assert.equal(h2.transports.length, 1);
  await h2.manager.shutdown();
});

test("a shared store that does not answer: nothing new is started; what is open is kept only until the lease would have run out", async () => {
  const h = harness();
  await linked(h);
  const t = h.last(INF);
  h.kv.renew = async () => Promise.reject(new Error("redis down"));
  h.kv.setNx = async () => Promise.reject(new Error("redis down"));
  await h.clock.advance(5_000);
  await h.tick();
  assert.equal(t.ended, false, "kept for now");
  await h.clock.advance(LEASE_TTL_MS);
  await h.tick();
  assert.equal(t.ended, true, "closed once nobody could vouch for the lease");
  assert.equal(h.manager.openCount, 0);

  const fresh = harness();
  fresh.kv.setNx = async () => Promise.reject(new Error("redis down"));
  want(fresh, "inf-new");
  await fresh.tick();
  assert.equal(fresh.transports.length, 0, "no lease, no socket");
  await h.manager.shutdown();
  await fresh.manager.shutdown();
});

test("switched off: the kill-switch pass needs no lease, and a held lease is given back", async () => {
  const h = harness();
  await linked(h);
  h.config.enabled = false;
  await h.tick();
  assert.equal(h.manager.leaseHeld, false);
  assert.equal(await h.kv.get(kvKeys.lease), null);
  await h.manager.shutdown();
});

test("the lease operations of the store: only one taker, only the owner renews or releases", async () => {
  let now = 0;
  const kv = new MemoryKv(() => now);
  assert.equal(await kv.setNx("l", "a", 1_000), true);
  assert.equal(await kv.setNx("l", "b", 1_000), false);
  assert.equal(await kv.renew("l", "b", 1_000), false);
  now = 900;
  assert.equal(await kv.renew("l", "a", 1_000), true);
  now = 1_800;
  assert.equal(await kv.get("l"), "a", "the renewal moved the expiry");
  assert.equal(await kv.delIfEquals("l", "b"), false);
  assert.equal(await kv.delIfEquals("l", "a"), true);
  assert.equal(await kv.setNx("l", "b", 1_000), true);
  now = 5_000;
  assert.equal(await kv.setNx("l", "c", 1_000), true, "an expired lease is free");

  await kv.rpush("q", "one", 1_000);
  await kv.rpush("q", "two", 1_000);
  assert.deepEqual(await kv.drain("q"), ["one", "two"]);
  assert.deepEqual(await kv.drain("q"), []);
});

test("the redis store runs each lease operation as one script (atomic)", async () => {
  const calls: unknown[][] = [];
  const answers: unknown[] = [1, 0, 1, 1];
  const kindOf = (script: string) => (/ 'NX'/.test(script) ? "setnx" : /LRANGE/.test(script) ? "drain" : /RPUSH/.test(script) ? "rpush" : /'DEL'/.test(script) ? "delIfEquals" : /PEXPIRE/.test(script) ? "renew" : "other");
  const client: RedisKvClient = {
    get: async () => null,
    set: async () => "OK",
    del: async () => 1,
    eval: async (script, numKeys, ...args) => (calls.push([kindOf(script), numKeys, ...args]), answers.shift()),
    quit: async () => "OK",
  };
  const kv = new RedisKv(client);
  assert.equal(await kv.setNx("l", "a", 20_000), true);
  assert.equal(await kv.renew("l", "a", 20_000), false);
  assert.equal(await kv.delIfEquals("l", "a"), true);
  await kv.rpush("q", "x", 5_000);
  assert.deepEqual(calls.map((c) => c[0]), ["setnx", "renew", "delIfEquals", "rpush"]);
  assert.deepEqual(calls[0], ["setnx", 1, "l", "a", 20_000]);
  answers.push(["a", "b"]);
  assert.deepEqual(await kv.drain("q"), ["a", "b"]);
});
