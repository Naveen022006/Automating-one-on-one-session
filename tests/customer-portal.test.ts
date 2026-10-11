// WP-D customer portal ("find your bookings", doc/13-product-build-plan.md): the gate and abuse cases, the exact key sets and the
// erase rules, against the real routes and the database (skipped without DATABASE_URL). Nothing here sends a real e-mail: the e-mail
// sender is replaced by a capture, and APP_URL / APP_SECRET / RATE_LIMIT_STORE are set in `before` and put back in `after`.
//   POST /api/customer/access        GET /api/customer/portal/:token        GET .../export        POST .../erase
// Every test makes its own customers (`makeSet`, `seedPaid`), so any test runs alone with --test-name-pattern.
import "dotenv/config";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, mock, test } from "node:test";
import type { BookingStatus, PaymentStatus } from "../generated/prisma/client";
import { prisma } from "../lib/db";
import { setEmailSender } from "../lib/email";
import { hashToken, randomToken } from "../lib/auth/tokens";
import { hit } from "../lib/rate-limit";
import { matchRouteRule } from "../lib/rate-limit/policies";
import { loggablePath } from "../lib/rate-limit/redact";
import { BOOKING_PAY_PURPOSE, SELF_SERVICE_PURPOSE } from "../lib/self-service";
import { signToken } from "../lib/signing";
import { assertNoSecretKeys } from "./helpers/assert-no-secret-keys";

const skip = process.env.DATABASE_URL ? false : "DATABASE_URL not set";
const run = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const ENV_KEYS = ["RATE_LIMIT_STORE", "APP_URL", "APP_SECRET", "READINESS_REQUIRED", "CUSTOMER_PORTAL_MAIL_CAP_PER_HOUR"] as const;
const originalEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]])) as Record<(typeof ENV_KEYS)[number], string | undefined>;

type Ctx = { params: Promise<{ token: string }> };
let accessRoute: (req: Request) => Promise<Response>;
let portalRoute: (req: Request, ctx: Ctx) => Promise<Response>;
let exportRoute: (req: Request, ctx: Ctx) => Promise<Response>;
let eraseRoute: (req: Request, ctx: Ctx) => Promise<Response>;
let lib: typeof import("../lib/customer-portal");
let sweep: typeof import("../lib/customer-access-sweep");
let privacy: typeof import("../lib/privacy");
let approval: typeof import("../lib/booking-approval");

// Everything this file creates is found again by these names, so a `before` that dies half way still leaves nothing behind.
const slugA = `portal-a-${run}`;
const slugB = `portal-b-${run}`;
const emails: string[] = [];
const addr = (tag: string) => {
  const e = `portal-${tag}-${run}@example.com`;
  emails.push(e);
  return e;
};
let influencerA = "";
let influencerB = "";
const svc = { a: "", aGroup: "", b: "" };
const auditIds: string[] = [];
const afterCalls: Promise<unknown>[] = [];

interface Sent {
  to: string;
  subject: string;
  text: string;
  html: string;
}
let sent: Sent[] = [];
let gate: { addr: string; promise: Promise<void> } | null = null;
const sentTo = (email: string) => sent.filter((m) => m.to === email);

let seq = 0;
interface PaySpec {
  status: PaymentStatus;
  needsRefund?: boolean;
  refundedMinor?: number;
  refundStatus?: string;
  /** How long ago the payment row was created (default: in the order given, a second apart). */
  ageMs?: number;
}
interface SeedOptions {
  serviceId: string;
  email: string;
  status: BookingStatus;
  /** Session start, ms from now. */
  startIn: number;
  /** Session length in minutes (default 30). */
  lengthMin?: number;
  name?: string;
  holdExpiresAt?: Date | null;
  redactedAt?: Date | null;
  sessionId?: string;
  intake?: unknown;
  payment?: PaySpec;
  extraPayments?: PaySpec[];
}

async function seed(o: SeedOptions) {
  const n = ++seq;
  const start = new Date(Math.floor((Date.now() + o.startIn) / 1000) * 1000 + n * 1000);
  const session =
    o.sessionId !== undefined
      ? await prisma.session.findUniqueOrThrow({ where: { id: o.sessionId } })
      : await prisma.session.create({ data: { serviceId: o.serviceId, startTime: start, endTime: new Date(start.getTime() + (o.lengthMin ?? 30) * 60_000) } });
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
  const payments = [...(o.payment ? [o.payment] : []), ...(o.extraPayments ?? [])];
  for (const [i, pay] of payments.entries()) {
    const m = `${n}_${i}`;
    const p = await prisma.payment.create({
      data: {
        bookingId: booking.id,
        providerOrderId: `order_portal_${run}_${m}`,
        providerPaymentId: `pay_portal_${run}_${m}`,
        amountMinor: 49900,
        currency: "INR",
        status: pay.status,
        needsRefund: pay.needsRefund ?? false,
        refundAmountMinor: pay.refundedMinor ?? null,
        refundStatus: pay.refundStatus ?? null,
        createdAt: new Date(Date.now() - (pay.ageMs ?? (payments.length - i) * 1000)),
      },
    });
    if (i === 0) paymentId = p.id;
  }
  return { booking, session, paymentId };
}
type Seeded = Awaited<ReturnType<typeof seed>>;

/** One paid, finished booking for `email` on host A (what most access tests need). */
const seedPaid = (email: string, over: Partial<SeedOptions> = {}) =>
  seed({ serviceId: svc.a, email, status: "COMPLETED", startIn: -DAY, payment: { status: "CAPTURED" }, ...over });

/**
 * A customer with every kind of booking, and another customer who shares a group session with them. Past: a1 (with intake), b1 (partly
 * refunded), b2 (cancelled and refunded), b3 (cancelled, refund due), g1 (group), x1 (expired request). Kept: a2 (upcoming), h1 (a hold).
 * Not listed: h1, x1, r1 (already erased).
 */
async function makeSet(tag: string) {
  const email = addr(tag);
  const other = addr(`${tag}o`);
  const intake = [{ id: "q1", label: "Your goal", answer: "Grow my channel" }];
  const f = {} as Record<"a1" | "a2" | "b1" | "b2" | "b3" | "h1" | "x1" | "r1" | "g1" | "g2" | "o1", Seeded>;
  f.a1 = await seed({ serviceId: svc.a, email, status: "COMPLETED", startIn: -10 * DAY, name: "Asha Rao", intake, payment: { status: "CAPTURED" } });
  f.a2 = await seed({ serviceId: svc.a, email, status: "SCHEDULED", startIn: 5 * DAY, name: "Asha Rao", payment: { status: "CAPTURED" } });
  f.b1 = await seed({ serviceId: svc.b, email, status: "PAID", startIn: -3 * DAY, name: "Asha Rao", payment: { status: "CAPTURED", refundedMinor: 10000, refundStatus: "processed" } });
  f.b2 = await seed({ serviceId: svc.b, email, status: "CANCELLED", startIn: 4 * DAY, name: "Asha Rao", payment: { status: "REFUNDED", refundedMinor: 49900, refundStatus: "processed" } });
  f.b3 = await seed({ serviceId: svc.b, email, status: "CANCELLED", startIn: 6 * DAY, name: "Asha Rao", payment: { status: "CAPTURED", needsRefund: true } });
  f.h1 = await seed({ serviceId: svc.a, email, status: "HELD", startIn: 8 * DAY, name: "Asha Rao", holdExpiresAt: new Date(Date.now() + 10 * 60_000) });
  f.x1 = await seed({ serviceId: svc.a, email, status: "EXPIRED", startIn: -20 * DAY, name: "Asha Rao" });
  f.r1 = await seed({ serviceId: svc.a, email, status: "COMPLETED", startIn: -30 * DAY, name: "Erased customer", redactedAt: new Date(), payment: { status: "CAPTURED" } });
  f.g1 = await seed({ serviceId: svc.aGroup, email, status: "COMPLETED", startIn: -2 * DAY, name: "Asha Rao", payment: { status: "CAPTURED" } });
  f.g2 = await seed({ serviceId: svc.aGroup, email: other, status: "COMPLETED", startIn: 0, name: "Bela Other", sessionId: f.g1.session.id, payment: { status: "CAPTURED" } });
  f.o1 = await seed({ serviceId: svc.a, email: other, status: "SCHEDULED", startIn: 2 * DAY, name: "Bela Other", payment: { status: "CAPTURED" } });
  return { email, other, f };
}

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

/** The ids of the "customer.erased" audit rows that exist now; `newAudit(before)` returns (and schedules for clean-up) the ones added since. */
async function auditNow(): Promise<Set<string>> {
  return new Set((await prisma.adminAuditLog.findMany({ where: { action: "customer.erased" }, select: { id: true } })).map((r) => r.id));
}
async function newAudit(before: Set<string>) {
  const rows = await prisma.adminAuditLog.findMany({ where: { action: "customer.erased", id: { notIn: [...before] } } });
  auditIds.push(...rows.map((r) => r.id));
  return rows;
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
  delete process.env.CUSTOMER_PORTAL_MAIL_CAP_PER_HOUR;
  setEmailSender(async (email) => {
    if (gate && email.to.email === gate.addr) await gate.promise;
    sent.push({ to: email.to.email, subject: email.subject, text: email.text, html: email.html });
    return { providerMessageId: null };
  });
  // `after` only works inside a request; the test records what the route hands it.
  const realServer = await import("next/server");
  mock.module("next/server", { namedExports: { ...realServer, after: (p: Promise<unknown>) => void afterCalls.push(p) } });
  accessRoute = (await import("../app/api/customer/access/route")).POST;
  portalRoute = (await import("../app/api/customer/portal/[token]/route")).GET;
  exportRoute = (await import("../app/api/customer/portal/[token]/export/route")).GET;
  eraseRoute = (await import("../app/api/customer/portal/[token]/erase/route")).POST;
  lib = await import("../lib/customer-portal");
  sweep = await import("../lib/customer-access-sweep");
  privacy = await import("../lib/privacy");
  approval = await import("../lib/booking-approval");

  influencerA = (await prisma.influencer.create({ data: { slug: slugA, name: `Portal Host A ${run}`, email: `portal-host-a-${run}@example.com`, timezone: "Asia/Kolkata", onboardedAt: new Date() } })).id;
  influencerB = (await prisma.influencer.create({ data: { slug: slugB, name: `Portal Host B ${run}`, email: `portal-host-b-${run}@example.com`, timezone: "Asia/Kolkata", onboardedAt: new Date() } })).id;
  const service = (influencerId: string, title: string, extra: object = {}) => prisma.service.create({ data: { influencerId, title, durationMin: 30, priceMinor: 49900, ...extra } }).then((s) => s.id);
  svc.a = await service(influencerA, `Career call ${run}`, { requiresApproval: true });
  svc.aGroup = await service(influencerA, `Group clinic ${run}`, { type: "GROUP", capacity: 5 });
  svc.b = await service(influencerB, `Portfolio review ${run}`);
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
  const email = addr("one");
  await seedPaid(email);
  sent = [];
  const { done } = lib.requestPortalLink(`  ${email.toUpperCase()} `);
  await done;
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, email, "to the normalised address");
  const url = /http:\/\/localhost:3000\/bookings\/([A-Za-z0-9_-]+)/.exec(sent[0].text);
  assert.ok(url, "the plain-text body carries the link");
  assert.ok(sent[0].html.includes(`/bookings/${url[1]}`), "and so does the html body");
  const token = url[1];
  assert.equal(token.length, 43, "256 random bits, base64url");
  const rows = await prisma.customerAccessToken.findMany({ where: { email } });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].tokenHash, hashToken(token), "the row is found by the SHA-256 of the token");
  assert.ok(!JSON.stringify(rows).includes(token), "the raw token is nowhere in the row");
  const ttl = rows[0].expiresAt.getTime() - Date.now();
  assert.ok(ttl > 59 * 60_000 && ttl <= 60 * 60_000, `valid for 60 minutes, got ${ttl} ms`);
  assert.ok(!sent[0].text.includes("Portal Customer") && !sent[0].html.includes("Portal Customer"), "no name or booking detail in the e-mail");
});

test("access: an unknown address and an erased-only address send nothing and create nothing", { skip }, async () => {
  const unknown = addr("nobody");
  const redacted = addr("red");
  await seedPaid(redacted, { redactedAt: new Date(), name: "Erased customer" });
  sent = [];
  for (const e of [unknown, redacted]) await lib.requestPortalLink(e).done;
  assert.equal(sent.length, 0, "no e-mail to an address without a (non-erased) booking");
  assert.equal(await prisma.customerAccessToken.count({ where: { email: { in: [unknown, redacted] } } }), 0);
});

test("access: three e-mails per address per hour (any spelling), the fourth request sends nothing", { skip }, async () => {
  const email = addr("limit");
  await seedPaid(email);
  sent = [];
  const key = `limit-${run}`;
  for (const spelling of [email, email.toUpperCase(), ` ${email}`, email]) await lib.requestPortalLink(spelling, { globalKey: key }).done;
  assert.equal(sentTo(email).length, 3, "three e-mails, the fourth request sent nothing");
  assert.equal(await prisma.customerAccessToken.count({ where: { email } }), 3);
});

test("access: asking about an address that has no bookings yet does not use up its allowance (existence is checked first)", { skip }, async () => {
  const email = addr("order");
  sent = [];
  const key = `order-${run}`;
  for (let i = 0; i < 5; i += 1) await lib.requestPortalLink(email, { globalKey: key }).done;
  assert.equal(sent.length, 0);
  await seedPaid(email);
  for (let i = 0; i < 3; i += 1) await lib.requestPortalLink(email, { globalKey: key }).done;
  assert.equal(sentTo(email).length, 3, "all three allowed requests were still available after five that found nothing");
});

test("access: a global hourly cap on portal mail stops the flood from many addresses, silently, and is tunable by the environment", { skip }, async () => {
  assert.equal(lib.portalMailCapPerHour(), lib.DEFAULT_PORTAL_MAIL_CAP_PER_HOUR, "a safe default");
  assert.ok(lib.DEFAULT_PORTAL_MAIL_CAP_PER_HOUR > 0 && lib.DEFAULT_PORTAL_MAIL_CAP_PER_HOUR <= 1000);
  process.env.CUSTOMER_PORTAL_MAIL_CAP_PER_HOUR = "2";
  try {
    assert.equal(lib.portalMailCapPerHour(), 2);
    const key = `cap-${run}`;
    const three = [addr("cap1"), addr("cap2"), addr("cap3")];
    for (const e of three) await seedPaid(e);
    sent = [];
    for (const e of three) await lib.requestPortalLink(e, { globalKey: key }).done;
    assert.equal(sent.length, 2, "two went out, the third was over the cap");
    assert.equal(sentTo(three[2]).length, 0);
    assert.equal(await prisma.customerAccessToken.count({ where: { email: three[2] } }), 0, "and no link was created for it");
    // The same answer as always for the one that was cut.
    assert.deepEqual((await askAccess(three[2])).body, { ok: true });
    process.env.CUSTOMER_PORTAL_MAIL_CAP_PER_HOUR = "garbage";
    assert.equal(lib.portalMailCapPerHour(), lib.DEFAULT_PORTAL_MAIL_CAP_PER_HOUR, "an unreadable value falls back to the default");
  } finally {
    delete process.env.CUSTOMER_PORTAL_MAIL_CAP_PER_HOUR;
  }
});

test("access: an address that only has a hold that was never paid still gets a link (the data is theirs to export or erase)", { skip }, async () => {
  const email = addr("hold");
  await seed({ serviceId: svc.a, email, status: "HELD", startIn: 3 * DAY, holdExpiresAt: new Date(Date.now() + 10 * 60_000) });
  sent = [];
  await lib.requestPortalLink(email, { globalKey: `hold-${run}` }).done;
  assert.equal(sentTo(email).length, 1);
});

test("access: the route answers the same 202 for a known and an unknown address, hands its work to `after`, and answers 400 only for a malformed body", { skip }, async () => {
  const known = addr("route");
  const nobody = addr("routenobody");
  await seedPaid(known);
  sent = [];
  afterCalls.length = 0;
  const a = await askAccess(known);
  const b = await askAccess(nobody);
  const c = await askAccess(`Nobody.${run}@Example.COM`);
  for (const out of [a, b, c]) {
    assert.equal(out.status, 202);
    assert.deepEqual(out.body, { ok: true });
    assert.equal(out.headers.get("cache-control"), "private, no-store");
    assert.equal(out.headers.get("access-control-allow-origin"), null);
  }
  assert.equal(a.text, b.text, "byte-identical bodies");
  assert.deepEqual([...a.headers.entries()].sort(), [...b.headers.entries()].sort(), "identical headers");
  // The detached work is registered with `after` (so a serverless host keeps the function alive), once per request, and never rejects.
  assert.equal(afterCalls.length, 3);
  await Promise.all(afterCalls);
  assert.equal(sentTo(known).length, 1, "the e-mail for the known address was sent");
  assert.equal(sentTo(nobody).length, 0);
  assert.equal(sent.filter((m) => m.to.startsWith("nobody.")).length, 0);
  // Malformed: the same 400 whatever the address would have been.
  for (const body of [{}, { email: "not-an-email" }, { email: 5 }, { email: `${"a".repeat(200)}@example.com` }, { email: null }, [], "plain text", '{"email":"a@b.co\\u0000"}']) {
    const out = await answer(await accessRoute(post("http://localhost/api/customer/access", body)));
    assert.equal(out.status, 400, JSON.stringify(body));
  }
  assert.equal((await answer(await accessRoute(new Request("http://localhost/api/customer/access", { method: "POST", body: "not json" })))).status, 400);
});

test("access: the response does not wait for the lookup and the e-mail (no timing difference between known and unknown)", { skip }, async () => {
  const slow = addr("slow");
  await seedPaid(slow);
  sent = [];
  afterCalls.length = 0;
  let release!: () => void;
  gate = { addr: slow, promise: new Promise<void>((resolve) => (release = resolve)) };
  try {
    const out = await Promise.race([askAccess(slow), new Promise<"late">((r) => setTimeout(() => r("late"), 3000))]);
    assert.notEqual(out, "late", "the route answered while the e-mail was still being sent");
    assert.equal((out as Answer).status, 202);
    assert.equal(sentTo(slow).length, 0, "the e-mail is still held back by the slow provider");
  } finally {
    release();
    gate = null;
  }
  await Promise.all(afterCalls);
  assert.equal(sentTo(slow).length, 1, "and it goes out afterwards");
});

test("rate limits: the per-IP limit of each portal route fires (5 asks per hour, 5 erasures, 10 downloads, 60 reads)", { skip }, async () => {
  const cases: Array<[string, string, string, number]> = [
    ["POST", "/api/customer/access", "customer-access", 5],
    ["POST", "/api/customer/portal/abc/erase", "customer-erase", 5],
    ["GET", "/api/customer/portal/abc/export", "customer-export", 10],
    ["GET", "/api/customer/portal/abc", "customer-portal", 60],
  ];
  for (const [method, path, name, limit] of cases) {
    const rule = matchRouteRule(method, path);
    assert.equal(rule?.name, name);
    assert.equal(rule?.limit, limit);
    assert.equal(rule?.by, "ip");
    const ip = `203.0.113.${(seq += 1)}-${run}`;
    for (let i = 0; i < limit; i += 1) assert.equal((await hit(rule!, ip))?.allowed, true, `${name} request ${i + 1}`);
    assert.equal((await hit(rule!, ip))?.allowed, false, `${name}: request ${limit + 1} from the same address is refused`);
    assert.equal((await hit(rule!, `${ip}-other`))?.allowed, true, `${name}: another address is not affected`);
  }
});

/* ------------------------------------------------------------------------------------------------------------------ */
/* The portal                                                                                                          */
/* ------------------------------------------------------------------------------------------------------------------ */

test("portal: a token that is unknown, expired, malformed, signed for something else or empty is the same 403 `expired`", { skip }, async () => {
  const email = addr("gate");
  const b = await seedPaid(email);
  const expiredToken = await mintToken(email, -1000);
  const cases: Array<[string, string]> = [
    ["garbage", "not-a-token"],
    ["too short", "abc"],
    ["well-formed but unknown", randomToken()],
    ["expired", expiredToken],
    ["a manage token", signToken(SELF_SERVICE_PURPOSE, { b: b.booking.id }, 3600)],
    ["a pay token", signToken(BOOKING_PAY_PURPOSE, { b: b.booking.id }, 3600)],
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
  assert.equal(await prisma.booking.count({ where: { id: b.booking.id, redactedAt: null } }), 1, "nothing was erased by the refused calls");
});

const PORTAL_KEYS = ["blocked", "bookings", "email", "erasable", "expiresAt", "state"];
const BOOKING_KEYS = ["durationMin", "influencerName", "manageUrl", "receipt", "reference", "serviceTitle", "startTime", "status", "statusText"];
const RECEIPT_KEYS = ["amountMinor", "currency", "hostName", "issuedTo", "paidAt", "paymentReference", "reference", "refundedMinor", "seller", "serviceTitle", "sessionStart", "statusText"];

test("portal: a valid link lists every paid booking across hosts with exactly the hand-picked fields", { skip }, async () => {
  const { email, other, f } = await makeSet("list");
  const token = await mintToken(email);
  const out = await getPortal(token);
  assert.equal(out.status, 200);
  assert.equal(out.headers.get("cache-control"), "private, no-store");
  assert.equal(out.headers.get("access-control-allow-origin"), null);
  assert.deepEqual(keys(out.body), PORTAL_KEYS);
  assert.equal(out.body.state, "ok");
  assert.equal(out.body.email, email);
  assertNoSecretKeys(out.body);

  const list = out.body.bookings as Array<Record<string, unknown>>;
  for (const b of list) {
    assert.deepEqual(keys(b), BOOKING_KEYS);
    if (b.receipt) assert.deepEqual(keys(b.receipt), RECEIPT_KEYS);
  }
  const byRef = new Map(list.map((b) => [b.reference as string, b]));
  assert.deepEqual([...byRef.keys()].sort(), [f.a1, f.a2, f.b1, f.b2, f.b3, f.g1].map((x) => x.booking.id).sort());
  assert.ok(!byRef.has(f.h1.booking.id) && !byRef.has(f.x1.booking.id) && !byRef.has(f.r1.booking.id));
  assert.deepEqual([...new Set(list.map((b) => b.influencerName))].sort(), [`Portal Host A ${run}`, `Portal Host B ${run}`]);
  const starts = list.map((b) => b.startTime as string);
  assert.deepEqual(starts, [...starts].sort().reverse(), "newest session first");

  assert.deepEqual(list.filter((b) => b.manageUrl !== null).map((b) => b.reference), [f.a2.booking.id], "manageUrl only for a paid session that has not started");
  const manageUrl = byRef.get(f.a2.booking.id)!.manageUrl as string;
  assert.ok(manageUrl.startsWith("http://localhost:3000/manage/"));
  const { verifySelfServiceToken } = await import("../lib/self-service");
  assert.equal(verifySelfServiceToken(decodeURIComponent(manageUrl.split("/manage/")[1])), f.a2.booking.id);

  assert.equal(byRef.get(f.a2.booking.id)!.statusText, "Upcoming");
  assert.equal(byRef.get(f.a1.booking.id)!.statusText, "Completed");
  assert.equal(byRef.get(f.b1.booking.id)!.statusText, "Completed", "a PAID booking whose session is over");
  assert.equal(byRef.get(f.b2.booking.id)!.statusText, "Cancelled and refunded");
  assert.equal(byRef.get(f.b3.booking.id)!.statusText, "Cancelled, refund due");
  const receipt = (id: string) => byRef.get(id)!.receipt as Record<string, unknown>;
  assert.equal(receipt(f.a1.booking.id).statusText, "Paid");
  assert.equal(receipt(f.b1.booking.id).statusText, "Partly refunded");
  assert.equal(receipt(f.b1.booking.id).refundedMinor, 10000);
  assert.equal(receipt(f.b2.booking.id).statusText, "Refunded");
  assert.equal(receipt(f.a1.booking.id).paymentReference, (await prisma.payment.findFirstOrThrow({ where: { bookingId: f.a1.booking.id } })).providerPaymentId);
  assert.equal(receipt(f.a1.booking.id).reference, f.a1.booking.id);
  assert.equal(receipt(f.a1.booking.id).issuedTo, "Asha Rao");
  assert.equal(receipt(f.a1.booking.id).amountMinor, 49900);

  assert.equal(out.body.blocked, 2, "a2 (upcoming) and the live hold are kept");
  assert.equal(out.body.erasable, 6);

  for (const secret of [other, "Bela Other", influencerA, influencerB, f.a1.session.id, svc.a, `order_portal_${run}`, "meet.google.com", "+9198765"]) {
    assert.ok(!out.text.includes(secret), `the portal must not contain ${secret}`);
  }
});

test("portal: one customer's link never shows another customer's bookings", { skip }, async () => {
  const { email, other, f } = await makeSet("iso");
  const token = await mintToken(other);
  const out = await getPortal(token);
  assert.equal(out.status, 200);
  assert.equal(out.body.email, other);
  assert.deepEqual((out.body.bookings as Array<{ reference: string }>).map((b) => b.reference).sort(), [f.g2.booking.id, f.o1.booking.id].sort());
  assert.ok(!out.text.includes("Asha Rao") && !out.text.includes(email));
  const exp = await getExport(token);
  assert.ok(!exp.text.includes("Asha Rao") && !exp.text.includes(email), "a group session is shared, but the other attendee is nowhere in the export");
});

test("portal: an address with only erased bookings has an empty list and nothing to erase", { skip }, async () => {
  const email = addr("onlyred");
  await seedPaid(email, { redactedAt: new Date(), name: "Erased customer" });
  const out = await getPortal(await mintToken(email));
  assert.equal(out.status, 200);
  assert.deepEqual(out.body.bookings, []);
  assert.equal(out.body.erasable, 0);
  assert.equal(out.body.blocked, 0);
});

test("portal: a session that has started but not ended is `In progress`: no manage link, and an erasure keeps it", { skip }, async () => {
  const email = addr("running");
  const running = await seed({ serviceId: svc.a, email, status: "SCHEDULED", startIn: -10 * 60_000, lengthMin: 60, payment: { status: "CAPTURED" } });
  const out = await getPortal(await mintToken(email));
  const [b] = out.body.bookings as Array<Record<string, unknown>>;
  assert.equal(b.reference, running.booking.id);
  assert.equal(b.statusText, "In progress");
  assert.equal(b.manageUrl, null, "the manage page no longer allows changes once a session has started");
  assert.equal(out.body.blocked, 1, "the status, the dialog's numbers and the erasure agree: it is kept");
  assert.equal(out.body.erasable, 0);
  const erased = await privacy.eraseCustomerData(influencerA, email);
  assert.deepEqual(erased, { found: 1, erased: 0, blocked: 1 });
});

test("portal: with two payments the one that describes the booking is the receipt (a refunded or flagged duplicate does not make a paid session `Refunded`)", { skip }, async () => {
  const email = addr("dup");
  // The first payment was refunded in full, a later one stands.
  const a = await seed({
    serviceId: svc.a,
    email,
    status: "SCHEDULED",
    startIn: 3 * DAY,
    payment: { status: "REFUNDED", refundedMinor: 49900, ageMs: 5 * HOUR },
    extraPayments: [{ status: "CAPTURED", ageMs: HOUR }],
  });
  // The first payment stands, a later one was flagged as a duplicate.
  const b = await seed({
    serviceId: svc.b,
    email,
    status: "SCHEDULED",
    startIn: 4 * DAY,
    payment: { status: "CAPTURED", ageMs: 5 * HOUR },
    extraPayments: [{ status: "CAPTURED", needsRefund: true, ageMs: HOUR }],
  });
  const out = await getPortal(await mintToken(email));
  const byRef = new Map((out.body.bookings as Array<Record<string, unknown>>).map((x) => [x.reference as string, x]));
  const refOf = async (bookingId: string, which: "oldest" | "newest") =>
    (await prisma.payment.findMany({ where: { bookingId }, orderBy: { createdAt: which === "oldest" ? "asc" : "desc" } }))[0].providerPaymentId;
  const ra = byRef.get(a.booking.id)!.receipt as Record<string, unknown>;
  assert.equal(ra.statusText, "Paid");
  assert.equal(ra.paymentReference, await refOf(a.booking.id, "newest"));
  assert.equal(byRef.get(a.booking.id)!.statusText, "Upcoming");
  const rb = byRef.get(b.booking.id)!.receipt as Record<string, unknown>;
  assert.equal(rb.statusText, "Paid");
  assert.equal(rb.paymentReference, await refOf(b.booking.id, "oldest"));
});

/* ------------------------------------------------------------------------------------------------------------------ */
/* Export                                                                                                              */
/* ------------------------------------------------------------------------------------------------------------------ */

test("export: a JSON attachment with the customer's own data and no internal ids, tokens or provider ids", { skip }, async () => {
  const { email, other, f } = await makeSet("exp");
  const token = await mintToken(email);
  const out = await getExport(token);
  assert.equal(out.status, 200);
  assert.match(out.headers.get("content-type") ?? "", /^application\/json/);
  assert.match(out.headers.get("content-disposition") ?? "", /^attachment; filename="my-bookings-\d{4}-\d{2}-\d{2}\.json"$/);
  assert.equal(out.headers.get("cache-control"), "private, no-store");
  assert.equal(out.headers.get("referrer-policy"), "no-referrer");
  assert.equal(out.headers.get("x-content-type-options"), "nosniff");
  assert.deepEqual(keys(out.body), ["bookings", "email", "exportedAt"]);
  assert.equal(out.body.email, email);
  assertNoSecretKeys(out.body);

  const list = out.body.bookings as Array<Record<string, unknown>>;
  const refs = list.map((b) => b.reference);
  assert.ok(refs.includes(f.h1.booking.id) && refs.includes(f.x1.booking.id) && refs.includes(f.a1.booking.id), "the hold and the expired request the portal does not list are in the export");
  assert.ok(!refs.includes(f.r1.booking.id), "an already erased booking holds no personal data any more");
  assert.equal(list.length, 8);
  const a1 = list.find((b) => b.reference === f.a1.booking.id)!;
  assert.deepEqual(keys(a1), ["createdAt", "email", "endTime", "influencer", "intakeAnswers", "messages", "name", "payments", "phone", "reference", "service", "startTime", "status", "timeZone", "whatsappOptIn"]);
  assert.equal(a1.name, "Asha Rao");
  assert.equal(a1.email, email);
  assert.match(a1.phone as string, /^\+9198765\d{5}$/);
  assert.equal(a1.timeZone, "Asia/Kolkata");
  assert.equal(a1.whatsappOptIn, true);
  assert.deepEqual(a1.intakeAnswers, [{ question: "Your goal", answer: "Grow my channel" }]);
  const payment = (a1.payments as Array<Record<string, unknown>>)[0];
  assert.deepEqual(keys(payment), ["amountMinor", "createdAt", "currency", "paymentReference", "refundedMinor", "status"]);
  assert.equal(payment.amountMinor, 49900);
  assert.match(payment.paymentReference as string, /^pay_portal_/);

  for (const secret of [other, "Bela Other", influencerA, influencerB, f.a1.session.id, svc.a, f.a1.paymentId!, `order_portal_${run}`, "providerOrderId", "meetLink", "meet.google.com", "tokenHash", token, hashToken(token)]) {
    assert.ok(!out.text.includes(secret), `the export must not contain ${secret}`);
  }
});

/* ------------------------------------------------------------------------------------------------------------------ */
/* Erase                                                                                                               */
/* ------------------------------------------------------------------------------------------------------------------ */

test("erase: needs `confirm: true`", { skip }, async () => {
  const email = addr("confirm");
  const b = await seedPaid(email);
  const token = await mintToken(email);
  for (const body of [{}, { confirm: false }, { confirm: "true" }, [], "text"]) {
    assert.equal((await doErase(token, body)).status, 400, JSON.stringify(body));
  }
  assert.equal(await prisma.booking.count({ where: { id: b.booking.id, redactedAt: null } }), 1, "nothing was erased");
});

test("erase: past bookings are redacted, upcoming ones kept and counted, the links survive while something is kept, a repeat changes nothing; when nothing is kept the links go", { skip }, async () => {
  const { email, other, f } = await makeSet("era");
  const t1 = await mintToken(email);
  const t2 = await mintToken(email);
  const otherToken = await mintToken(other);
  const auditBefore = await auditNow();
  sent = [];

  const { result: first, output } = await captureConsole(() => doErase(t1));
  assert.equal(first.status, 200);
  assert.deepEqual(first.body, { ok: true, erased: 6, blocked: 2 });
  assert.equal(first.headers.get("cache-control"), "private, no-store");
  assertNoSecretKeys(first.body);
  assert.ok(!output.includes(t1) && !output.includes(email), "neither the token nor the address is written to the console");

  for (const x of [f.a1, f.b1, f.b2, f.b3, f.x1, f.g1]) {
    const row = await prisma.booking.findUniqueOrThrow({ where: { id: x.booking.id } });
    assert.notEqual(row.redactedAt, null);
    assert.equal(row.customerName, "Erased customer");
    assert.equal(row.customerEmail, `erased+${x.booking.id}@invalid.invalid`);
    assert.equal(row.whatsappE164, "");
    assert.equal(row.customerTz, null);
    assert.equal(row.intakeAnswers, null);
  }
  for (const x of [f.a2, f.h1]) {
    const row = await prisma.booking.findUniqueOrThrow({ where: { id: x.booking.id } });
    assert.equal(row.redactedAt, null);
    assert.equal(row.customerEmail, email);
  }
  assert.equal(await prisma.payment.count({ where: { bookingId: { in: [f.a1, f.b1, f.b2, f.b3, f.g1].map((x) => x.booking.id) } } }), 5, "payment rows are kept");
  assert.equal((await prisma.booking.findUniqueOrThrow({ where: { id: f.g2.booking.id } })).customerName, "Bela Other", "another customer is untouched");

  assert.ok((await lib.resolvePortalToken(t1)) && (await lib.resolvePortalToken(t2)), "links survive while something is kept");
  const view = await getPortal(t1);
  assert.equal(view.status, 200);
  assert.deepEqual((view.body.bookings as Array<{ reference: string }>).map((b) => b.reference), [f.a2.booking.id]);
  assert.equal(view.body.erasable, 0);
  assert.equal(view.body.blocked, 2);

  const created = await newAudit(auditBefore);
  assert.equal(created.length, 1);
  assert.equal(created[0].adminEmail, "system:customer-request");
  assert.equal(created[0].adminId, null);
  assert.deepEqual(created[0].detail, { erased: 6, blocked: 2 });
  assert.ok(!JSON.stringify(created[0]).includes("@"), "no e-mail address in the audit row");
  assert.equal(created[0].ip, null);
  assert.equal(sentTo(email).length, 1);
  assert.match(sentTo(email)[0].subject, /erased/i);
  assert.match(sentTo(email)[0].text, /6 bookings/);
  assert.match(sentTo(email)[0].text, /2 upcoming bookings were kept/);

  const second = await doErase(t2);
  assert.deepEqual(second.body, { ok: true, erased: 0, blocked: 2 });
  assert.equal((await newAudit(new Set([...auditBefore, ...created.map((r) => r.id)]))).length, 0, "a repeat records nothing");
  assert.equal(sentTo(email).length, 1, "and sends nothing");

  // Now cancel the upcoming session and let the hold go: everything left may be erased, and the links are deleted.
  await prisma.booking.update({ where: { id: f.a2.booking.id }, data: { status: "CANCELLED" } });
  await prisma.booking.update({ where: { id: f.h1.booking.id }, data: { status: "EXPIRED", holdExpiresAt: null } });
  const auditMid = await auditNow();
  const last = await doErase(t1);
  assert.deepEqual(last.body, { ok: true, erased: 2, blocked: 0 });
  assert.equal(await prisma.customerAccessToken.count({ where: { email } }), 0, "every link of the address is gone");
  assert.ok(await lib.resolvePortalToken(otherToken), "another address's link is untouched");
  for (const token of [t1, t2]) {
    for (const call of [getPortal, getExport]) {
      const again = await call(token);
      assert.equal(again.status, 403);
      assert.deepEqual(again.body, { state: "expired" });
    }
    assert.equal((await doErase(token)).status, 403);
  }
  assert.equal(await prisma.booking.count({ where: { customerEmail: email, redactedAt: null } }), 0);
  const final = await newAudit(auditMid);
  assert.equal(final.length, 1);
  assert.deepEqual(final[0].detail, { erased: 2, blocked: 0 });
  assert.equal(sentTo(email).length, 2);
  assert.match(sentTo(email)[1].text, /No upcoming bookings were kept/);
});

test("erase: an upcoming approval REQUEST is kept, by the customer's erase and the host's erase alike, and an erased request cannot be approved", { skip }, async () => {
  const email = addr("req");
  const request = await seed({ serviceId: svc.a, email, status: "REQUESTED", startIn: 3 * DAY, holdExpiresAt: new Date(Date.now() + 6 * HOUR) });
  const t = await mintToken(email);
  const view = await getPortal(t);
  assert.equal(view.body.blocked, 1, "the dialog counts it as kept");
  assert.equal(view.body.erasable, 0);

  const auditBefore = await auditNow();
  const out = await doErase(t);
  assert.deepEqual(out.body, { ok: true, erased: 0, blocked: 1 });
  assert.equal((await prisma.booking.findUniqueOrThrow({ where: { id: request.booking.id } })).redactedAt, null, "the request keeps its details");
  assert.equal((await newAudit(auditBefore)).length, 0);
  assert.ok(await lib.resolvePortalToken(t), "and the link stays, so the customer can still cancel");

  // The host's own Erase button follows the same rule.
  assert.deepEqual(await privacy.eraseCustomerData(influencerA, email), { found: 1, erased: 0, blocked: 1 });
  assert.equal((await prisma.booking.findUniqueOrThrow({ where: { id: request.booking.id } })).redactedAt, null);
  // A request that is over (the session has passed) is erasable like any other.
  assert.deepEqual(await privacy.eraseCustomerData(influencerA, email, new Date(Date.now() + 10 * DAY)), { found: 1, erased: 1, blocked: 0 });

  // Approving a request whose customer was erased refuses, and sends nothing to the placeholder address.
  const erased = await seed({
    serviceId: svc.a,
    email: `erased+${run}@invalid.invalid`,
    status: "REQUESTED",
    startIn: 3 * DAY,
    holdExpiresAt: new Date(Date.now() + 6 * HOUR),
    redactedAt: new Date(),
    name: "Erased customer",
  });
  sent = [];
  await assert.rejects(approval.approveRequest(influencerA, erased.booking.id), (e: unknown) => e instanceof approval.ApprovalError && e.status === 409 && /erased/.test(e.message));
  const row = await prisma.booking.findUniqueOrThrow({ where: { id: erased.booking.id } });
  assert.equal(row.status, "REQUESTED", "still a request: it was not approved");
  assert.equal(sent.length, 0);
});

test("erase: two erasures at the same time erase, count, audit and e-mail once", { skip }, async () => {
  const { email, f } = await makeSet("race");
  const t1 = await mintToken(email);
  const t2 = await mintToken(email);
  const auditBefore = await auditNow();
  sent = [];
  const [a, b] = await Promise.all([doErase(t1), doErase(t2)]);
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  assert.deepEqual(a.body, { ok: true, erased: 6, blocked: 2 });
  assert.deepEqual(b.body, a.body, "the second tab gets the same answer");
  assert.equal((await newAudit(auditBefore)).length, 1, "one audit row");
  assert.equal(sentTo(email).length, 1, "one e-mail");
  assert.equal(await prisma.booking.count({ where: { id: { in: [f.a1, f.b1, f.b2, f.b3, f.x1, f.g1].map((x) => x.booking.id) }, redactedAt: { not: null } } }), 6);

  // Across processes (no shared in-flight run): the update of each booking is conditional, so the two calls' counts add up to the
  // bookings there were, never more.
  const more = await makeSet("race2");
  const [x, y] = await Promise.all([privacy.eraseCustomerData(influencerA, more.email), privacy.eraseCustomerData(influencerA, more.email)]);
  const total = (await prisma.booking.count({ where: { customerEmail: { startsWith: "erased+" }, id: { in: [more.f.a1, more.f.x1, more.f.g1].map((z) => z.booking.id) } } }));
  assert.equal(total, 3, "host A's three past bookings are erased");
  assert.equal(x.erased + y.erased, 3, "each booking is counted by exactly one of the two calls");
});

/* ------------------------------------------------------------------------------------------------------------------ */
/* Housekeeping, pure helpers                                                                                          */
/* ------------------------------------------------------------------------------------------------------------------ */

test("the portal and the host's erase share ONE list of kept statuses (a pending request is kept)", () => {
  const source = readFileSync(join(__dirname, "..", "lib", "customer-portal.ts"), "utf8");
  const erase = readFileSync(join(__dirname, "..", "lib", "privacy.ts"), "utf8");
  assert.ok(/import \{[^}]*\bisKeptBooking\b[^}]*\} from "@\/lib\/privacy"/.test(source), "the portal imports the shared rule");
  for (const status of ["REQUESTED", "HELD", "PENDING_PAYMENT"]) assert.ok(!source.includes(`"${status}"`), `the portal does not copy the list (${status})`);
  assert.ok(!/LIVE_STATUSES|\["HELD"/.test(source), "no copy of the status list in the portal");
  assert.ok(erase.includes("isKeptBooking(b, now)"), "and the host's erase uses the same function");
  assert.deepEqual([...privacy.KEPT_BOOKING_STATUSES].sort(), ["HELD", "PAID", "PENDING_PAYMENT", "REQUESTED", "SCHEDULED"]);
  const inFuture = { session: { endTime: new Date(Date.now() + HOUR) } };
  const over = { session: { endTime: new Date(Date.now() - HOUR) } };
  assert.equal(privacy.isKeptBooking({ status: "REQUESTED", ...inFuture }, new Date()), true);
  assert.equal(privacy.isKeptBooking({ status: "REQUESTED", ...over }, new Date()), false);
  assert.equal(privacy.isKeptBooking({ status: "CANCELLED", ...inFuture }, new Date()), false);
});

test("sweep: expired access tokens are deleted, live ones stay", { skip }, async () => {
  const email = addr("sweep");
  const old1 = await mintToken(email, -2 * HOUR);
  const old2 = await mintToken(email, -1000);
  const live = await mintToken(email, HOUR);
  const count = await sweep.sweepExpiredCustomerAccess();
  assert.ok(count >= 2, `deleted at least my two, got ${count}`);
  assert.equal(await prisma.customerAccessToken.count({ where: { tokenHash: { in: [hashToken(old1), hashToken(old2)] } } }), 0);
  assert.equal(await prisma.customerAccessToken.count({ where: { tokenHash: hashToken(live) } }), 1);
  assert.equal((await sweep.sweepExpiredCustomerAccess(new Date(Date.now() + 2 * HOUR))) >= 1, true, "and the live one once its hour is over");
  assert.equal(await prisma.customerAccessToken.count({ where: { email } }), 0);
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
  const known = addr("log");
  const unknown = addr("lognobody");
  await seedPaid(known);
  sent = [];
  const { output } = await captureConsole(async () => {
    await lib.requestPortalLink(known, { globalKey: `log-${run}` }).done;
    await lib.requestPortalLink(unknown, { globalKey: `log-${run}` }).done;
    const t = await mintToken(known);
    await getPortal(t);
    await getExport(t);
    await getPortal("garbage");
  });
  const link = /\/bookings\/([A-Za-z0-9_-]+)/.exec(sentTo(known)[0]?.text ?? "")?.[1];
  assert.ok(link);
  assert.ok(!output.includes(link!) && !output.includes(known) && !output.includes(unknown), output);
});
