// WP-D customer portal ("find your bookings", doc/13-product-build-plan.md): the gate and abuse cases, the exact key sets and the
// erase rules, against the real routes and the database (skipped without DATABASE_URL). Nothing here sends a real e-mail: the e-mail
// sender is replaced by a capture, and APP_URL / APP_SECRET / RATE_LIMIT_STORE are set in `before` and put back in `after`.
//   POST /api/customer/access        GET /api/customer/portal/:token        GET .../export        POST .../erase
import "dotenv/config";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { BookingStatus, PaymentStatus } from "../generated/prisma/client";
import { prisma } from "../lib/db";
import { setEmailSender } from "../lib/email";
import { hashToken, randomToken } from "../lib/auth/tokens";
import { matchRouteRule } from "../lib/rate-limit/policies";
import { loggablePath } from "../lib/rate-limit/redact";
import { BOOKING_PAY_PURPOSE, SELF_SERVICE_PURPOSE } from "../lib/self-service";
import { signToken } from "../lib/signing";
import { assertNoSecretKeys } from "./helpers/assert-no-secret-keys";

const skip = process.env.DATABASE_URL ? false : "DATABASE_URL not set";
const run = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const ENV_KEYS = ["RATE_LIMIT_STORE", "APP_URL", "APP_SECRET", "READINESS_REQUIRED"] as const;
const originalEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]])) as Record<(typeof ENV_KEYS)[number], string | undefined>;

type Ctx = { params: Promise<{ token: string }> };
let accessRoute: (req: Request) => Promise<Response>;
let portalRoute: (req: Request, ctx: Ctx) => Promise<Response>;
let exportRoute: (req: Request, ctx: Ctx) => Promise<Response>;
let eraseRoute: (req: Request, ctx: Ctx) => Promise<Response>;
let lib: typeof import("../lib/customer-portal");
let sweep: typeof import("../lib/customer-access-sweep");

// Everything this file creates is found again by these names, so a `before` that dies half way still leaves nothing behind.
const slugA = `portal-a-${run}`;
const slugB = `portal-b-${run}`;
const c1 = `portal-c1-${run}@example.com`;
const c2 = `portal-c2-${run}@example.com`;
const holdOnly = `portal-hold-${run}@example.com`;
const redactedOnly = `portal-red-${run}@example.com`;
const unknown = `portal-nobody-${run}@example.com`;
const limitedAddr = `portal-limit-${run}@example.com`;
const slowAddr = `portal-slow-${run}@example.com`;
const emails = [c1, c2, holdOnly, redactedOnly, unknown, limitedAddr, slowAddr];
let influencerA = "";
let influencerB = "";
const svc = { a: "", aGroup: "", b: "" };
const auditIds: string[] = [];

interface Sent {
  to: string;
  subject: string;
  text: string;
  html: string;
}
let sent: Sent[] = [];
let gate: Promise<void> | null = null;
const sentTo = (email: string) => sent.filter((m) => m.to === email);

let seq = 0;
interface SeedOptions {
  serviceId: string;
  email: string;
  status: BookingStatus;
  /** Session start, ms from now. */
  startIn: number;
  name?: string;
  holdExpiresAt?: Date | null;
  redactedAt?: Date | null;
  sessionId?: string;
  intake?: unknown;
  payment?: { status: PaymentStatus; needsRefund?: boolean; refundedMinor?: number; refundStatus?: string };
}

async function seed(o: SeedOptions) {
  const n = ++seq;
  const start = new Date(Math.floor((Date.now() + o.startIn) / 1000) * 1000 + n * 1000);
  const session =
    o.sessionId !== undefined
      ? await prisma.session.findUniqueOrThrow({ where: { id: o.sessionId } })
      : await prisma.session.create({ data: { serviceId: o.serviceId, startTime: start, endTime: new Date(start.getTime() + 30 * 60_000) } });
  const booking = await prisma.booking.create({
    data: {
      sessionId: session.id,
      status: o.status,
      holdExpiresAt: o.holdExpiresAt ?? null,
      customerName: o.name ?? `Portal Customer ${n}`,
      customerEmail: o.email,
      whatsappE164: `+9198765${String(20000 + n).slice(-5)}`,
      whatsappOptIn: true,
      customerTz: "Asia/Kolkata",
      redactedAt: o.redactedAt ?? null,
      meetLink: `https://meet.google.com/portal-${n}`,
      ...(o.intake !== undefined ? { intakeAnswers: o.intake as object } : {}),
    },
  });
  let paymentId: string | null = null;
  if (o.payment) {
    const p = await prisma.payment.create({
      data: {
        bookingId: booking.id,
        providerOrderId: `order_portal_${run}_${n}`,
        providerPaymentId: `pay_portal_${run}_${n}`,
        amountMinor: 49900,
        currency: "INR",
        status: o.payment.status,
        needsRefund: o.payment.needsRefund ?? false,
        refundAmountMinor: o.payment.refundedMinor ?? null,
        refundStatus: o.payment.refundStatus ?? null,
      },
    });
    paymentId = p.id;
  }
  return { booking, session, paymentId };
}

const fixture = {} as Record<"a1" | "a2" | "b1" | "b2" | "b3" | "h1" | "x1" | "r1" | "g1" | "g2" | "c2a" | "hold" | "red", { booking: { id: string }; session: { id: string }; paymentId: string | null }>;

const post = (url: string, body: unknown) =>
  new Request(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body) });
const get = (url: string) => new Request(url);
const ctx = (token: string): Ctx => ({ params: Promise.resolve({ token }) });

interface Answer {
  status: number;
  headers: Headers;
  text: string;
  body: Record<string, unknown>;
}
async function answer(res: Response): Promise<Answer> {
  const text = await res.text();
  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    /* not JSON */
  }
  return { status: res.status, headers: res.headers, text, body };
}
const askAccess = async (email: unknown) => answer(await accessRoute(post("http://localhost/api/customer/access", { email })));
const getPortal = async (token: string) => answer(await portalRoute(get("http://localhost/api/customer/portal/x"), ctx(token)));
const getExport = async (token: string) => answer(await exportRoute(get("http://localhost/api/customer/portal/x/export"), ctx(token)));
const doErase = async (token: string, body: unknown = { confirm: true }) => answer(await eraseRoute(post("http://localhost/api/customer/portal/x/erase", body), ctx(token)));
const keys = (o: unknown) => Object.keys(o as object).sort();

/** Waits until `fn` is true (the e-mail of a detached request has been captured), up to `ms`. */
async function until(fn: () => boolean, ms = 4000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return fn();
}

/** A portal token for `email`, valid for `ttlMs` from now (negative = already expired). Returns the raw token; the row holds only its hash. */
async function mintToken(email: string, ttlMs = HOUR): Promise<string> {
  const token = randomToken();
  await prisma.customerAccessToken.create({ data: { tokenHash: hashToken(token), email, expiresAt: new Date(Date.now() + ttlMs) } });
  return token;
}

/** Every console line written while `fn` runs. */
async function captureConsole<T>(fn: () => Promise<T>): Promise<{ result: T; output: string }> {
  const lines: string[] = [];
  const names = ["log", "error", "warn", "info"] as const;
  const originals = names.map((n) => console[n]);
  for (const n of names) console[n] = (...args: unknown[]) => void lines.push(args.map((a) => (a instanceof Error ? a.message : typeof a === "string" ? a : JSON.stringify(a))).join(" "));
  try {
    return { result: await fn(), output: lines.join("\n") };
  } finally {
    names.forEach((n, i) => (console[n] = originals[i]));
  }
}

before(async () => {
  if (skip) return;
  process.env.RATE_LIMIT_STORE = "memory";
  process.env.APP_URL = "http://localhost:3000";
  if (!process.env.APP_SECRET || process.env.APP_SECRET.length < 16) process.env.APP_SECRET = `portal-test-secret-${run}`;
  process.env.READINESS_REQUIRED = "";
  setEmailSender(async (email) => {
    if (gate && email.to.email === slowAddr) await gate;
    sent.push({ to: email.to.email, subject: email.subject, text: email.text, html: email.html });
    return { providerMessageId: null };
  });
  accessRoute = (await import("../app/api/customer/access/route")).POST;
  portalRoute = (await import("../app/api/customer/portal/[token]/route")).GET;
  exportRoute = (await import("../app/api/customer/portal/[token]/export/route")).GET;
  eraseRoute = (await import("../app/api/customer/portal/[token]/erase/route")).POST;
  lib = await import("../lib/customer-portal");
  sweep = await import("../lib/customer-access-sweep");

  influencerA = (await prisma.influencer.create({ data: { slug: slugA, name: `Portal Host A ${run}`, email: `portal-host-a-${run}@example.com`, timezone: "Asia/Kolkata", onboardedAt: new Date() } })).id;
  influencerB = (await prisma.influencer.create({ data: { slug: slugB, name: `Portal Host B ${run}`, email: `portal-host-b-${run}@example.com`, timezone: "Asia/Kolkata", onboardedAt: new Date() } })).id;
  const service = (influencerId: string, title: string, extra: object = {}) => prisma.service.create({ data: { influencerId, title, durationMin: 30, priceMinor: 49900, ...extra } }).then((s) => s.id);
  svc.a = await service(influencerA, `Career call ${run}`);
  svc.aGroup = await service(influencerA, `Group clinic ${run}`, { type: "GROUP", capacity: 5 });
  svc.b = await service(influencerB, `Portfolio review ${run}`);

  const intake = [{ id: "q1", label: "Your goal", answer: "Grow my channel" }];
  fixture.a1 = await seed({ serviceId: svc.a, email: c1, status: "COMPLETED", startIn: -10 * DAY, name: "Asha Rao", intake, payment: { status: "CAPTURED" } });
  fixture.a2 = await seed({ serviceId: svc.a, email: c1, status: "SCHEDULED", startIn: 5 * DAY, name: "Asha Rao", payment: { status: "CAPTURED" } });
  fixture.b1 = await seed({ serviceId: svc.b, email: c1, status: "PAID", startIn: -3 * DAY, name: "Asha Rao", payment: { status: "CAPTURED", refundedMinor: 10000, refundStatus: "processed" } });
  fixture.b2 = await seed({ serviceId: svc.b, email: c1, status: "CANCELLED", startIn: 4 * DAY, name: "Asha Rao", payment: { status: "REFUNDED", refundedMinor: 49900, refundStatus: "processed" } });
  fixture.b3 = await seed({ serviceId: svc.b, email: c1, status: "CANCELLED", startIn: 6 * DAY, name: "Asha Rao", payment: { status: "CAPTURED", needsRefund: true } });
  fixture.h1 = await seed({ serviceId: svc.a, email: c1, status: "HELD", startIn: 8 * DAY, name: "Asha Rao", holdExpiresAt: new Date(Date.now() + 10 * 60_000) });
  fixture.x1 = await seed({ serviceId: svc.a, email: c1, status: "EXPIRED", startIn: -20 * DAY, name: "Asha Rao" });
  fixture.r1 = await seed({ serviceId: svc.a, email: c1, status: "COMPLETED", startIn: -30 * DAY, name: "Erased customer", redactedAt: new Date(), payment: { status: "CAPTURED" } });
  // A group session two customers share: each sees only their own booking.
  fixture.g1 = await seed({ serviceId: svc.aGroup, email: c1, status: "COMPLETED", startIn: -2 * DAY, name: "Asha Rao", payment: { status: "CAPTURED" } });
  fixture.g2 = await seed({ serviceId: svc.aGroup, email: c2, status: "COMPLETED", startIn: 0, name: "Bela Other", sessionId: fixture.g1.session.id, payment: { status: "CAPTURED" } });
  fixture.c2a = await seed({ serviceId: svc.a, email: c2, status: "SCHEDULED", startIn: 2 * DAY, name: "Bela Other", payment: { status: "CAPTURED" } });
  fixture.hold = await seed({ serviceId: svc.a, email: holdOnly, status: "HELD", startIn: 3 * DAY, holdExpiresAt: new Date(Date.now() + 10 * 60_000) });
  fixture.red = await seed({ serviceId: svc.a, email: redactedOnly, status: "COMPLETED", startIn: -5 * DAY, redactedAt: new Date(), name: "Erased customer", payment: { status: "CAPTURED" } });
});

after(async () => {
  try {
    if (!skip) {
      for (const step of [
        () => prisma.influencer.deleteMany({ where: { slug: { in: [slugA, slugB] } } }),
        () => prisma.customerAccessToken.deleteMany({ where: { email: { in: emails } } }),
        () => prisma.adminAuditLog.deleteMany({ where: { id: { in: auditIds } } }),
      ]) {
        try {
          await step();
        } catch (e) {
          console.error("[customer-portal test] cleanup step failed", e instanceof Error ? e.message : e);
        }
      }
    }
  } finally {
    setEmailSender(null);
    for (const key of ENV_KEYS) {
      if (originalEnv[key] === undefined) delete process.env[key];
      else process.env[key] = originalEnv[key];
    }
    await prisma.$disconnect();
  }
});

/* ------------------------------------------------------------------------------------------------------------------ */
/* Asking for a link                                                                                                   */
/* ------------------------------------------------------------------------------------------------------------------ */

test("access: an address with bookings gets exactly one e-mail with a /bookings/ link; the token row holds only its hash", { skip }, async () => {
  sent = [];
  const before = await prisma.customerAccessToken.count({ where: { email: c1 } });
  const { done } = lib.requestPortalLink(`  ${c1.toUpperCase()} `);
  await done;
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, c1, "to the normalised address");
  const url = /http:\/\/localhost:3000\/bookings\/([A-Za-z0-9_-]+)/.exec(sent[0].text);
  assert.ok(url, "the plain-text body carries the link");
  assert.ok(sent[0].html.includes(`/bookings/${url[1]}`), "and so does the html body");
  const token = url[1];
  assert.equal(token.length, 43, "256 random bits, base64url");
  const rows = await prisma.customerAccessToken.findMany({ where: { email: c1 } });
  assert.equal(rows.length, before + 1);
  const row = rows.find((r) => r.tokenHash === hashToken(token));
  assert.ok(row, "the row is found by the SHA-256 of the token");
  assert.ok(!rows.some((r) => r.tokenHash === token), "the raw token is not in the table");
  assert.ok(!JSON.stringify(rows).includes(token), "nor anywhere else in the row");
  const ttl = row!.expiresAt.getTime() - Date.now();
  assert.ok(ttl > 59 * 60_000 && ttl <= 60 * 60_000, `valid for 60 minutes, got ${ttl} ms`);
  assert.ok(!sent[0].text.includes("Asha") && !sent[0].html.includes("Asha"), "no name or booking detail in the e-mail");
  await prisma.customerAccessToken.deleteMany({ where: { tokenHash: row!.tokenHash } });
});

test("access: an unknown address, an erased-only address and an address over its limit send nothing and create nothing", { skip }, async () => {
  sent = [];
  const tokens = () => prisma.customerAccessToken.count({ where: { email: { in: [unknown, redactedOnly, limitedAddr] } } });
  for (const e of [unknown, redactedOnly]) await lib.requestPortalLink(e).done;
  assert.equal(sent.length, 0, "no e-mail to an address without a (non-erased) booking");
  assert.equal(await tokens(), 0);
  // The limit is 3 per address per hour (any spelling of the address shares the bucket); the fourth does nothing, silently.
  const limitedBooking = await seed({ serviceId: svc.a, email: limitedAddr, status: "COMPLETED", startIn: -DAY, payment: { status: "CAPTURED" } });
  assert.ok(limitedBooking.booking.id);
  for (const spelling of [limitedAddr, limitedAddr.toUpperCase(), ` ${limitedAddr}`, limitedAddr]) await lib.requestPortalLink(spelling).done;
  assert.equal(sentTo(limitedAddr).length, 3, "three e-mails, the fourth request sent nothing");
  assert.equal(await prisma.customerAccessToken.count({ where: { email: limitedAddr } }), 3);
  await prisma.customerAccessToken.deleteMany({ where: { email: limitedAddr } });
});

test("access: an address that only has a hold that was never paid still gets a link (the data is theirs to export or erase)", { skip }, async () => {
  sent = [];
  await lib.requestPortalLink(holdOnly).done;
  assert.equal(sentTo(holdOnly).length, 1);
  await prisma.customerAccessToken.deleteMany({ where: { email: holdOnly } });
});

test("access: the route answers the same 202 for a known, an unknown and a limited address, and a 400 only for a malformed body", { skip }, async () => {
  sent = [];
  const known = await askAccess(c2);
  const nobody = await askAccess(unknown);
  const odd = await askAccess(`Nobody.${run}@Example.COM`);
  for (const out of [known, nobody, odd]) {
    assert.equal(out.status, 202);
    assert.deepEqual(out.body, { ok: true });
    assert.equal(out.headers.get("cache-control"), "private, no-store");
    assert.equal(out.headers.get("access-control-allow-origin"), null);
  }
  assert.equal(known.text, nobody.text, "byte-identical bodies");
  assert.deepEqual([...known.headers.entries()].sort(), [...nobody.headers.entries()].sort(), "identical headers");
  // The send is detached: it still happens, after the answer.
  assert.ok(await until(() => sentTo(c2).length === 1), "the e-mail for the known address arrives");
  assert.equal(sentTo(unknown).length, 0);
  assert.equal(sent.filter((m) => m.to.startsWith("nobody.")).length, 0);
  // Malformed: the same 400 whatever the address would have been.
  for (const body of [{}, { email: "not-an-email" }, { email: 5 }, { email: `${"a".repeat(200)}@example.com` }, { email: null }, [], "plain text", '{"email":"a@b.co\\u0000"}']) {
    const out = await answer(await accessRoute(post("http://localhost/api/customer/access", body)));
    assert.equal(out.status, 400, JSON.stringify(body));
  }
  assert.equal((await answer(await accessRoute(new Request("http://localhost/api/customer/access", { method: "POST", body: "not json" })))).status, 400);
  await prisma.customerAccessToken.deleteMany({ where: { email: c2 } });
});

test("access: the response does not wait for the lookup and the e-mail (no timing difference between known and unknown)", { skip }, async () => {
  sent = [];
  await seed({ serviceId: svc.a, email: slowAddr, status: "COMPLETED", startIn: -DAY, payment: { status: "CAPTURED" } });
  let release!: () => void;
  gate = new Promise<void>((resolve) => (release = resolve));
  try {
    const out = await Promise.race([askAccess(slowAddr), new Promise<"late">((r) => setTimeout(() => r("late"), 3000))]);
    assert.notEqual(out, "late", "the route answered while the e-mail was still being sent");
    assert.equal((out as Answer).status, 202);
    assert.equal(sentTo(slowAddr).length, 0, "the e-mail is still held back by the slow provider");
  } finally {
    release();
    gate = null;
  }
  assert.ok(await until(() => sentTo(slowAddr).length === 1), "and it goes out afterwards");
  await prisma.customerAccessToken.deleteMany({ where: { email: slowAddr } });
});

/* ------------------------------------------------------------------------------------------------------------------ */
/* The portal                                                                                                          */
/* ------------------------------------------------------------------------------------------------------------------ */

test("portal: a token that is unknown, expired, malformed, signed for something else or empty is the same 403 `expired`", { skip }, async () => {
  const expiredToken = await mintToken(c1, -1000);
  const cases: Array<[string, string]> = [
    ["garbage", "not-a-token"],
    ["too short", "abc"],
    ["well-formed but unknown", randomToken()],
    ["expired", expiredToken],
    ["a manage token", signToken(SELF_SERVICE_PURPOSE, { b: fixture.a2.booking.id }, 3600)],
    ["a pay token", signToken(BOOKING_PAY_PURPOSE, { b: fixture.a2.booking.id }, 3600)],
    ["a hash is not a token", hashToken(expiredToken)],
    ["too long", "a".repeat(101)],
    ["sql-ish", "' OR '1'='1"],
    ["empty-ish", "%20"],
  ];
  for (const [label, token] of cases) {
    for (const call of [getPortal, getExport]) {
      const out = await call(token);
      assert.equal(out.status, 403, label);
      assert.deepEqual(out.body, { state: "expired" }, label);
      assert.equal(out.headers.get("cache-control"), "private, no-store", label);
    }
    const erase = await doErase(token);
    assert.equal(erase.status, 403, label);
    assert.deepEqual(erase.body, { state: "expired" }, label);
  }
  // Nothing was erased by the refused calls.
  assert.equal(await prisma.booking.count({ where: { id: fixture.a1.booking.id, redactedAt: null } }), 1);
  await prisma.customerAccessToken.deleteMany({ where: { tokenHash: hashToken(expiredToken) } });
});

const PORTAL_KEYS = ["blocked", "bookings", "email", "erasable", "expiresAt", "state"];
const BOOKING_KEYS = ["durationMin", "influencerName", "manageUrl", "receipt", "reference", "serviceTitle", "startTime", "status", "statusText"];
const RECEIPT_KEYS = ["amountMinor", "currency", "hostName", "issuedTo", "paidAt", "paymentReference", "reference", "refundedMinor", "seller", "serviceTitle", "sessionStart", "statusText"];

test("portal: a valid link lists every paid booking across hosts with exactly the hand-picked fields", { skip }, async () => {
  const token = await mintToken(c1);
  const out = await getPortal(token);
  assert.equal(out.status, 200);
  assert.equal(out.headers.get("cache-control"), "private, no-store");
  assert.equal(out.headers.get("access-control-allow-origin"), null);
  assert.deepEqual(keys(out.body), PORTAL_KEYS);
  assert.equal(out.body.state, "ok");
  assert.equal(out.body.email, c1);
  assertNoSecretKeys(out.body);

  const list = out.body.bookings as Array<Record<string, unknown>>;
  for (const b of list) {
    assert.deepEqual(keys(b), BOOKING_KEYS);
    if (b.receipt) assert.deepEqual(keys(b.receipt), RECEIPT_KEYS);
  }
  const byRef = new Map(list.map((b) => [b.reference as string, b]));
  // a1, a2, b1, b2, b3, g1 are listed; the hold, the expired request and the erased booking are not.
  assert.deepEqual(
    [...byRef.keys()].sort(),
    [fixture.a1, fixture.a2, fixture.b1, fixture.b2, fixture.b3, fixture.g1].map((f) => f.booking.id).sort(),
  );
  assert.ok(!byRef.has(fixture.h1.booking.id) && !byRef.has(fixture.x1.booking.id) && !byRef.has(fixture.r1.booking.id));
  // Two different hosts.
  assert.deepEqual([...new Set(list.map((b) => b.influencerName))].sort(), [`Portal Host A ${run}`, `Portal Host B ${run}`]);
  // Newest session first.
  const starts = list.map((b) => b.startTime as string);
  assert.deepEqual(starts, [...starts].sort().reverse());

  // manageUrl: only for a paid session that has not started; it opens THAT booking.
  const withUrl = list.filter((b) => b.manageUrl !== null).map((b) => b.reference);
  assert.deepEqual(withUrl, [fixture.a2.booking.id]);
  const manageUrl = byRef.get(fixture.a2.booking.id)!.manageUrl as string;
  assert.ok(manageUrl.startsWith("http://localhost:3000/manage/"));
  const { verifySelfServiceToken } = await import("../lib/self-service");
  assert.equal(verifySelfServiceToken(decodeURIComponent(manageUrl.split("/manage/")[1])), fixture.a2.booking.id);

  assert.equal(byRef.get(fixture.a2.booking.id)!.statusText, "Upcoming");
  assert.equal(byRef.get(fixture.a1.booking.id)!.statusText, "Completed");
  assert.equal(byRef.get(fixture.b1.booking.id)!.statusText, "Completed", "a PAID booking whose session is over");
  assert.equal(byRef.get(fixture.b2.booking.id)!.statusText, "Cancelled and refunded");
  assert.equal(byRef.get(fixture.b3.booking.id)!.statusText, "Cancelled, refund due");
  // Receipts: every listed booking was paid; the states follow the money.
  const receipt = (id: string) => byRef.get(id)!.receipt as Record<string, unknown>;
  assert.equal(receipt(fixture.a1.booking.id).statusText, "Paid");
  assert.equal(receipt(fixture.b1.booking.id).statusText, "Partly refunded");
  assert.equal(receipt(fixture.b1.booking.id).refundedMinor, 10000);
  assert.equal(receipt(fixture.b2.booking.id).statusText, "Refunded");
  assert.equal(receipt(fixture.a1.booking.id).paymentReference, (await prisma.payment.findFirstOrThrow({ where: { bookingId: fixture.a1.booking.id } })).providerPaymentId);
  assert.equal(receipt(fixture.a1.booking.id).reference, fixture.a1.booking.id);
  assert.equal(receipt(fixture.a1.booking.id).issuedTo, "Asha Rao");
  assert.equal(receipt(fixture.a1.booking.id).amountMinor, 49900);

  // Counts follow the erase rule: a2 (upcoming) and the live hold are kept; the other six are erasable.
  assert.equal(out.body.blocked, 2);
  assert.equal(out.body.erasable, 6);

  // Nothing of other people or internals.
  const text = out.text;
  for (const secret of [c2, "Bela Other", influencerA, influencerB, fixture.a1.session.id, svc.a, `order_portal_${run}`, "meet.google.com", "+9198765"]) {
    assert.ok(!text.includes(secret), `the portal must not contain ${secret}`);
  }
  await prisma.customerAccessToken.deleteMany({ where: { tokenHash: hashToken(token) } });
});

test("portal: one customer's link never shows another customer's bookings", { skip }, async () => {
  const token = await mintToken(c2);
  const out = await getPortal(token);
  assert.equal(out.status, 200);
  assert.equal(out.body.email, c2);
  const refs = (out.body.bookings as Array<{ reference: string }>).map((b) => b.reference).sort();
  assert.deepEqual(refs, [fixture.g2.booking.id, fixture.c2a.booking.id].sort());
  assert.ok(!out.text.includes("Asha Rao") && !out.text.includes(c1));
  // A group session is shared, but the other attendee is nowhere in it.
  const exp = await getExport(token);
  assert.ok(!exp.text.includes("Asha Rao") && !exp.text.includes(c1));
  await prisma.customerAccessToken.deleteMany({ where: { tokenHash: hashToken(token) } });
});

test("portal: an address with only erased bookings has an empty list and nothing to erase", { skip }, async () => {
  const token = await mintToken(redactedOnly);
  const out = await getPortal(token);
  assert.equal(out.status, 200);
  assert.deepEqual(out.body.bookings, []);
  assert.equal(out.body.erasable, 0);
  assert.equal(out.body.blocked, 0);
  await prisma.customerAccessToken.deleteMany({ where: { tokenHash: hashToken(token) } });
});

/* ------------------------------------------------------------------------------------------------------------------ */
/* Export                                                                                                              */
/* ------------------------------------------------------------------------------------------------------------------ */

test("export: a JSON attachment with the customer's own data and no internal ids, tokens or provider ids", { skip }, async () => {
  const token = await mintToken(c1);
  const out = await getExport(token);
  assert.equal(out.status, 200);
  assert.match(out.headers.get("content-type") ?? "", /^application\/json/);
  assert.match(out.headers.get("content-disposition") ?? "", /^attachment; filename="my-bookings-\d{4}-\d{2}-\d{2}\.json"$/);
  assert.equal(out.headers.get("cache-control"), "private, no-store");
  assert.equal(out.headers.get("referrer-policy"), "no-referrer");
  assert.equal(out.headers.get("x-content-type-options"), "nosniff");
  assert.deepEqual(keys(out.body), ["bookings", "email", "exportedAt"]);
  assert.equal(out.body.email, c1);
  assertNoSecretKeys(out.body);

  const list = out.body.bookings as Array<Record<string, unknown>>;
  const refs = list.map((b) => b.reference);
  // Everything not erased is in the export, including the hold and the expired request the portal does not list.
  assert.ok(refs.includes(fixture.h1.booking.id) && refs.includes(fixture.x1.booking.id) && refs.includes(fixture.a1.booking.id));
  assert.ok(!refs.includes(fixture.r1.booking.id), "an already erased booking holds no personal data any more");
  assert.equal(list.length, 8);
  const a1 = list.find((b) => b.reference === fixture.a1.booking.id)!;
  assert.deepEqual(keys(a1), ["createdAt", "email", "endTime", "influencer", "intakeAnswers", "messages", "name", "payments", "phone", "reference", "service", "startTime", "status", "timeZone", "whatsappOptIn"]);
  assert.equal(a1.name, "Asha Rao");
  assert.equal(a1.email, c1);
  assert.match(a1.phone as string, /^\+9198765\d{5}$/);
  assert.equal(a1.timeZone, "Asia/Kolkata");
  assert.equal(a1.whatsappOptIn, true);
  assert.deepEqual(a1.intakeAnswers, [{ question: "Your goal", answer: "Grow my channel" }]);
  const payment = (a1.payments as Array<Record<string, unknown>>)[0];
  assert.deepEqual(keys(payment), ["amountMinor", "createdAt", "currency", "paymentReference", "refundedMinor", "status"]);
  assert.equal(payment.amountMinor, 49900);
  assert.match(payment.paymentReference as string, /^pay_portal_/);

  for (const secret of [c2, "Bela Other", influencerA, influencerB, fixture.a1.session.id, svc.a, fixture.a1.paymentId!, `order_portal_${run}`, "providerOrderId", "meetLink", "meet.google.com", "tokenHash", token, hashToken(token)]) {
    assert.ok(!out.text.includes(secret), `the export must not contain ${secret}`);
  }
  await prisma.customerAccessToken.deleteMany({ where: { tokenHash: hashToken(token) } });
});

/* ------------------------------------------------------------------------------------------------------------------ */
/* Erase                                                                                                               */
/* ------------------------------------------------------------------------------------------------------------------ */

test("erase: needs `confirm: true`", { skip }, async () => {
  const token = await mintToken(c1);
  for (const body of [{}, { confirm: false }, { confirm: "true" }, [], "text"]) {
    assert.equal((await doErase(token, body)).status, 400, JSON.stringify(body));
  }
  assert.equal(await prisma.booking.count({ where: { id: fixture.a1.booking.id, redactedAt: null } }), 1, "nothing was erased");
  await prisma.customerAccessToken.deleteMany({ where: { tokenHash: hashToken(token) } });
});

test("erase: past bookings are redacted, upcoming ones kept and counted, the links survive while something is kept, a repeat changes nothing", { skip }, async () => {
  const t1 = await mintToken(c1);
  const t2 = await mintToken(c1);
  const auditBefore = new Set((await prisma.adminAuditLog.findMany({ where: { action: "customer.erased" }, select: { id: true } })).map((r) => r.id));
  sent = [];

  const { result: first, output } = await captureConsole(() => doErase(t1));
  assert.equal(first.status, 200);
  assert.deepEqual(first.body, { ok: true, erased: 6, blocked: 2 });
  assert.equal(first.headers.get("cache-control"), "private, no-store");
  assertNoSecretKeys(first.body);
  assert.ok(!output.includes(t1) && !output.includes(c1), "neither the token nor the address is written to the console");

  // The six past ones are redacted (and keep their ids, statuses and payments); the live ones are untouched.
  for (const f of [fixture.a1, fixture.b1, fixture.b2, fixture.b3, fixture.x1, fixture.g1]) {
    const row = await prisma.booking.findUniqueOrThrow({ where: { id: f.booking.id } });
    assert.notEqual(row.redactedAt, null);
    assert.equal(row.customerName, "Erased customer");
    assert.equal(row.customerEmail, `erased+${f.booking.id}@invalid.invalid`);
    assert.equal(row.whatsappE164, "");
    assert.equal(row.customerTz, null);
    assert.equal(row.intakeAnswers, null);
  }
  for (const f of [fixture.a2, fixture.h1]) {
    const row = await prisma.booking.findUniqueOrThrow({ where: { id: f.booking.id } });
    assert.equal(row.redactedAt, null);
    assert.equal(row.customerEmail, c1);
  }
  assert.equal(await prisma.payment.count({ where: { bookingId: { in: [fixture.a1, fixture.b1, fixture.b2, fixture.b3, fixture.g1].map((f) => f.booking.id) } } }), 5, "payment rows are kept");
  // Another customer is untouched.
  assert.equal((await prisma.booking.findUniqueOrThrow({ where: { id: fixture.g2.booking.id } })).customerName, "Bela Other");

  // Links survive while something is kept.
  assert.ok(await lib.resolvePortalToken(t1) && (await lib.resolvePortalToken(t2)));
  const view = await getPortal(t1);
  assert.equal(view.status, 200);
  assert.deepEqual((view.body.bookings as Array<{ reference: string }>).map((b) => b.reference), [fixture.a2.booking.id]);
  assert.equal(view.body.erasable, 0);
  assert.equal(view.body.blocked, 2);

  // One audit row, without the address; one confirmation e-mail.
  const created = (await prisma.adminAuditLog.findMany({ where: { action: "customer.erased", id: { notIn: [...auditBefore] } } }));
  assert.equal(created.length, 1);
  auditIds.push(...created.map((r) => r.id));
  assert.equal(created[0].adminEmail, "system:customer-request");
  assert.equal(created[0].adminId, null);
  assert.deepEqual(created[0].detail, { erased: 6, blocked: 2 });
  assert.ok(!JSON.stringify(created[0]).includes("@"), "no e-mail address in the audit row");
  assert.equal(created[0].ip, null);
  assert.equal(sentTo(c1).length, 1);
  assert.match(sentTo(c1)[0].subject, /erased/i);
  assert.match(sentTo(c1)[0].text, /6 bookings/);
  assert.match(sentTo(c1)[0].text, /2 upcoming bookings were kept/);

  // Again: nothing to do, nothing recorded, nothing sent.
  const second = await doErase(t2);
  assert.deepEqual(second.body, { ok: true, erased: 0, blocked: 2 });
  assert.equal(await prisma.adminAuditLog.count({ where: { action: "customer.erased", id: { notIn: [...auditBefore, ...auditIds] } } }), 0);
  assert.equal(sentTo(c1).length, 1);
  assert.ok(await lib.resolvePortalToken(t1), "still kept while something is kept");
});

test("erase: when nothing is kept any more every link of the address is deleted, so a reused link is expired", { skip }, async () => {
  // Cancel the upcoming session and let the hold go: now everything left may be erased.
  await prisma.booking.update({ where: { id: fixture.a2.booking.id }, data: { status: "CANCELLED" } });
  await prisma.booking.update({ where: { id: fixture.h1.booking.id }, data: { status: "EXPIRED", holdExpiresAt: null } });
  const t1 = await mintToken(c1);
  const t2 = await mintToken(c1);
  const other = await mintToken(c2);
  const auditBefore = new Set((await prisma.adminAuditLog.findMany({ where: { action: "customer.erased" }, select: { id: true } })).map((r) => r.id));
  sent = [];

  const out = await doErase(t1);
  assert.deepEqual(out.body, { ok: true, erased: 2, blocked: 0 });
  assert.equal(await prisma.customerAccessToken.count({ where: { email: c1 } }), 0, "every link of the address is gone");
  assert.ok(await lib.resolvePortalToken(other), "another address's link is untouched");
  // Reuse after erase, with the very token that was just used and with the other one.
  for (const token of [t1, t2]) {
    for (const call of [getPortal, getExport]) {
      const again = await call(token);
      assert.equal(again.status, 403);
      assert.deepEqual(again.body, { state: "expired" });
    }
    assert.equal((await doErase(token)).status, 403);
  }
  assert.equal(await prisma.booking.count({ where: { customerEmail: c1, redactedAt: null } }), 0);

  const created = await prisma.adminAuditLog.findMany({ where: { action: "customer.erased", id: { notIn: [...auditBefore] } } });
  assert.equal(created.length, 1);
  auditIds.push(...created.map((r) => r.id));
  assert.deepEqual(created[0].detail, { erased: 2, blocked: 0 });
  assert.equal(sentTo(c1).length, 1);
  assert.match(sentTo(c1)[0].text, /No upcoming bookings were kept/);
  await prisma.customerAccessToken.deleteMany({ where: { email: c2 } });
});

/* ------------------------------------------------------------------------------------------------------------------ */
/* Housekeeping, pure helpers                                                                                          */
/* ------------------------------------------------------------------------------------------------------------------ */

test("sweep: expired access tokens are deleted, live ones stay", { skip }, async () => {
  const old1 = await mintToken(c2, -2 * HOUR);
  const old2 = await mintToken(c2, -1000);
  const live = await mintToken(c2, HOUR);
  const count = await sweep.sweepExpiredCustomerAccess();
  assert.ok(count >= 2, `deleted at least my two, got ${count}`);
  assert.equal(await prisma.customerAccessToken.count({ where: { tokenHash: { in: [hashToken(old1), hashToken(old2)] } } }), 0);
  assert.equal(await prisma.customerAccessToken.count({ where: { tokenHash: hashToken(live) } }), 1);
  assert.equal(await sweep.sweepExpiredCustomerAccess(new Date(Date.now() + 2 * HOUR)) >= 1, true, "and the live one once its hour is over");
  assert.equal(await prisma.customerAccessToken.count({ where: { email: c2 } }), 0);
});

test("the portal's routes are rate limited and their tokens are kept out of logs", () => {
  const rule = (method: string, path: string) => matchRouteRule(method, path)?.name ?? null;
  assert.equal(rule("POST", "/api/customer/access"), "customer-access");
  assert.equal(rule("GET", "/api/customer/portal/abc"), "customer-portal");
  assert.equal(rule("GET", "/api/customer/portal/abc/export"), "customer-export");
  assert.equal(rule("POST", "/api/customer/portal/abc/erase"), "customer-erase");
  assert.equal(loggablePath("/api/customer/portal/SeCrEtToKeN"), "/api/customer/portal/:token");
  assert.equal(loggablePath("/api/customer/portal/SeCrEtToKeN/export"), "/api/customer/portal/:token/export");
  assert.equal(loggablePath("/api/customer/portal/SeCrEtToKeN/erase"), "/api/customer/portal/:token/erase");
  assert.equal(loggablePath("/api/customer/access"), "/api/customer/access");
});

test("nothing the portal flow logs contains a token or an address", { skip }, async () => {
  sent = [];
  const { output } = await captureConsole(async () => {
    await lib.requestPortalLink(c2).done;
    await lib.requestPortalLink(unknown).done;
    const t = await mintToken(c2);
    await getPortal(t);
    await getExport(t);
    await getPortal("garbage");
  });
  const link = /\/bookings\/([A-Za-z0-9_-]+)/.exec(sentTo(c2)[0]?.text ?? "")?.[1];
  assert.ok(link);
  assert.ok(!output.includes(link!) && !output.includes(c2) && !output.includes(unknown), output);
  await prisma.customerAccessToken.deleteMany({ where: { email: c2 } });
});
