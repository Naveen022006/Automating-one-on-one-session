// Integration test of the QR-code WhatsApp endpoints (influencer and admin): the gates, the exact response key sets, consent, the
// test message (self only, one a minute), the activity entries, and the administrator's force-disconnect with its audit row. Needs
// DATABASE_URL, TOKEN_ENCRYPTION_KEY and APP_SECRET (skipped otherwise).
//
// Only `next/headers` (the cookie a request carries) is replaced. Redis is never touched, the test queue is a stand-in that runs the
// worker's function in-process against a fake sender, and no socket exists. Every row is timestamped and deleted in `after`.
import "dotenv/config";
import assert from "node:assert/strict";
import { after, before, beforeEach, mock, test } from "node:test";
import { hashPassword } from "../lib/auth/password";
import { hashToken, randomToken } from "../lib/auth/tokens";
import { prisma } from "../lib/db";
import { kvKeys, MemoryKv, QR_TTL_MS, setKv } from "../lib/whatsapp-web/kv";
import { SELF_TEST_BOOKING_ID, type WhatsAppWebSendRequest, type WhatsAppWebSendResult } from "../lib/whatsapp-web/send";
import { CONSENT_VERSION } from "../lib/whatsapp-web/types";
import { assertNoSecretKeys } from "./helpers/assert-no-secret-keys";

const skip = process.env.DATABASE_URL && process.env.TOKEN_ENCRYPTION_KEY && process.env.APP_SECRET ? false : "DATABASE_URL / TOKEN_ENCRYPTION_KEY / APP_SECRET not set";
const run = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
const PASSWORD = "correct-horse-battery-9";
const LOGIN_SENTINEL = "SENTINEL-STORED-LOGIN-BLOB";
const PHONE = "+919876500123";
const QR_SECRET = "2@SECRET-QR-PAYLOAD-xyz,abc";

const ENV_KEYS = ["ADMIN_REQUIRE_2FA", "RATE_LIMIT_STORE", "REDIS_URL", "MESSAGING_DRY_RUN", "APP_URL", "WHATSAPP_QR_ENABLED", "WHATSAPP_QR_FAKE", "WHATSAPP_QR_DAILY_CAP"] as const;
const savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};
let envSaved = false;

const jar = new Map<string, string>();
type Answer = { status: number; body: Record<string, unknown>; headers: Headers };
type Ctx = { params: Promise<{ influencerId: string }> };
let influencerRoute: { GET: () => Promise<Response>; POST: (req: Request) => Promise<Response> };
let adminListRoute: { GET: (req: Request) => Promise<Response> };
let adminOneRoute: { GET: (req: Request, ctx: Ctx) => Promise<Response>; POST: (req: Request, ctx: Ctx) => Promise<Response> };
let sessionLib: typeof import("../lib/admin/session");
let authLib: typeof import("../lib/auth/session");
let testSend: typeof import("../lib/whatsapp-web/test-send");
let adminLib: typeof import("../lib/admin/whatsapp-web");
let kv: MemoryKv;

let A = "";
let B = "";
let aCookie = "";
let bCookie = "";
let aSessionId = "";
let adminX = "";
let adminY = "";
let xToken = "";
let yToken = "";
const created = { influencers: [] as string[], users: [] as string[], admins: [] as string[] };
const sends: WhatsAppWebSendRequest[] = [];
const ctl = { send: (req: WhatsAppWebSendRequest): WhatsAppWebSendResult => ({ ok: true, providerMessageId: `T-${req.key}` }), enqueue: "run" as "run" | "throw" | "ignore" };
let enqueued = 0;

const keys = (o: unknown) => Object.keys(o as object).sort();
const VIEW_KEYS = ["consentAt", "consentVersion", "dailyCap", "deviceLabel", "enabled", "fake", "lastError", "officialConnected", "phoneMasked", "qrExpiresAt", "qrSvg", "riskText", "sentToday", "status", "suspendedReason"];
const ADMIN_VIEW_KEYS = [
  "canForceDisconnect", "consentAt", "consentVersion", "dailyCap", "deviceLabel", "enabled", "influencerId", "lastConnectedAt", "lastError", "linkedAt", "phoneMasked", "sentToday", "sentTotal", "status", "suspendedReason", "wantLinked",
];

function as(cookies: Record<string, string>) {
  jar.clear();
  for (const [k, v] of Object.entries(cookies)) jar.set(k, v);
}
async function answer(res: Response): Promise<Answer> {
  return { status: res.status, body: (await res.json()) as Record<string, unknown>, headers: res.headers };
}
const influencerCookie = (token: string) => ({ [authLib.sessionCookieName()]: token });
const adminCookie = (token: string) => ({ [sessionLib.adminCookieName()]: token });

const json = (url: string, body: unknown) => new Request(url, { method: "POST", headers: { "content-type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body) });
const getMine = async (cookies: Record<string, string> = influencerCookie(aCookie)) => (as(cookies), answer(await influencerRoute.GET()));
const postMine = async (body: unknown, cookies: Record<string, string> = influencerCookie(aCookie)) => (as(cookies), answer(await influencerRoute.POST(json("http://localhost/api/dashboard/whatsapp-web", body))));
const adminGet = async (token: string, query = "") => (as(adminCookie(token)), answer(await adminListRoute.GET(new Request(`http://localhost/api/admin/whatsapp-web${query}`))));
const adminOne = async (token: string, id: string) => (as(adminCookie(token)), answer(await adminOneRoute.GET(new Request(`http://localhost/api/admin/whatsapp-web/${id}`), { params: Promise.resolve({ influencerId: id }) })));
const adminPost = async (token: string, id: string, body: unknown) =>
  (as(adminCookie(token)), answer(await adminOneRoute.POST(json(`http://localhost/api/admin/whatsapp-web/${id}`, body), { params: Promise.resolve({ influencerId: id }) })));

const sessionRow = (id = A) => prisma.whatsAppWebSession.findUnique({ where: { influencerId: id } });
const activity = (id = A) => prisma.influencerActivity.findMany({ where: { influencerId: id, action: { startsWith: "whatsapp_web." } }, orderBy: { createdAt: "asc" } });
const audits = (id = A) => prisma.adminAuditLog.findMany({ where: { action: "whatsapp_web.force_disconnect", targetId: id } });
async function setRow(patch: Record<string, unknown>, id = A) {
  await prisma.whatsAppWebSession.upsert({ where: { influencerId: id }, create: { influencerId: id, ...patch } as never, update: patch as never });
}
async function clearRows() {
  await prisma.whatsAppWebSession.deleteMany({ where: { influencerId: { in: [A, B] } } });
  await prisma.influencerActivity.deleteMany({ where: { influencerId: { in: [A, B] } } });
  await prisma.adminAuditLog.deleteMany({ where: { action: "whatsapp_web.force_disconnect", targetId: { in: [A, B] } } });
}

before(async () => {
  if (skip) return;
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  envSaved = true;
  process.env.RATE_LIMIT_STORE = "memory";
  process.env.MESSAGING_DRY_RUN = "true";
  process.env.APP_URL = "http://localhost:3000";
  kv = new MemoryKv();
  setKv(kv);

  mock.module("next/headers", {
    namedExports: {
      cookies: async () => ({ get: (name: string) => (jar.has(name) ? { name, value: jar.get(name) } : undefined) }),
      headers: async () => new Headers(),
    },
  });
  sessionLib = await import("../lib/admin/session");
  authLib = await import("../lib/auth/session");
  testSend = await import("../lib/whatsapp-web/test-send");
  adminLib = await import("../lib/admin/whatsapp-web");
  influencerRoute = await import("../app/api/dashboard/whatsapp-web/route");
  adminListRoute = await import("../app/api/admin/whatsapp-web/route");
  adminOneRoute = await import("../app/api/admin/whatsapp-web/[influencerId]/route");
  const mfa = await import("../lib/admin/mfa");
  const totp = await import("../lib/admin/totp");

  // The queue stand-in: what the worker does with the job, in this process, against a fake sender.
  testSend.setTestEnqueue(async (job) => {
    enqueued += 1;
    if (ctl.enqueue === "throw") throw new Error("redis down");
    if (ctl.enqueue === "ignore") return;
    await testSend.runTestSend(job, {
      kv,
      send: async (req) => {
        sends.push(req);
        return ctl.send(req);
      },
    });
  });

  for (const [slug, label] of [["a", "A"], ["b", "B"]] as const) {
    const inf = await prisma.influencer.create({ data: { slug: `wae${slug}-${run}`, name: `Web ${label}`, email: `wae-${slug}-${run}@example.com`, onboardedAt: new Date() } });
    created.influencers.push(inf.id);
    const user = await prisma.user.create({
      data: { email: `wae-user-${slug}-${run}@example.com`, passwordHash: "not-a-real-hash", emailVerifiedAt: new Date(), termsAcceptedAt: new Date(), influencerId: inf.id },
    });
    created.users.push(user.id);
    const cookie = await authLib.createSession(user.id);
    if (slug === "a") {
      A = inf.id;
      aCookie = cookie;
      aSessionId = (await prisma.authSession.findFirstOrThrow({ where: { userId: user.id } })).id;
    } else {
      B = inf.id;
      bCookie = cookie;
    }
  }

  const hash = await hashPassword(PASSWORD);
  adminX = (await prisma.adminUser.create({ data: { email: `wae-x-${run}@example.com`, name: "Web Admin X", passwordHash: hash } })).id; // has 2FA
  adminY = (await prisma.adminUser.create({ data: { email: `wae-y-${run}@example.com`, name: "Web Admin Y", passwordHash: hash } })).id; // does not
  created.admins.push(adminX, adminY);
  const past = Date.now() - 60_000;
  const secret = (await mfa.startTotpEnrollment(adminX)).secret;
  assert.ok((await mfa.confirmTotpEnrollment(adminX, totp.totpAt(secret, past), null, past)).ok);
  // Two sessions: X's password-only one (a 2FA admin who has not passed the second factor) and Y's, which is complete.
  for (const [adminId, which] of [[adminX, "x"], [adminY, "y"]] as const) {
    const token = randomToken();
    await prisma.adminSession.create({ data: { tokenHash: hashToken(token), adminId, expiresAt: new Date(Date.now() + 3_600_000) } });
    if (which === "x") xToken = token;
    else yToken = token;
  }
});

beforeEach(async () => {
  if (skip) return;
  process.env.WHATSAPP_QR_ENABLED = "true";
  delete process.env.WHATSAPP_QR_FAKE;
  delete process.env.WHATSAPP_QR_DAILY_CAP;
  ctl.enqueue = "run";
  ctl.send = (req) => ({ ok: true, providerMessageId: `T-${req.key}` });
  sends.length = 0;
  enqueued = 0;
  await kv.close();
  await clearRows();
  await prisma.authSession.update({ where: { id: aSessionId }, data: { authenticatedAt: new Date() } });
});

after(async () => {
  testSend?.setTestEnqueue(null);
  setKv(null);
  const step = async (what: string, fn: () => Promise<unknown>) => {
    try {
      await fn();
    } catch (e) {
      console.error(`[whatsapp-web-endpoints] cleanup step failed (${what}):`, e instanceof Error ? e.message : e);
    }
  };
  try {
    if (!skip) {
      await step("audit rows", () => prisma.adminAuditLog.deleteMany({ where: { adminEmail: { in: [`wae-x-${run}@example.com`, `wae-y-${run}@example.com`] } } }));
      await step("admin sessions", () => prisma.adminSession.deleteMany({ where: { adminId: { in: created.admins } } }));
      await step("admins", () => prisma.adminUser.deleteMany({ where: { id: { in: created.admins } } }));
      await step("auth sessions", () => prisma.authSession.deleteMany({ where: { userId: { in: created.users } } }));
      await step("users", () => prisma.user.deleteMany({ where: { id: { in: created.users } } }));
      await step("influencers", () => prisma.influencer.deleteMany({ where: { id: { in: created.influencers } } }));
    }
  } finally {
    if (envSaved) for (const k of ENV_KEYS) if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k];
    await prisma.$disconnect();
  }
});

// ---- the influencer's endpoint: gates ----------------------------------------------------------------------------------------

test("signed out: 401 on every method, whatever the body", { skip }, async () => {
  assert.equal((await getMine({})).status, 401);
  assert.equal((await postMine({ action: "test" }, {})).status, 401);
  assert.equal((await postMine({ action: "nonsense" }, {})).status, 401, "the identity is checked before the body");
  assert.equal((await postMine("not json", {})).status, 401);
  assert.equal(await sessionRow(), null, "nothing was written");
});

test("GET: the exact key set, private and uncacheable, no secret key anywhere, the stored login and the QR text never in the body", { skip }, async () => {
  await setRow({ status: "LINKED", wantLinked: true, phoneE164: PHONE, authStateEnc: LOGIN_SENTINEL, consentAt: new Date(), consentVersion: CONSENT_VERSION });
  const r = await getMine();
  assert.equal(r.status, 200);
  assert.deepEqual(keys(r.body), VIEW_KEYS);
  assert.equal(r.headers.get("cache-control"), "private, no-store");
  assert.equal(r.headers.get("access-control-allow-origin"), null);
  assert.equal(r.body.status, "linked");
  assert.equal(r.body.phoneMasked, "+91 ••••••• 123");
  assert.equal(r.body.qrSvg, null);
  assertNoSecretKeys(r.body);
  const text = JSON.stringify(r.body);
  assert.ok(!text.includes(LOGIN_SENTINEL) && !text.includes("9876500123"), "neither the login nor the full number");
});

test("GET: the QR picture is present while waiting for a scan, is only geometry, and is gone from the answers of cancel and disconnect", { skip }, async () => {
  await setRow({ status: "PENDING_QR", wantLinked: true });
  await kv.set(kvKeys.qr(A), JSON.stringify({ qr: QR_SECRET, issuedAt: Date.now() }), QR_TTL_MS);
  const g = await getMine();
  assert.match(String(g.body.qrSvg), /^<svg /);
  assert.ok(typeof g.body.qrExpiresAt === "string");
  assert.ok(!JSON.stringify(g.body).includes("SECRET-QR"), "the payload itself is not in the answer");
  assertNoSecretKeys(g.body);

  const c = await postMine({ action: "cancel" });
  assert.equal(c.status, 200);
  assert.deepEqual(keys(c.body), VIEW_KEYS);
  assert.equal(c.body.qrSvg, null);
  assert.equal(c.body.status, "not-linked");
  await setRow({ status: "PENDING_QR", wantLinked: true });
  const d = await postMine({ action: "disconnect" });
  assert.equal(d.body.qrSvg, null);
});

test("POST start: the body is validated (400), the version must be the current one (409), the flag must be on (409), nothing is written on a refusal", { skip }, async () => {
  assert.equal((await postMine({})).status, 400);
  assert.equal((await postMine({ action: "start" })).status, 400);
  assert.equal((await postMine({ action: "start", consent: "yes", consentVersion: CONSENT_VERSION })).status, 400);
  assert.equal((await postMine({ action: "start", consent: true })).status, 400);
  assert.equal((await postMine({ action: "start", consent: true, consentVersion: "x".repeat(101) })).status, 400);
  assert.equal((await postMine("{broken")).status, 400);
  assert.equal((await postMine({ action: "start", consent: true, consentVersion: "wa-web-1999" })).status, 409);

  const noConsent = await postMine({ action: "start", consent: false, consentVersion: CONSENT_VERSION });
  assert.equal(noConsent.status, 400);
  assert.equal(noConsent.body.code, "consent-required");
  const stale = await postMine({ action: "start", consent: true, consentVersion: "wa-web-1999" });
  assert.equal(stale.body.code, "consent-outdated");

  process.env.WHATSAPP_QR_ENABLED = "false";
  const off = await postMine({ action: "start", consent: true, consentVersion: CONSENT_VERSION });
  assert.equal(off.status, 409);
  assert.equal(off.body.code, "disabled");
  assert.equal(await sessionRow(), null);
  assert.equal((await activity()).length, 0);
});

test("POST start: consent is recorded with its version and time, the worker is asked (wantLinked), the answer is the view, and a repeat adds nothing", { skip }, async () => {
  const before = Date.now();
  const r = await postMine({ action: "start", consent: true, consentVersion: CONSENT_VERSION });
  assert.equal(r.status, 200);
  assert.deepEqual(keys(r.body), VIEW_KEYS);
  assertNoSecretKeys(r.body);
  const row = await sessionRow();
  assert.equal(row?.wantLinked, true);
  assert.equal(row?.consentVersion, CONSENT_VERSION);
  assert.ok(row?.consentAt && row.consentAt.getTime() >= before - 1_000);
  assert.equal(r.body.consentVersion, CONSENT_VERSION);
  assert.equal(typeof r.body.consentAt, "string");
  const entries = await activity();
  assert.deepEqual(entries.map((e) => [e.action, e.detail]), [["whatsapp_web.consent", { version: CONSENT_VERSION }]]);

  // Pressing start again while the first is under way changes nothing.
  await prisma.whatsAppWebSession.update({ where: { influencerId: A }, data: { status: "PENDING_QR" } });
  assert.equal((await postMine({ action: "start", consent: true, consentVersion: CONSENT_VERSION })).status, 200);
  assert.equal((await activity()).length, 1);
});

test("the influencer is always the signed-in one: ids in the body or the query are ignored, and another influencer's row is never touched", { skip }, async () => {
  await setRow({ status: "LINKED", wantLinked: true, phoneE164: "+919876500777", authStateEnc: LOGIN_SENTINEL }, B);
  const r = await postMine({ action: "start", consent: true, consentVersion: CONSENT_VERSION, influencerId: B });
  assert.equal(r.status, 200);
  await postMine({ action: "disconnect", influencerId: B });
  const b = await sessionRow(B);
  assert.equal(b?.wantLinked, true);
  assert.equal(b?.authStateEnc, LOGIN_SENTINEL);
  assert.equal((await activity(B)).length, 0);
  // B sees B's own state, not A's.
  assert.equal((await getMine(influencerCookie(bCookie))).body.status, "linked");
  assert.equal((await getMine(influencerCookie(aCookie))).body.status, "not-linked", "A started a link of their own (no worker here to pick it up); B's linked number is not shown to A");
});

test("starting needs a recent password entry (401 with reauth), and nothing changes without it; cancel, disconnect and test do not", { skip }, async () => {
  await prisma.authSession.update({ where: { id: aSessionId }, data: { authenticatedAt: new Date(Date.now() - 9 * 3_600_000) } });
  const stale = await postMine({ action: "start", consent: true, consentVersion: CONSENT_VERSION });
  assert.equal(stale.status, 401);
  assert.equal(stale.body.reauth, true);
  assert.equal(await sessionRow(), null);
  assert.equal((await getMine()).status, 200);
  assert.equal((await postMine({ action: "cancel" })).status, 200);
  assert.equal((await postMine({ action: "disconnect" })).status, 200);
});

test("cancel: gives up an unscanned link; a number that is already linked answers 409 (use disconnect)", { skip }, async () => {
  await setRow({ status: "PENDING_QR", wantLinked: true });
  assert.equal((await postMine({ action: "cancel" })).status, 200);
  assert.equal((await sessionRow())?.wantLinked, false);
  await setRow({ status: "LINKED", wantLinked: true, phoneE164: PHONE });
  const r = await postMine({ action: "cancel" });
  assert.equal(r.status, 409);
  assert.equal(r.body.code, "not-pending");
  assert.equal((await sessionRow())?.wantLinked, true);
});

test("disconnect: always allowed (even with the platform flag off), asks the worker to unlink, and leaves one entry with the masked number only", { skip }, async () => {
  await setRow({ status: "LINKED", wantLinked: true, phoneE164: PHONE, authStateEnc: LOGIN_SENTINEL });
  process.env.WHATSAPP_QR_ENABLED = "false";
  const r = await postMine({ action: "disconnect" });
  assert.equal(r.status, 200);
  assert.equal((await sessionRow())?.wantLinked, false);
  const again = await postMine({ action: "disconnect" });
  assert.equal(again.status, 200);
  const entries = await activity();
  assert.equal(entries.length, 1, "one entry for the disconnect; the repeat, while the worker is still finishing, records nothing");
  assert.deepEqual(entries[0].detail, { phone: "+91 ••••••• 123", reason: "influencer" });

  // A person who never linked anything: allowed, nothing recorded.
  await clearRows();
  assert.equal((await postMine({ action: "disconnect" })).status, 200);
  assert.equal((await activity()).length, 0);
});

test("the account activity never holds a full number, a QR code or the stored login", { skip }, async () => {
  await setRow({ status: "LINKED", wantLinked: true, phoneE164: PHONE, authStateEnc: LOGIN_SENTINEL });
  await postMine({ action: "disconnect" });
  await postMine({ action: "start", consent: true, consentVersion: CONSENT_VERSION });
  const text = JSON.stringify(await prisma.influencerActivity.findMany({ where: { influencerId: A } }));
  assert.ok(!/9876500123|SECRET-QR|SENTINEL/.test(text));
});

// ---- the test message ---------------------------------------------------------------------------------------------------------

test("test: needs a linked number and the flag (409 otherwise) and queues nothing", { skip }, async () => {
  const none = await postMine({ action: "test" });
  assert.equal(none.status, 409);
  assert.equal(none.body.code, "not-linked");
  await setRow({ status: "SUSPENDED", wantLinked: true, phoneE164: PHONE });
  assert.equal((await postMine({ action: "test" })).status, 409);
  await setRow({ status: "LINKED", wantLinked: true, phoneE164: PHONE });
  process.env.WHATSAPP_QR_ENABLED = "false";
  const off = await postMine({ action: "test" });
  assert.equal(off.status, 409);
  assert.equal(off.body.code, "disabled");
  assert.equal(enqueued, 0);
});

test("test: ONE message to the linked number itself (read from the database, never from the request), with no customer data; then a 60 s cooldown", { skip }, async () => {
  await setRow({ status: "LINKED", wantLinked: true, phoneE164: PHONE });
  const r = await postMine({ action: "test", to: "+919999999999", toE164: "+919999999999", text: "buy now", bookingId: "x" });
  assert.equal(r.status, 200);
  assert.deepEqual(keys(r.body), [...VIEW_KEYS, "test"].sort());
  assert.deepEqual(r.body.test, { state: "sent", message: null });
  assertNoSecretKeys(r.body);
  assert.equal(sends.length, 1);
  assert.equal(sends[0].toE164, PHONE, "the destination is the number linked on this device");
  assert.equal(sends[0].bookingId, SELF_TEST_BOOKING_ID);
  assert.equal(sends[0].influencerId, A);
  assert.match(sends[0].text, /^This is a test message from /);
  assert.ok(!sends[0].text.includes("buy now"));

  const second = await postMine({ action: "test" });
  assert.equal(second.status, 429);
  assert.equal(second.body.code, "cooldown");
  assert.equal(second.headers.get("retry-after"), "60");
  assert.equal(sends.length, 1);
  assert.equal(enqueued, 1);

  // The cooldown is per influencer, and ends.
  await setRow({ status: "LINKED", wantLinked: true, phoneE164: "+919876500888" }, B);
  assert.equal((await postMine({ action: "test" }, influencerCookie(bCookie))).status, 200);
  await kv.del(testSend.testKeys.cooldown(A));
  assert.equal((await postMine({ action: "test" })).status, 200);
  assert.equal(sends.length, 3);
});

test("test: a refused send is reported in plain words; a worker that cannot be reached is a 503 that does not use up the minute", { skip }, async () => {
  await setRow({ status: "LINKED", wantLinked: true, phoneE164: PHONE });
  ctl.send = () => ({ ok: false, reason: "daily-cap", retryable: false });
  const failed = await postMine({ action: "test" });
  assert.equal(failed.status, 200);
  assert.equal((failed.body.test as { state: string }).state, "failed");
  assert.match(String((failed.body.test as { message: string }).message), /daily limit/);

  await kv.del(testSend.testKeys.cooldown(A));
  ctl.enqueue = "throw";
  const down = await postMine({ action: "test" });
  assert.equal(down.status, 503);
  assert.equal(down.body.code, "unavailable");
  ctl.enqueue = "run";
  ctl.send = (req) => ({ ok: true, providerMessageId: `T-${req.key}` });
  assert.equal((await postMine({ action: "test" })).status, 200, "the failed attempt did not hold the cooldown");
});

test("test: a worker that is slow to answer gives 'pending' without claiming success; an old answer is never taken for a new request", { skip }, async () => {
  await setRow({ status: "LINKED", wantLinked: true, phoneE164: PHONE });
  await kv.set(testSend.testKeys.result(A), JSON.stringify({ requestId: "an-older-request", ok: true }), 60_000);
  ctl.enqueue = "ignore";
  let t = 0;
  const out = await testSend.requestTestSend(A, { kv, now: () => t, sleep: async (ms) => void (t += ms), waitMs: 2_000, pollMs: 500, newRequestId: () => "new-request" });
  assert.deepEqual(out, { ok: true, outcome: { state: "pending" } });
  assert.equal(sends.length, 0);
});

// ---- the administrator's endpoints --------------------------------------------------------------------------------------------

test("admin gates: 401 signed out, 403 for a password-only session of an admin with two-factor, 404 for an unknown or malformed id", { skip }, async () => {
  assert.equal((await adminGet("none")).status, 401);
  assert.equal((await adminOne("none", A)).status, 401);
  assert.equal((await adminPost("none", A, { action: "disconnect", reason: "Abuse report" })).status, 401);
  for (const call of [() => adminGet(xToken), () => adminGet(xToken, `?influencerId=${A}`), () => adminOne(xToken, A), () => adminPost(xToken, A, { action: "disconnect", reason: "Abuse report" })]) {
    const r = await call();
    assert.equal(r.status, 403);
    assert.equal(r.body.mfaRequired, true);
  }
  // An influencer's own session is not an admin session.
  assert.equal((await adminGet(aCookie)).status, 401);
  assert.equal((await adminGet(yToken, "?influencerId=does-not-exist")).status, 404);
  assert.equal((await adminGet(yToken, "?influencerId=../etc")).status, 404);
  assert.equal((await adminGet(yToken, "?influencerId=")).status, 404);
  assert.equal((await adminOne(yToken, "nope")).status, 404);
  assert.equal((await adminPost(yToken, "nope", { action: "disconnect", reason: "Abuse report" })).status, 404);
});

test("admin view: the exact key set, a masked number, no login, no QR, no full number; an influencer who never linked reads as not linked", { skip }, async () => {
  const never = await adminGet(yToken, `?influencerId=${A}`);
  assert.equal(never.status, 200);
  assert.deepEqual(keys(never.body), ADMIN_VIEW_KEYS);
  assert.equal(never.body.status, "not-linked");
  assert.equal(never.body.canForceDisconnect, false);
  assert.equal(never.headers.get("cache-control"), "private, no-store");

  await setRow({ status: "SUSPENDED", wantLinked: true, phoneE164: PHONE, authStateEnc: LOGIN_SENTINEL, suspendedReason: "Three sends failed", lastErrorCode: "send-failures", lastErrorText: "Paused", sentTotal: 7, consentVersion: CONSENT_VERSION, consentAt: new Date() });
  await kv.set(kvKeys.qr(A), JSON.stringify({ qr: QR_SECRET, issuedAt: Date.now() }), QR_TTL_MS);
  for (const r of [await adminGet(yToken, `?influencerId=${A}`), await adminOne(yToken, A)]) {
    assert.equal(r.status, 200);
    assert.deepEqual(keys(r.body), ADMIN_VIEW_KEYS);
    assert.equal(r.body.status, "suspended");
    assert.equal(r.body.phoneMasked, "+91 ••••••• 123");
    assert.equal(r.body.sentTotal, 7);
    assert.equal(r.body.suspendedReason, "Three sends failed");
    assert.deepEqual(r.body.lastError, { code: "send-failures", text: "Paused" });
    assert.equal(r.body.canForceDisconnect, true);
    assertNoSecretKeys(r.body);
    assert.ok(!/SENTINEL|SECRET-QR|9876500123|<svg/.test(JSON.stringify(r.body)));
  }
});

test("admin summary: platform-wide counts by state", { skip }, async () => {
  await setRow({ status: "LINKED", wantLinked: true, phoneE164: PHONE });
  await setRow({ status: "SUSPENDED", wantLinked: true, phoneE164: "+919876500888" }, B);
  const r = await adminGet(yToken);
  assert.equal(r.status, 200);
  assert.deepEqual(keys(r.body), ["enabled", "linked", "loggedOut", "reconnecting", "suspended", "waitingForScan"]);
  assert.ok((r.body.linked as number) >= 1 && (r.body.suspended as number) >= 1);
  assertNoSecretKeys(r.body);
});

test("force-disconnect: the reason is required (5 to 300 characters), the body is validated, nothing changes on a refusal", { skip }, async () => {
  await setRow({ status: "LINKED", wantLinked: true, phoneE164: PHONE, authStateEnc: LOGIN_SENTINEL });
  for (const body of [{}, { action: "disconnect" }, { action: "disconnect", reason: "ok" }, { action: "disconnect", reason: "x".repeat(301) }, { action: "wipe", reason: "Abuse report" }, { action: "disconnect", reason: "     " }]) {
    assert.equal((await adminPost(yToken, A, body)).status, 400, JSON.stringify(body).slice(0, 60));
  }
  assert.equal((await adminPost(yToken, A, "{broken")).status, 400);
  const row = await sessionRow();
  assert.equal(row?.wantLinked, true);
  assert.equal(row?.authStateEnc, LOGIN_SENTINEL);
  assert.equal((await audits()).length, 0);
});

test("force-disconnect: the link is cancelled and the stored login deleted, with ONE audit entry holding the reason; a repeat is a 409 with no second entry", { skip }, async () => {
  await setRow({ status: "LINKED", wantLinked: true, phoneE164: PHONE, authStateEnc: LOGIN_SENTINEL });
  const r = await adminPost(yToken, A, { action: "disconnect", reason: "  Reported for spam by two customers  " });
  assert.equal(r.status, 200);
  assert.deepEqual(keys(r.body), ["ok", "view"]);
  assert.equal(r.body.ok, true);
  assert.deepEqual(keys(r.body.view), ADMIN_VIEW_KEYS);
  assert.equal((r.body.view as { canForceDisconnect: boolean }).canForceDisconnect, false);
  const row = await sessionRow();
  assert.equal(row?.wantLinked, false);
  assert.equal(row?.authStateEnc, null, "the stored login is gone at once, not when the worker catches up");

  const trail = await audits();
  assert.equal(trail.length, 1);
  assert.equal(trail[0].adminEmail, `wae-y-${run}@example.com`);
  assert.equal(trail[0].targetType, "influencer");
  assert.deepEqual(trail[0].detail, { reason: "Reported for spam by two customers" });

  const entries = await activity();
  assert.deepEqual(entries.map((e) => [e.action, e.actor, e.detail]), [["whatsapp_web.disconnected", "system", { phone: "+91 ••••••• 123", reason: "admin" }]]);

  const again = await adminPost(yToken, A, { action: "disconnect", reason: "Reported for spam by two customers" });
  assert.equal(again.status, 409);
  assert.equal((await audits()).length, 1);
  assert.equal((await activity()).length, 1);
});

test("force-disconnect: an influencer with nothing linked is a 409 with no audit entry; a suspended number (login kept) can be removed", { skip }, async () => {
  const none = await adminPost(yToken, A, { action: "disconnect", reason: "Nothing there" });
  assert.equal(none.status, 409);
  await setRow({ status: "LOGGED_OUT", wantLinked: false, authStateEnc: null });
  assert.equal((await adminPost(yToken, A, { action: "disconnect", reason: "Already logged out" })).status, 409);
  assert.equal((await audits()).length, 0);
  await setRow({ status: "SUSPENDED", wantLinked: true, phoneE164: PHONE, authStateEnc: LOGIN_SENTINEL });
  assert.equal((await adminPost(yToken, A, { action: "disconnect", reason: "Remove the kept login" })).status, 200);
  assert.equal((await sessionRow())?.authStateEnc, null);
});

test("force-disconnect: the change and its audit row are one transaction (an audit insert that fails leaves the session as it was)", { skip }, async () => {
  await setRow({ status: "LINKED", wantLinked: true, phoneE164: PHONE, authStateEnc: LOGIN_SENTINEL });
  await assert.rejects(adminLib.forceDisconnectWhatsAppWeb({ adminId: "no-such-admin", email: "ghost@example.com" }, A, "Atomicity check", null));
  const row = await sessionRow();
  assert.equal(row?.wantLinked, true);
  assert.equal(row?.authStateEnc, LOGIN_SENTINEL);
  assert.equal((await audits()).length, 0);
  assert.equal((await activity()).length, 0, "and no activity entry for something that did not happen");
});
