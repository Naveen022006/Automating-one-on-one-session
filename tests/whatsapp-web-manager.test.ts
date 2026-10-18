import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { openAuthBlob } from "../lib/whatsapp-web/auth-state";
import { kvKeys, QR_TTL_MS } from "../lib/whatsapp-web/kv";
import { SELF_TEST_BOOKING_ID } from "../lib/whatsapp-web/send";
import { WhatsAppWebTransportError } from "../lib/whatsapp-web/transport";
import { BACKOFF_CAP_MS, PAIRING_WINDOW_MS } from "../worker/whatsapp-web-manager";
import { harness, newRow, settle, want, type Harness } from "./helpers/whatsapp-web";

// In-process tests of the worker's manager: an in-memory session table, an in-memory Redis stand-in, the scriptable fake
// transport and a clock moved by hand. Nothing here starts a worker, opens a socket, or touches the database or Redis.

process.env.TOKEN_ENCRYPTION_KEY = randomBytes(32).toString("base64");
delete process.env.TOKEN_ENCRYPTION_KEY_PREVIOUS;

const INF = "inf-m1";
const PHONE = "+919876500001";
const CREDS = { me: { id: "919876500001:3@s.whatsapp.net" }, registered: true };

/** Starts a link and completes the scan: the state a number is in once it is LINKED. */
async function linked(h: Harness, id = INF, patch: Parameters<typeof want>[2] = {}) {
  want(h, id, patch);
  await h.tick();
  const t = h.last(id);
  t.emitQr(`SECRET-QR-PAYLOAD-${id}`);
  await settle();
  t.authStore.setCreds(CREDS);
  t.emitOpen({ phoneE164: PHONE, deviceLabel: "Chrome (Mac OS)" });
  await settle();
  return t;
}

test("start link: a transport is created, the QR code is published for 60 s (never stored in the database or logged), the scan links the number", async () => {
  const h = harness();
  want(h, INF);
  await h.tick();
  assert.equal(h.transports.length, 1);
  assert.ok(await h.kv.get("wa-web:manager:alive"), "heartbeat so the web app can tell the worker is running");
  assert.equal(h.repo.row(INF).status, "NOT_LINKED", "nothing to scan yet");

  const t = h.last(INF);
  t.emitQr("SECRET-QR-PAYLOAD-1");
  await settle();
  assert.equal(h.repo.row(INF).status, "PENDING_QR");
  const published = JSON.parse((await h.kv.get(kvKeys.qr(INF)))!);
  assert.equal(published.qr, "SECRET-QR-PAYLOAD-1");
  assert.equal(published.issuedAt, h.clock.now());
  // A newer code replaces the old one.
  t.emitQr("SECRET-QR-PAYLOAD-2");
  await settle();
  assert.equal(JSON.parse((await h.kv.get(kvKeys.qr(INF)))!).qr, "SECRET-QR-PAYLOAD-2");
  // It lives 60 seconds.
  await h.clock.advance(QR_TTL_MS - 1_000);
  assert.ok(await h.kv.get(kvKeys.qr(INF)));
  await h.clock.advance(2_000);
  assert.equal(await h.kv.get(kvKeys.qr(INF)), null);

  // It never reaches the database or the log.
  assert.ok(!JSON.stringify(h.repo.updates).includes("SECRET-QR"));
  assert.ok(![...h.repo.rows.values()].some((r) => JSON.stringify(r).includes("SECRET-QR")));
  assert.ok(!h.logs.join("\n").includes("SECRET-QR"));

  // The scan: the login is stored (encrypted) before the number is called linked.
  t.emitQr("SECRET-QR-PAYLOAD-3");
  await settle();
  t.authStore.setCreds(CREDS);
  t.emitOpen({ phoneE164: PHONE, deviceLabel: "Chrome (Mac OS)" });
  await settle();
  const row = h.repo.row(INF);
  assert.equal(row.status, "LINKED");
  assert.equal(row.phoneE164, PHONE);
  assert.equal(row.deviceLabel, "Chrome (Mac OS)");
  assert.ok(row.linkedAt && row.lastConnectedAt);
  assert.equal(row.lastErrorCode, null);
  assert.equal(await h.kv.get(kvKeys.qr(INF)), null, "the code is removed once it is used");
  assert.ok(row.authStateEnc, "the login was stored before LINKED");
  assert.deepEqual(openAuthBlob(INF, row.authStateEnc!).creds, CREDS);
  assert.ok(!row.authStateEnc!.includes("919876500001"), "encrypted");
  assert.equal(h.manager.isReady(INF), true);
  await h.manager.shutdown();
});

test("reconcile passes never overlap: two at once create one transport", async () => {
  const h = harness();
  want(h, INF);
  await Promise.all([h.manager.reconcile(), h.manager.reconcile(), h.manager.reconcile()]);
  assert.equal(h.transports.length, 1);
  await h.manager.shutdown();
});

test("a transient close reconnects with exponential backoff capped at 5 minutes, and a successful open resets it", async () => {
  const h = harness();
  const first = await linked(h);
  first.emitClose({ reason: "transient", code: "connection-closed" });
  await settle();
  assert.equal(h.repo.row(INF).status, "RECONNECTING");
  assert.equal(h.manager.isReady(INF), false);

  const expected = [2_000, 4_000, 8_000, 16_000, 32_000, 64_000, 128_000, 256_000, BACKOFF_CAP_MS, BACKOFF_CAP_MS];
  for (const [i, delay] of expected.entries()) {
    const before = h.transports.length;
    await h.clock.advance(delay - 1);
    await h.tick();
    assert.equal(h.transports.length, before, `attempt ${i + 1}: not before ${delay} ms`);
    await h.clock.advance(1);
    await h.tick();
    assert.equal(h.transports.length, before + 1, `attempt ${i + 1}: at ${delay} ms`);
    h.last(INF).emitClose({ reason: "transient", code: "connection-closed" });
    await settle();
  }

  // The next attempt succeeds: the status is LINKED again and the backoff starts over.
  await h.clock.advance(BACKOFF_CAP_MS);
  await h.tick();
  const t = h.last(INF);
  assert.equal(h.repo.row(INF).status, "RECONNECTING");
  t.emitOpen({ phoneE164: PHONE, deviceLabel: null });
  await settle();
  assert.equal(h.repo.row(INF).status, "LINKED");
  assert.equal(h.manager.isReady(INF), true);
  t.emitClose({ reason: "transient", code: "connection-closed" });
  await settle();
  const n = h.transports.length;
  await h.clock.advance(1_999);
  await h.tick();
  assert.equal(h.transports.length, n);
  await h.clock.advance(1);
  await h.tick();
  assert.equal(h.transports.length, n + 1, "back to 2 s");
  assert.equal(h.alerts.length, 0, "ordinary reconnecting alerts nobody");
  await h.manager.shutdown();
});

test("the restart WhatsApp asks for right after a scan is done at once, without backoff", async () => {
  const h = harness();
  const t = await linked(h);
  t.emitClose({ reason: "transient", code: "restart-required" });
  await settle();
  assert.equal(h.transports.length, 2, "reconnected immediately");
  assert.equal(t.ended, true, "the old socket was closed");
  h.last(INF).emitOpen({ phoneE164: PHONE, deviceLabel: null });
  await settle();
  assert.equal(h.repo.row(INF).status, "LINKED");
  await h.manager.shutdown();
});

test("a session another instance took over waits at least a minute, so two never fight over one login", async () => {
  const h = harness();
  const t = await linked(h);
  t.emitClose({ reason: "transient", code: "replaced" });
  await settle();
  await h.clock.advance(59_000);
  await h.tick();
  assert.equal(h.transports.length, 1);
  await h.clock.advance(1_000);
  await h.tick();
  assert.equal(h.transports.length, 2);
  await h.manager.shutdown();
});

test("a transport that cannot even start is retried with the same backoff", async () => {
  const h = harness();
  h.failConnects.n = 1;
  want(h, INF);
  await h.tick();
  assert.equal(h.transports.length, 1);
  await h.clock.advance(1_999);
  await h.tick();
  assert.equal(h.transports.length, 1);
  await h.clock.advance(1);
  await h.tick();
  assert.equal(h.transports.length, 2);
  await h.manager.shutdown();
});

test("the phone logging the device out: the stored login is deleted, the status is LOGGED_OUT, the influencer is told, nothing is retried", async () => {
  const h = harness();
  const t = await linked(h);
  assert.ok(h.repo.row(INF).authStateEnc);
  t.emitClose({ reason: "logged-out", code: "logged-out" });
  await settle();
  const row = h.repo.row(INF);
  assert.equal(row.status, "LOGGED_OUT");
  assert.equal(row.wantLinked, false);
  assert.equal(row.authStateEnc, null, "the login is wiped");
  assert.equal(row.lastErrorCode, "logged-out");
  assert.deepEqual(h.alerts.map((a) => [a.influencerId, a.kind]), [[INF, "logged-out"]]);
  assert.equal(h.manager.isReady(INF), false);
  assert.equal(await h.kv.get(kvKeys.qr(INF)), null);
  const n = h.transports.length;
  await h.clock.advance(10 * 60_000);
  await h.tick();
  assert.equal(h.transports.length, n, "no reconnect");
  // The dashboard then offers a new link: start resets the status and a fresh scan begins (no old login).
  Object.assign(h.repo.row(INF), { wantLinked: true, status: "NOT_LINKED", lastErrorCode: null });
  await h.tick();
  assert.equal(h.transports.length, n + 1);
  assert.equal(h.last(INF).authStore.getCreds(), undefined, "a new link starts from nothing");
  await h.manager.shutdown();
});

test("a logout during an unfinished scan wipes quietly and does not alert", async () => {
  const h = harness();
  want(h, INF);
  await h.tick();
  h.last(INF).emitQr("SECRET-QR-PAYLOAD-x");
  await settle();
  h.last(INF).emitClose({ reason: "logged-out", code: "bad-session" });
  await settle();
  assert.equal(h.repo.row(INF).status, "LOGGED_OUT");
  assert.deepEqual(h.alerts, []);
  await h.manager.shutdown();
});

test("disconnect (wantLinked off): the device is unlinked on the phone's side, the login is wiped, the row is clean", async () => {
  const h = harness();
  const t = await linked(h);
  h.repo.row(INF).wantLinked = false;
  await h.tick();
  assert.equal(t.loggedOut, true, "logout was called");
  assert.equal(t.ended, true);
  const row = h.repo.row(INF);
  assert.equal(row.authStateEnc, null);
  assert.equal(row.status, "NOT_LINKED");
  assert.equal(row.phoneE164, null);
  assert.equal(row.linkedAt, null);
  assert.equal(h.manager.isReady(INF), false);
  assert.deepEqual(await h.manager.send({ influencerId: INF, toE164: "+919876500009", text: "x", bookingId: "b", key: "k" }), { ok: false, reason: "not-linked", retryable: false });
  // Stable: later passes do nothing more.
  const updates = h.repo.updates.length;
  await h.tick();
  await h.tick();
  assert.equal(h.repo.updates.length, updates);
  await h.manager.shutdown();
});

test("cancel before the scan: the attempt is ended without a logout and the code disappears", async () => {
  const h = harness();
  want(h, INF);
  await h.tick();
  const t = h.last(INF);
  t.emitQr("SECRET-QR-PAYLOAD-y");
  await settle();
  assert.ok(await h.kv.get(kvKeys.qr(INF)));
  h.repo.row(INF).wantLinked = false;
  await h.tick();
  assert.equal(t.ended, true);
  assert.equal(t.loggedOut, false, "never linked: nothing to unlink");
  assert.equal(h.repo.row(INF).status, "NOT_LINKED");
  assert.equal(await h.kv.get(kvKeys.qr(INF)), null);
  await h.manager.shutdown();
});

test("an unscanned code is given up after 5 minutes, so a forgotten page does not keep asking WhatsApp for codes", async () => {
  const h = harness();
  want(h, INF);
  await h.tick();
  const t = h.last(INF);
  t.emitQr("SECRET-QR-PAYLOAD-z");
  await settle();
  await h.clock.advance(PAIRING_WINDOW_MS - 1_000);
  await h.tick();
  assert.equal(t.ended, false);
  await h.clock.advance(2_000);
  await h.tick();
  assert.equal(t.ended, true);
  const row = h.repo.row(INF);
  assert.equal(row.wantLinked, false);
  assert.equal(row.status, "NOT_LINKED");
  assert.equal(row.lastErrorCode, "qr-expired");
  assert.equal(await h.kv.get(kvKeys.qr(INF)), null);
  await h.manager.shutdown();
});

test("at most WHATSAPP_QR_MAX_SESSIONS numbers: extras stay NOT_LINKED with an explanation and start when room appears", async () => {
  const h = harness({ config: { maxSessions: 2 } });
  for (const [i, id] of ["a", "b", "c"].entries()) want(h, id, { createdAt: new Date(Date.UTC(2026, 10, 9, 9, i)) });
  await h.tick();
  assert.equal(h.transports.length, 2);
  const c = h.repo.row("c");
  assert.equal(c.status, "NOT_LINKED");
  assert.equal(c.lastErrorCode, "max-sessions");
  assert.match(c.lastErrorText!, /limit|many/i);
  // Stable: no write per pass.
  const updates = h.repo.updates.length;
  await h.tick();
  assert.equal(h.repo.updates.length, updates);

  h.repo.row("a").wantLinked = false;
  await h.tick();
  await h.tick();
  assert.equal(h.transports.length, 3, "c got the freed place");
  assert.equal(h.repo.row("c").lastErrorCode, null);
  await h.manager.shutdown();
});

test("a full house never turns an established number away for a new one", async () => {
  const h = harness({ config: { maxSessions: 1 } });
  want(h, "new", { createdAt: new Date(Date.UTC(2026, 10, 9, 8, 0)) });
  want(h, "old", { createdAt: new Date(Date.UTC(2026, 10, 9, 9, 0)), status: "LINKED", linkedAt: new Date(Date.UTC(2026, 9, 1)), phoneE164: PHONE });
  await h.tick();
  assert.equal(h.transports.length, 1);
  assert.equal(h.last("old").authStore.getCreds(), undefined);
  assert.equal(h.repo.row("new").lastErrorCode, "max-sessions");
  await h.manager.shutdown();
});

test("worker restart: LINKED sessions are restored from the stored login, shown as reconnecting until the socket is open", async () => {
  const h = harness();
  const t = await linked(h);
  assert.equal(h.repo.row(INF).status, "LINKED");
  await h.manager.shutdown();
  assert.equal(t.ended, true);

  const h2 = h.restart();
  await h2.tick();
  assert.equal(h2.transports.length, 1);
  assert.equal(h2.repo.row(INF).status, "RECONNECTING");
  assert.deepEqual(h2.last(INF).authStore.getCreds(), CREDS, "the stored login came back");
  assert.equal(h2.manager.isReady(INF), false);
  assert.equal(await h2.kv.get(kvKeys.qr(INF)), null, "no QR for a restored login");
  h2.last(INF).emitOpen({ phoneE164: PHONE, deviceLabel: null });
  await settle();
  assert.equal(h2.repo.row(INF).status, "LINKED");
  assert.equal(h2.manager.isReady(INF), true);
  assert.equal(h2.alerts.length, 0);
  await h2.manager.shutdown();
});

test("graceful shutdown flushes the stored login that was still waiting for its timer, and closes every socket", async () => {
  const h = harness();
  const t = await linked(h);
  const u = await linked(h, "inf-m2");
  t.authStore.setKeys({ session: { "peer.1": Buffer.from("ratchet-1") } });
  u.authStore.setKeys({ session: { "peer.2": Buffer.from("ratchet-2") } });
  assert.ok(h.authTimers.pending >= 2, "writes are waiting for the timer");
  const stored = h.repo.row(INF).authStateEnc;
  await h.manager.shutdown();
  assert.notEqual(h.repo.row(INF).authStateEnc, stored, "flushed on shutdown");
  assert.equal((openAuthBlob(INF, h.repo.row(INF).authStateEnc!).keys.session["peer.1"] as Buffer).toString(), "ratchet-1");
  assert.equal((openAuthBlob("inf-m2", h.repo.row("inf-m2").authStateEnc!).keys.session["peer.2"] as Buffer).toString(), "ratchet-2");
  assert.ok(t.ended && u.ended);
  assert.equal(h.repo.row(INF).status, "LINKED", "the sessions stay as they are, the next worker restores them");
  // After shutdown a pass does nothing.
  await h.manager.reconcile();
  assert.equal(h.transports.length, 2);
});

test("kill switch: WHATSAPP_QR_ENABLED=false disconnects everything and wipes every stored login", async () => {
  const h = harness();
  const t = await linked(h);
  h.repo.add(newRow("inf-idle", { status: "SUSPENDED", wantLinked: true, authStateEnc: "v1.stored.login.blob", suspendedReason: "paused" }));
  h.config.enabled = false;
  await h.tick();
  assert.equal(t.loggedOut, true, "unlinked on the phone's side too");
  assert.equal(h.manager.isReady(INF), false);
  for (const id of [INF, "inf-idle"]) {
    const row = h.repo.row(id);
    assert.equal(row.authStateEnc, null, `${id}: login deleted`);
    assert.equal(row.status, "NOT_LINKED");
    assert.equal(row.wantLinked, false);
    assert.equal(row.phoneE164, null);
  }
  assert.deepEqual(await h.manager.send({ influencerId: INF, toE164: "+919876500009", text: "x", bookingId: "b", key: "k" }), { ok: false, reason: "qr-disabled", retryable: false });
  assert.equal(await h.kv.get("wa-web:manager:alive"), null, "a disabled manager reports no heartbeat");
  await h.manager.shutdown();
});

test("kill switch with WHATSAPP_QR_KEEP_AUTH_WHEN_DISABLED=true keeps the encrypted login so that switching on again needs no scan", async () => {
  const h = harness({ config: { keepAuthWhenDisabled: true } });
  const t = await linked(h);
  h.config.enabled = false;
  await h.tick();
  assert.equal(t.ended, true);
  assert.equal(t.loggedOut, false, "not unlinked");
  const row = h.repo.row(INF);
  assert.ok(row.authStateEnc, "the login is kept");
  assert.equal(row.wantLinked, true);
  assert.equal(h.manager.isReady(INF), false);
  h.config.enabled = true;
  await h.tick();
  assert.equal(h.transports.length, 2);
  assert.deepEqual(h.last(INF).authStore.getCreds(), CREDS);
  h.last(INF).emitOpen({ phoneE164: PHONE, deviceLabel: null });
  await settle();
  assert.equal(h.repo.row(INF).status, "LINKED");
  await h.manager.shutdown();
});

test("WhatsApp restricting the number suspends it: the login is kept, the influencer is told, nothing is retried; start resumes without a scan", async () => {
  const h = harness();
  const t = await linked(h);
  t.emitClose({ reason: "restricted", code: "forbidden" });
  await settle();
  const row = h.repo.row(INF);
  assert.equal(row.status, "SUSPENDED");
  assert.match(row.suspendedReason!, /restrict/i);
  assert.equal(row.lastErrorCode, "whatsapp-restricted");
  assert.ok(row.authStateEnc, "kept so that resuming needs no new scan");
  assert.deepEqual(h.alerts.map((a) => a.kind), ["suspended"]);
  await h.clock.advance(20 * 60_000);
  await h.tick();
  assert.equal(h.transports.length, 1, "not retried");
  // The influencer presses start: the dashboard resets the status.
  Object.assign(h.repo.row(INF), { status: "NOT_LINKED", suspendedReason: null, lastErrorCode: null, consecutiveFailures: 0 });
  await h.tick();
  assert.equal(h.transports.length, 2);
  assert.equal(h.repo.row(INF).status, "RECONNECTING");
  assert.deepEqual(h.last(INF).authStore.getCreds(), CREDS);
  await h.manager.shutdown();
});

test("a stored login that cannot be decrypted suspends the number without deleting anything", async () => {
  const h = harness();
  want(h, INF, { status: "LINKED", linkedAt: new Date(), authStateEnc: "v1.AAAA.BBBB.CCCC" });
  await h.tick();
  assert.equal(h.transports.length, 0);
  const row = h.repo.row(INF);
  assert.equal(row.status, "SUSPENDED");
  assert.equal(row.lastErrorCode, "auth-unreadable");
  assert.equal(row.authStateEnc, "v1.AAAA.BBBB.CCCC", "kept: an operator may be able to fix the key");
  assert.deepEqual(h.alerts.map((a) => a.kind), ["suspended"]);
  // The influencer can still disconnect, which removes it.
  row.wantLinked = false;
  await h.tick();
  assert.equal(h.repo.row(INF).authStateEnc, null);
  assert.equal(h.repo.row(INF).status, "NOT_LINKED");
  await h.manager.shutdown();
});

test("an influencer who is deleted: the socket is closed", async () => {
  const h = harness();
  const t = await linked(h);
  h.repo.rows.delete(INF);
  await h.tick();
  assert.equal(t.ended, true);
  assert.equal(h.manager.isReady(INF), false);
  await h.manager.shutdown();
});

test("what an old transport says after a reconnect is ignored", async () => {
  const h = harness();
  const old = await linked(h);
  old.emitClose({ reason: "transient", code: "connection-closed" });
  await settle();
  await h.clock.advance(2_000);
  await h.tick();
  const fresh = h.last(INF);
  assert.notEqual(fresh, old);
  fresh.emitOpen({ phoneE164: PHONE, deviceLabel: null });
  await settle();
  old.emitClose({ reason: "logged-out", code: "logged-out" }); // a straggler
  old.emitQr("SECRET-STRAGGLER");
  await settle();
  assert.equal(h.repo.row(INF).status, "LINKED");
  assert.equal(h.alerts.length, 0);
  assert.equal(await h.kv.get(kvKeys.qr(INF)), null);
  await h.manager.shutdown();
});

test("a Redis that is down while a code is published does not break linking", async () => {
  const h = harness();
  h.kv.set = async () => {
    throw new Error("redis down");
  };
  want(h, INF);
  await h.tick();
  h.last(INF).emitQr("SECRET-QR-PAYLOAD-q");
  await settle();
  assert.equal(h.repo.row(INF).status, "PENDING_QR");
  assert.ok(h.logs.some((l) => /could not publish/.test(l)));
  assert.ok(!h.logs.join("\n").includes("SECRET-QR"));
  await h.manager.shutdown();
});

// ---- sending through the manager ----------------------------------------------------------------------------------------------

const msg = (n: number, over: Record<string, string> = {}) => ({ influencerId: INF, toE164: "+919876500010", text: `hello ${n}`, bookingId: `bk-${n}`, key: `bk-${n}:confirmation`, ...over });

test("send: a booking message goes out through the linked number, is counted, and its delivery state is reported", async () => {
  const h = harness();
  const t = await linked(h);
  const r = await h.clock.run(h.manager.send(msg(1)));
  assert.ok(r.ok);
  assert.equal(t.sent.length, 1);
  assert.deepEqual(t.sent[0], { to: "+919876500010", text: "hello 1", providerMessageId: r.ok ? r.providerMessageId : "" });
  assert.equal(h.repo.row(INF).sentTotal, 1);
  assert.deepEqual(h.guardCalls, [{ influencerId: INF, bookingId: "bk-1", toE164: "+919876500010" }]);
  t.emitDelivery(r.ok ? r.providerMessageId : "", "delivered");
  assert.deepEqual(h.deliveries, [{ influencerId: INF, providerMessageId: r.ok ? r.providerMessageId : "", status: "delivered" }]);
  await h.manager.shutdown();
});

test("send: refusals tell the caller whether to retry", async () => {
  const h = harness();
  // not linked at all
  assert.deepEqual(await h.manager.send(msg(1)), { ok: false, reason: "not-linked", retryable: false });
  const t = await linked(h);
  // no real booking for this number
  h.guardAnswer.allow = false;
  assert.deepEqual(await h.clock.run(h.manager.send(msg(2))), { ok: false, reason: "no-booking", retryable: false });
  h.guardAnswer.allow = true;
  assert.equal(t.sent.length, 0);
  // reconnecting: retry later
  t.emitClose({ reason: "transient", code: "connection-closed" });
  await settle();
  assert.deepEqual(await h.manager.send(msg(3)), { ok: false, reason: "not-connected", retryable: true });
  await h.manager.shutdown();
});

test("send: the self-test is allowed only to the number linked on this device", async () => {
  const h = harness();
  const t = await linked(h);
  const own = await h.clock.run(h.manager.send(msg(1, { toE164: PHONE, bookingId: SELF_TEST_BOOKING_ID, key: "self-test:1" })));
  assert.ok(own.ok);
  assert.equal(t.sent[0].to, PHONE);
  const other = await h.clock.run(h.manager.send(msg(2, { toE164: "+919876500011", bookingId: SELF_TEST_BOOKING_ID, key: "self-test:2" })));
  assert.deepEqual(other, { ok: false, reason: "no-booking", retryable: false });
  assert.equal(t.sent.length, 1);
  assert.deepEqual(h.guardCalls, [], "the booking check is not used to approve a self-test");
  await h.manager.shutdown();
});

test("send: three failed sends in a row suspend the number, tell the influencer and make every later call fall back at once", async () => {
  const h = harness({ config: { minGapMs: 1_000 } });
  const t = await linked(h);
  const err = () => new WhatsAppWebTransportError("boom", "send-failed", true);
  t.failSendWith(err(), err(), err());
  const out = [];
  for (const n of [1, 2, 3]) out.push(await h.clock.run(h.manager.send(msg(n))));
  await settle();
  assert.deepEqual(out.map((r) => (r.ok ? "ok" : r.reason)), ["send-failed", "send-failed", "circuit-open"]);
  const row = h.repo.row(INF);
  assert.equal(row.status, "SUSPENDED");
  assert.match(row.suspendedReason!, /three times/i);
  assert.equal(row.consecutiveFailures, 3);
  assert.deepEqual(h.alerts.map((a) => a.kind), ["suspended"]);
  assert.equal(h.manager.isReady(INF), false, "the fallback signal: callers stop asking this number");
  assert.ok(t.ended);
  assert.deepEqual(await h.manager.send(msg(4)), { ok: false, reason: "not-linked", retryable: false });
  await h.clock.advance(30 * 60_000);
  await h.tick();
  assert.equal(h.transports.length, 1, "not reconnected on its own");
  await h.manager.shutdown();
});

test("send: the daily cap and the spacing configured for the platform are applied to every number", async () => {
  const h = harness({ config: { dailyCap: 2, minGapMs: 7_000 } });
  const t = await linked(h);
  const times: number[] = [];
  const real = t.sendText.bind(t);
  t.sendText = async (to, text) => (times.push(h.clock.now()), real(to, text));
  const first = await h.clock.run(Promise.all([1, 2].map((n) => h.manager.send(msg(n)))));
  const out = [...first, await h.clock.run(h.manager.send(msg(3)))];
  assert.deepEqual(out.map((r) => (r.ok ? "ok" : r.reason)), ["ok", "ok", "daily-cap"]);
  assert.equal(times[1] - times[0], 7_000);
  await h.manager.shutdown();
});

test("incoming events do not exist: the manager has no way to receive a message", async () => {
  const h = harness();
  const t = await linked(h);
  const surface = Object.keys(t).concat(Object.getOwnPropertyNames(Object.getPrototypeOf(t)));
  assert.ok(!surface.some((k) => /message(s)?(upsert|received|incoming)|onMessage|history|chat/i.test(k)), surface.join(","));
  await h.manager.shutdown();
});
