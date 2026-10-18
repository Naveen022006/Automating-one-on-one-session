import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
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
