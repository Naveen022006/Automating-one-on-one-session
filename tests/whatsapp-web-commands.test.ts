import "dotenv/config";
import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { istDate, kvKeys, MemoryKv, QR_TTL_MS } from "../lib/whatsapp-web/kv";
import { renderQrSvg } from "../lib/whatsapp-web/qr-svg";
import { CONSENT_VERSION, RISK_TEXT } from "../lib/whatsapp-web/types";
import { assertNoSecretKeys } from "./helpers/assert-no-secret-keys";

// The web side of the QR-code WhatsApp mode against the real tables: rows of our own, deleted in `after`. Redis is never touched
// (REDIS_URL is removed before anything loads) and no socket exists: the worker's part is covered by whatsapp-web-manager.test.ts.

delete process.env.REDIS_URL;
const skip = process.env.DATABASE_URL ? false : "DATABASE_URL not set";
const run = `${Date.now()}`;
const created: string[] = [];
const saved = { enabled: process.env.WHATSAPP_QR_ENABLED, fake: process.env.WHATSAPP_QR_FAKE, cap: process.env.WHATSAPP_QR_DAILY_CAP };

type Db = typeof import("../lib/db")["prisma"];
type Commands = typeof import("../lib/whatsapp-web/commands");
let prisma: Db;
let cmd: Commands;
let id = "";
const now = Date.UTC(2026, 10, 9, 10, 0, 0);

before(async () => {
  if (skip) return;
  ({ prisma } = await import("../lib/db"));
  cmd = await import("../lib/whatsapp-web/commands");
});

after(async () => {
  try {
    if (prisma && created.length) await prisma.influencer.deleteMany({ where: { id: { in: created } } });
  } catch (e) {
    console.error("cleanup failed", e instanceof Error ? e.message : e);
  } finally {
    for (const [k, v] of [["WHATSAPP_QR_ENABLED", saved.enabled], ["WHATSAPP_QR_FAKE", saved.fake], ["WHATSAPP_QR_DAILY_CAP", saved.cap]] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await prisma?.$disconnect();
  }
});

beforeEach(async () => {
  if (skip) return;
  process.env.WHATSAPP_QR_ENABLED = "true";
  delete process.env.WHATSAPP_QR_FAKE;
  delete process.env.WHATSAPP_QR_DAILY_CAP;
  const row = await prisma.influencer.create({ data: { slug: `wac-${created.length}-${run}`, name: "WAC", email: `wac-${created.length}-${run}@example.com` } });
  created.push(row.id);
  id = row.id;
});

const view = (kv = new MemoryKv(() => now)) => cmd.getWhatsAppWebView(id, { kv, now: () => now });

test("the QR image is an inline SVG made on the server: geometry only, never the payload as text, never script", () => {
  const svg = renderQrSvg("2@SECRET-PAYLOAD,abc,def");
  assert.match(svg, /^<svg /);
  assert.match(svg, /role="img"/);
  assert.match(svg, /viewBox="0 0 \d+ \d+"/);
  assert.ok(!/script|onload|onerror|href|SECRET|abc/i.test(svg));
  assert.ok(svg.length > 500 && svg.length < 60_000);
  assert.notEqual(renderQrSvg("a"), renderQrSvg("b"));
});

test("switched off: a small, harmless view and no way to start", { skip }, async () => {
  process.env.WHATSAPP_QR_ENABLED = "false";
  const v = await view();
  assert.equal(v.enabled, false);
  assert.equal(v.status, "not-linked");
  assert.equal(v.qrSvg, null);
  assert.equal(v.consentVersion, CONSENT_VERSION);
  assert.deepEqual(await cmd.requestLink(id, { consent: true, consentVersion: CONSENT_VERSION }), { ok: false, code: "disabled", message: "Linking WhatsApp by QR code is not available." });
  assert.equal(await prisma.whatsAppWebSession.count({ where: { influencerId: id } }), 0, "nothing was recorded");
});

test("a fresh influencer: not linked, with the risk statement and the limits; no row is created by looking", { skip }, async () => {
  process.env.WHATSAPP_QR_DAILY_CAP = "80";
  const v = await view();
  assert.deepEqual(
    { enabled: v.enabled, fake: v.fake, status: v.status, phoneMasked: v.phoneMasked, deviceLabel: v.deviceLabel, qrSvg: v.qrSvg, qrExpiresAt: v.qrExpiresAt, consentAt: v.consentAt, dailyCap: v.dailyCap, sentToday: v.sentToday, lastError: v.lastError, suspendedReason: v.suspendedReason, officialConnected: v.officialConnected },
    { enabled: true, fake: false, status: "not-linked", phoneMasked: null, deviceLabel: null, qrSvg: null, qrExpiresAt: null, consentAt: null, dailyCap: 80, sentToday: 0, lastError: null, suspendedReason: null, officialConnected: false },
  );
  assert.equal(v.riskText, RISK_TEXT);
  assert.equal(v.consentVersion, CONSENT_VERSION);
  assert.equal(await prisma.whatsAppWebSession.count({ where: { influencerId: id } }), 0);
});

test("start needs the explicit consent, in the current version, and records it", { skip }, async () => {
  for (const [input, code] of [
    [{ consent: false, consentVersion: CONSENT_VERSION }, "consent-required"],
    [{ consent: "true", consentVersion: CONSENT_VERSION }, "consent-required"],
    [{ consent: undefined, consentVersion: CONSENT_VERSION }, "consent-required"],
    [{ consent: true, consentVersion: "wa-web-old" }, "consent-outdated"],
    [{ consent: true, consentVersion: undefined }, "consent-outdated"],
  ] as const) {
    const r = await cmd.requestLink(id, input);
    assert.ok(!r.ok && r.code === code, JSON.stringify(input));
  }
  assert.equal(await prisma.whatsAppWebSession.count({ where: { influencerId: id } }), 0);

  const ok = await cmd.requestLink(id, { consent: true, consentVersion: CONSENT_VERSION });
  assert.deepEqual(ok, { ok: true });
  const row = await prisma.whatsAppWebSession.findUniqueOrThrow({ where: { influencerId: id } });
  assert.equal(row.wantLinked, true);
  assert.equal(row.status, "NOT_LINKED", "the web app only asks; the worker does the rest");
  assert.equal(row.consentVersion, CONSENT_VERSION);
  assert.ok(row.consentAt && Date.now() - row.consentAt.getTime() < 60_000);
  const v = await view();
  assert.equal(v.status, "not-linked");
  assert.equal(v.consentAt, row.consentAt.toISOString());
});

test("while waiting for the scan the view carries the current code as an SVG that expires; an old code is not shown", { skip }, async () => {
  await cmd.requestLink(id, { consent: true, consentVersion: CONSENT_VERSION });
  await prisma.whatsAppWebSession.update({ where: { influencerId: id }, data: { status: "PENDING_QR" } });
  const kv = new MemoryKv(() => now);
  assert.equal((await view(kv)).qrSvg, null, "no code published yet");
  await kv.set(kvKeys.qr(id), JSON.stringify({ qr: "2@SECRET-PAYLOAD", issuedAt: now - 10_000 }), QR_TTL_MS);
  const v = await view(kv);
  assert.equal(v.status, "waiting-for-scan");
  assert.match(v.qrSvg!, /^<svg /);
  assert.ok(!v.qrSvg!.includes("SECRET-PAYLOAD"));
  assert.equal(v.qrExpiresAt, new Date(now - 10_000 + QR_TTL_MS).toISOString());
  // A code older than its life is not shown even if the store still has it.
  await kv.set(kvKeys.qr(id), JSON.stringify({ qr: "2@OLD", issuedAt: now - QR_TTL_MS - 1 }), QR_TTL_MS);
  assert.equal((await view(kv)).qrSvg, null);
  // Garbage in the store is ignored, not an error.
  await kv.set(kvKeys.qr(id), "not json", QR_TTL_MS);
  assert.equal((await view(kv)).qrSvg, null);
  // Once linked, no code is shown even if one is left behind.
  await kv.set(kvKeys.qr(id), JSON.stringify({ qr: "2@LEFT", issuedAt: now }), QR_TTL_MS);
  await prisma.whatsAppWebSession.update({ where: { influencerId: id }, data: { status: "LINKED", phoneE164: "+919876543210" } });
  assert.equal((await view(kv)).qrSvg, null);
});

test("linked: the number is masked, today's count and the limit are shown, and nothing secret is in the view", { skip }, async () => {
  await cmd.requestLink(id, { consent: true, consentVersion: CONSENT_VERSION });
  await prisma.whatsAppWebSession.update({
    where: { influencerId: id },
    data: { status: "LINKED", phoneE164: "+919876543210", deviceLabel: "Chrome (Mac OS)", authStateEnc: "v1.secret.secret.secret", sentTotal: 7 },
  });
  const kv = new MemoryKv(() => now);
  await kv.set(kvKeys.sent(id, istDate(now)), "12", 86_400_000);
  await kv.set(kvKeys.sent(id, "2026-11-08"), "99", 86_400_000);
  const v = await view(kv);
  assert.equal(v.status, "linked");
  assert.equal(v.phoneMasked, "+91 ••••••• 210");
  assert.ok(!JSON.stringify(v).includes("9876543210"), "the full number is not sent");
  assert.equal(v.deviceLabel, "Chrome (Mac OS)");
  assert.equal(v.sentToday, 12, "today's count only");
  assert.equal(v.dailyCap, 150);
  assert.ok(!JSON.stringify(v).includes("secret.secret"), "the stored login is never part of the view");
  assertNoSecretKeys(v);
  assert.deepEqual(Object.keys(v).sort(), [
    "consentAt", "consentVersion", "dailyCap", "deviceLabel", "enabled", "fake", "lastError", "officialConnected", "phoneMasked",
    "qrExpiresAt", "qrSvg", "riskText", "sentToday", "status", "suspendedReason",
  ]);
});

test("suspended and logged-out show why; the official connection is reported as the fallback", { skip }, async () => {
  await cmd.requestLink(id, { consent: true, consentVersion: CONSENT_VERSION });
  await prisma.whatsAppConnection.create({ data: { influencerId: id, wabaId: "1", phoneNumberId: `7${run}${created.length}`, tokenEnc: "v1.x.y.z" } });
  await prisma.whatsAppWebSession.update({
    where: { influencerId: id },
    data: { status: "SUSPENDED", suspendedReason: "Sending failed three times in a row.", lastErrorCode: "send-failures", lastErrorText: "Paused." },
  });
  const s = await view();
  assert.equal(s.status, "suspended");
  assert.equal(s.suspendedReason, "Sending failed three times in a row.");
  assert.deepEqual(s.lastError, { code: "send-failures", text: "Paused." });
  assert.equal(s.officialConnected, true);

  await prisma.whatsAppWebSession.update({ where: { influencerId: id }, data: { status: "LOGGED_OUT", wantLinked: false, lastErrorCode: "logged-out", lastErrorText: "Logged out.", suspendedReason: "stale" } });
  const l = await view();
  assert.equal(l.status, "logged-out");
  assert.equal(l.suspendedReason, null, "only shown while suspended");
  assert.equal(l.lastError?.code, "logged-out");
});

test("start again after a suspension or a logout clears the old state, so the worker begins afresh", { skip }, async () => {
  await cmd.requestLink(id, { consent: true, consentVersion: CONSENT_VERSION });
  await prisma.whatsAppWebSession.update({
    where: { influencerId: id },
    data: { status: "SUSPENDED", suspendedReason: "x", lastErrorCode: "send-failures", lastErrorText: "y", consecutiveFailures: 3 },
  });
  await cmd.requestLink(id, { consent: true, consentVersion: CONSENT_VERSION });
  const row = await prisma.whatsAppWebSession.findUniqueOrThrow({ where: { influencerId: id } });
  assert.deepEqual(
    { status: row.status, want: row.wantLinked, reason: row.suspendedReason, code: row.lastErrorCode, text: row.lastErrorText, failures: row.consecutiveFailures },
    { status: "NOT_LINKED", want: true, reason: null, code: null, text: null, failures: 0 },
  );
  // Pressing start while a link is already under way changes nothing.
  await prisma.whatsAppWebSession.update({ where: { influencerId: id }, data: { status: "PENDING_QR" } });
  await cmd.requestLink(id, { consent: true, consentVersion: CONSENT_VERSION });
  assert.equal((await prisma.whatsAppWebSession.findUniqueOrThrow({ where: { influencerId: id } })).status, "PENDING_QR");
});

test("cancel only gives up an unscanned attempt; disconnect works from any state; both are shown as done at once", { skip }, async () => {
  await cmd.requestLink(id, { consent: true, consentVersion: CONSENT_VERSION });
  await prisma.whatsAppWebSession.update({ where: { influencerId: id }, data: { status: "PENDING_QR" } });
  assert.deepEqual(await cmd.cancelLink(id), { ok: true });
  assert.equal((await prisma.whatsAppWebSession.findUniqueOrThrow({ where: { influencerId: id } })).wantLinked, false);
  const leaving = await view();
  assert.equal(leaving.status, "not-linked", "the worker has not finished, but the screen already says so");
  assert.equal(leaving.qrSvg, null);

  await cmd.requestLink(id, { consent: true, consentVersion: CONSENT_VERSION });
  await prisma.whatsAppWebSession.update({ where: { influencerId: id }, data: { status: "LINKED", phoneE164: "+919876543210" } });
  const refused = await cmd.cancelLink(id);
  assert.ok(!refused.ok && refused.code === "not-pending");
  assert.equal((await prisma.whatsAppWebSession.findUniqueOrThrow({ where: { influencerId: id } })).wantLinked, true);

  assert.deepEqual(await cmd.disconnectLink(id), { ok: true });
  assert.equal((await prisma.whatsAppWebSession.findUniqueOrThrow({ where: { influencerId: id } })).wantLinked, false);
  const gone = await view();
  assert.equal(gone.status, "not-linked");
  assert.equal(gone.phoneMasked, null, "the number is hidden while the unlink finishes");

  // Disconnecting something that was never linked is fine.
  const other = await prisma.influencer.create({ data: { slug: `wac-x-${run}`, name: "X", email: `wac-x-${run}@example.com` } });
  created.push(other.id);
  assert.deepEqual(await cmd.disconnectLink(other.id), { ok: true });
  assert.deepEqual(await cmd.cancelLink(other.id), { ok: true });
});

test("one influencer's commands never touch another's session", { skip }, async () => {
  const other = await prisma.influencer.create({ data: { slug: `wac-o-${run}`, name: "O", email: `wac-o-${run}@example.com` } });
  created.push(other.id);
  await cmd.requestLink(other.id, { consent: true, consentVersion: CONSENT_VERSION });
  await cmd.requestLink(id, { consent: true, consentVersion: CONSENT_VERSION });
  await cmd.disconnectLink(id);
  assert.equal((await prisma.whatsAppWebSession.findUniqueOrThrow({ where: { influencerId: other.id } })).wantLinked, true);
});

test("asked for but nobody is looking after it: with a shared store and no worker heartbeat the view says so", { skip }, async () => {
  await cmd.requestLink(id, { consent: true, consentVersion: CONSENT_VERSION });
  process.env.REDIS_URL = "redis://127.0.0.1:1/0"; // only read as "a shared store is configured"; the injected store is used, nothing connects
  try {
    const kv = new MemoryKv(() => now);
    const without = await view(kv);
    assert.equal(without.lastError?.code, "worker-not-running");
    await kv.set("wa-web:manager:alive", "1", 15_000);
    assert.equal((await view(kv)).lastError, null);
  } finally {
    delete process.env.REDIS_URL;
  }
  assert.equal((await view()).lastError, null, "without a shared store there is nothing to tell");
});

test("disconnect then start inside the worker's loop: the web side never writes the status, so a socket that is still open keeps its LINKED row", { skip }, async () => {
  await cmd.requestLink(id, { consent: true, consentVersion: CONSENT_VERSION });
  await prisma.whatsAppWebSession.update({ where: { influencerId: id }, data: { status: "LINKED", phoneE164: "+919876543210", deviceLabel: "Chrome", lastErrorCode: "x", consecutiveFailures: 1 } });
  await cmd.disconnectLink(id);
  await cmd.requestLink(id, { consent: true, consentVersion: CONSENT_VERSION });
  const row = await prisma.whatsAppWebSession.findUniqueOrThrow({ where: { influencerId: id } });
  assert.equal(row.status, "LINKED");
  assert.equal(row.wantLinked, true);
  assert.equal(row.phoneE164, "+919876543210");
  assert.equal(row.lastErrorCode, "x", "nothing but the request and the consent was written");
  assert.equal(row.consecutiveFailures, 1);
  assert.equal((await view()).status, "linked");
  // The same for a session that is reconnecting or waiting for a scan.
  for (const status of ["RECONNECTING", "PENDING_QR"] as const) {
    await prisma.whatsAppWebSession.update({ where: { influencerId: id }, data: { status, wantLinked: false } });
    await cmd.requestLink(id, { consent: true, consentVersion: CONSENT_VERSION });
    assert.equal((await prisma.whatsAppWebSession.findUniqueOrThrow({ where: { influencerId: id } })).status, status);
  }
});
