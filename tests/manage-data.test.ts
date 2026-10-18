// Data export and erasure of ONE booking through the signed manage link (doc/15, 4.12): GET /api/manage/:token/data and POST
// /api/manage/:token/erase, for a platform that sends no e-mail. Needs DATABASE_URL, TOKEN_ENCRYPTION_KEY, APP_SECRET (skipped
// otherwise). Nothing is replaced: the routes are called directly.
//
// The manage link is a forwardable bearer link and booking e-mails are never verified, so the point of this file is what the link can NOT do:
// a customer with bookings at two hosts exports and erases through one link and sees and affects ONLY that booking, the other host's rows
// stay untouched, and where the platform sends e-mail (the portal's mailbox check exists) the endpoints answer a generic 404.
import "dotenv/config";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { prisma } from "../lib/db";
import { buildBookingExport, buildPortalExport } from "../lib/customer-portal";
import { loggablePath } from "../lib/rate-limit/redact";
import { IDENTITY_RULES, matchRouteRule } from "../lib/rate-limit/policies";
import { buildPayUrl, buildSelfServiceUrl } from "../lib/self-service";
import { assertNoSecretKeys } from "./helpers/assert-no-secret-keys";

const skip = process.env.DATABASE_URL && process.env.TOKEN_ENCRYPTION_KEY && process.env.APP_SECRET ? false : "DATABASE_URL / TOKEN_ENCRYPTION_KEY / APP_SECRET not set";
const run = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
const DAY = 86_400_000;
const ENV_KEYS = ["EMAIL_PROVIDER", "APP_URL", "MESSAGING_DRY_RUN", "RATE_LIMIT_STORE", "REDIS_URL"] as const;
const savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};
let envSaved = false;
const startedAt = new Date();

type Ctx = { params: Promise<{ token: string }> };
let dataRoute: { GET: (req: Request, ctx: Ctx) => Promise<Response> };
let eraseRoute: { POST: (req: Request, ctx: Ctx) => Promise<Response> };
const hosts: string[] = [];
const customerEmail = `md-cust-${run}@example.com`;
const otherEmail = `md-other-${run}@example.com`;
const ids = { past1: "", upcoming1: "", past2: "", other1: "", redacted1: "" };

const tokenOf = (bookingId: string, ttl?: number) => new URL(buildSelfServiceUrl(bookingId, ttl)).pathname.split("/").pop()!;
const getData = (token: string) => dataRoute.GET(new Request(`http://localhost/api/manage/${token}/data`), { params: Promise.resolve({ token }) });
const erase = (token: string, body: unknown = { confirm: true }) =>
  eraseRoute.POST(new Request(`http://localhost/api/manage/${token}/erase`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }), { params: Promise.resolve({ token }) });
const keys = (o: unknown) => Object.keys(o as object).sort();
const row = (id: string) => prisma.booking.findUniqueOrThrow({ where: { id }, include: { payments: true } });

async function host(label: string) {
  const inf = await prisma.influencer.create({ data: { slug: `md${label}${run}`, name: `Md Host ${label} ${run}`, email: `md-host-${label}-${run}@example.com`, onboardedAt: new Date() } });
  hosts.push(inf.id);
  await prisma.service.create({ data: { influencerId: inf.id, title: `Md service ${label}`, durationMin: 30, priceMinor: 1000 } });
  return inf.id;
}

async function booking(influencerId: string, startOffsetMs: number, status: "COMPLETED" | "SCHEDULED", email: string, name: string) {
  const start = new Date(Date.now() + startOffsetMs);
  const service = await prisma.service.findFirstOrThrow({ where: { influencerId } });
  const session = await prisma.session.create({ data: { serviceId: service.id, startTime: start, endTime: new Date(start.getTime() + 30 * 60_000) } });
  const b = await prisma.booking.create({
    data: { sessionId: session.id, status, customerName: name, customerEmail: email, whatsappE164: "+919876543210", meetLink: "https://meet.google.com/aaa-bbbb-ccc", intakeAnswers: [{ label: "Goal", answer: `answer-${run}` }] },
  });
  await prisma.payment.create({ data: { bookingId: b.id, providerOrderId: `order_md_${run}_${b.id}`, providerPaymentId: `pay_md_${run}_${b.id}`, amountMinor: 1000, currency: "INR", status: "CAPTURED" } });
  return b.id;
}

before(async () => {
  if (skip) return;
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  envSaved = true;
  process.env.EMAIL_PROVIDER = "none"; // the platform sends no e-mail: the situation these endpoints exist for
  process.env.MESSAGING_DRY_RUN = "true";
  process.env.RATE_LIMIT_STORE = "memory";
  process.env.APP_URL = "http://localhost:3000";
  dataRoute = await import("../app/api/manage/[token]/data/route");
  eraseRoute = await import("../app/api/manage/[token]/erase/route");
  const h1 = await host("1");
  const h2 = await host("2");
  // One customer (one e-mail address) with bookings at TWO hosts, and an unrelated customer at the first host.
  ids.past1 = await booking(h1, -3 * DAY, "COMPLETED", customerEmail, "Md Customer");
  ids.upcoming1 = await booking(h1, 4 * DAY, "SCHEDULED", customerEmail, "Md Customer");
  ids.past2 = await booking(h2, -6 * DAY, "COMPLETED", customerEmail, "Md Customer");
  ids.other1 = await booking(h1, 5 * DAY, "SCHEDULED", otherEmail, "Md Other");
  ids.redacted1 = await booking(h1, -9 * DAY, "COMPLETED", `md-gone-${run}@example.com`, "Md Gone");
  await prisma.booking.update({ where: { id: ids.redacted1 }, data: { redactedAt: new Date(), customerName: "Erased", customerEmail: `erased-${run}@erased.invalid`, whatsappE164: "+0" } });
});

after(async () => {
  try {
    if (!skip) {
      const steps: [string, () => Promise<unknown>][] = [
        // The system audit rows this file's erasures wrote (they carry no address): narrowed to this run's start and its exact numbers.
        ["audit rows", () => prisma.adminAuditLog.deleteMany({ where: { adminEmail: "system:customer-request", action: "customer.erased", createdAt: { gte: startedAt }, detail: { equals: { erased: 1, blocked: 0 } } } })],
        ["influencers", () => prisma.influencer.deleteMany({ where: { id: { in: hosts } } })],
      ];
      for (const [what, fn] of steps) {
        try {
          await fn();
        } catch (e) {
          console.error(`[manage-data] cleanup step failed (${what}):`, e instanceof Error ? e.message : e);
        }
      }
    }
  } finally {
    if (envSaved) {
      for (const k of ENV_KEYS) {
        if (savedEnv[k] === undefined) delete process.env[k];
        else process.env[k] = savedEnv[k];
      }
    }
    await prisma.$disconnect().catch(() => undefined);
  }
});

test("only a signed manage token is accepted: garbage, a pay link's token, an expired token and a bare booking id are 403, and nothing is read or changed", { skip }, async () => {
  const payToken = new URL(buildPayUrl(ids.past1, 3600)).pathname.split("/").pop()!;
  for (const token of ["garbage", "x".repeat(43), ids.past1, payToken, tokenOf(ids.past1, -10)]) {
    const d = await getData(token);
    assert.equal(d.status, 403, `GET ${token.slice(0, 12)}`);
    assert.deepEqual(await d.json(), { state: "expired" });
    const e = await erase(token);
    assert.equal(e.status, 403, `POST ${token.slice(0, 12)}`);
    assert.deepEqual(await e.json(), { state: "expired" });
  }
  assert.equal(await prisma.booking.count({ where: { customerEmail, redactedAt: null } }), 3, "nothing was erased");
});

test("a booking that is gone (erased) is a generic 404 for both", { skip }, async () => {
  const token = tokenOf(ids.redacted1);
  const d = await getData(token);
  assert.equal(d.status, 404);
  assert.deepEqual(await d.json(), { state: "gone" });
  assert.equal(d.headers.get("cache-control"), "private, no-store");
  const e = await erase(token);
  assert.equal(e.status, 404);
  assert.deepEqual(await e.json(), { state: "gone" });
});

test("where the platform sends e-mail the portal is the way: both endpoints answer a generic 404 and change nothing", { skip }, async () => {
  for (const provider of ["resend", "postmark", "log"]) {
    process.env.EMAIL_PROVIDER = provider;
    try {
      const token = tokenOf(ids.past1);
      const d = await getData(token);
      assert.equal(d.status, 404, provider);
      assert.deepEqual(await d.json(), { state: "gone" });
      const e = await erase(token);
      assert.equal(e.status, 404, provider);
      assert.deepEqual(await e.json(), { state: "gone" });
      // Even a forged token gets the same answer: nothing about the link is revealed.
      assert.equal((await getData("garbage")).status, 404);
    } finally {
      process.env.EMAIL_PROVIDER = "none";
    }
  }
  assert.equal((await row(ids.past1)).redactedAt, null, "nothing was erased");
});

test("GET data: ONLY the booking the link belongs to (not the address's other bookings, not the other host's), exact keys, no secrets", { skip }, async () => {
  const res = await getData(tokenOf(ids.past1));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("cache-control"), "private, no-store");
  assert.match(res.headers.get("content-type") ?? "", /^application\/json/);
  assert.match(res.headers.get("content-disposition") ?? "", /^attachment; filename="my-booking-\d{4}-\d{2}-\d{2}\.json"$/);
  assert.equal(res.headers.get("referrer-policy"), "no-referrer");
  assert.equal(res.headers.get("access-control-allow-origin"), null);
  const text = await res.text();
  const body = JSON.parse(text) as Record<string, unknown>;
  assert.deepEqual(keys(body), ["bookings", "email", "exportedAt"]);
  assert.equal(body.email, customerEmail);
  const bookings = body.bookings as Record<string, unknown>[];
  assert.equal(bookings.length, 1, "this one booking, although the address has three");
  assert.deepEqual(keys(bookings[0]), ["createdAt", "email", "endTime", "influencer", "intakeAnswers", "messages", "name", "payments", "phone", "reference", "service", "startTime", "status", "timeZone", "whatsappOptIn"]);
  assert.equal(bookings[0].reference, ids.past1);
  assert.equal(bookings[0].influencer, `Md Host 1 ${run}`);
  assert.deepEqual(bookings[0].intakeAnswers, [{ question: "Goal", answer: `answer-${run}` }]);
  assertNoSecretKeys(body);
  // Nothing of the address's other bookings, the other host or another customer.
  for (const other of [ids.upcoming1, ids.past2, ids.other1]) assert.ok(!text.includes(other), `booking ${other} is not in the export`);
  assert.ok(!text.includes(`Md Host 2 ${run}`) && !text.includes("Md service 2") && !text.includes(otherEmail), "no other host, no other customer");
  assert.ok(!text.includes(`pay_md_${run}_${ids.past2}`) && !text.includes(`pay_md_${run}_${ids.upcoming1}`), "no other booking's payment reference");
  assert.ok(!text.includes("meet.google.com") && !/\/manage\/|token=/.test(text), "no Meet link, no manage link, no token");
  assert.ok(!text.includes(`order_md_${run}`), "no Razorpay order id");
  // Same field policy as the portal's export, for one booking: it is exactly that export's row for this booking.
  const portal = await buildPortalExport(customerEmail, new Date(body.exportedAt as string));
  assert.equal(portal.bookings.length, 3, "the portal (which proves a mailbox) does cover all three");
  assert.deepEqual(bookings[0], JSON.parse(JSON.stringify(portal.bookings.find((b) => b.reference === ids.past1))));
  // The single-booking builder refuses another address: a booking id with the wrong e-mail exports nothing.
  assert.deepEqual((await buildBookingExport(ids.past1, otherEmail)).bookings, []);
});

test("POST erase needs confirm: true, and affects ONLY this booking: the same address's booking at ANOTHER host and its upcoming one stay as they were", { skip }, async () => {
  assert.equal((await erase(tokenOf(ids.past1), {})).status, 400);
  assert.equal((await erase(tokenOf(ids.past1), { confirm: false })).status, 400);
  assert.equal(await prisma.booking.count({ where: { customerEmail, redactedAt: null } }), 3, "a refused request erases nothing");

  const res = await erase(tokenOf(ids.past1));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("cache-control"), "private, no-store");
  const body = (await res.json()) as Record<string, unknown>;
  assert.deepEqual(body, { ok: true, erased: 1, blocked: 0 }, "counts for this booking only");
  assert.deepEqual(keys(body), ["blocked", "erased", "ok"]);
  assertNoSecretKeys(body);

  const past1 = await row(ids.past1);
  assert.notEqual(past1.redactedAt, null, "the booking whose link was used is erased");
  assert.ok(!past1.customerEmail.includes("md-cust") && past1.customerName !== "Md Customer" && past1.whatsappE164 === "");
  assert.equal(past1.payments.length, 1, "its payment record stays for accounting");
  // The same address's OTHER bookings: the finished one at the other host is untouched, and so is the upcoming one at this host.
  for (const id of [ids.past2, ids.upcoming1]) {
    const b = await row(id);
    assert.equal(b.redactedAt, null, `booking ${id} was not erased`);
    assert.equal(b.customerEmail, customerEmail);
    assert.equal(b.customerName, "Md Customer");
    assert.equal(b.whatsappE164, "+919876543210");
    assert.equal(b.payments.length, 1);
  }
  const other = await row(ids.other1);
  assert.equal(other.redactedAt, null);
  assert.equal(other.customerEmail, otherEmail, "another customer is untouched");

  // The erased booking's link is now a clean 404; the other bookings' own links still work and show only themselves.
  assert.equal((await erase(tokenOf(ids.past1))).status, 404);
  assert.equal((await getData(tokenOf(ids.past1))).status, 404);
  const second = JSON.parse(await (await getData(tokenOf(ids.past2))).text()) as { bookings: { reference: string }[] };
  assert.deepEqual(second.bookings.map((b) => b.reference), [ids.past2]);
});

test("kept-booking rule: an upcoming live session is not erased (blocked 1, erased 0), and its own link stays usable", { skip }, async () => {
  const res = await erase(tokenOf(ids.upcoming1));
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, erased: 0, blocked: 1 });
  const b = await row(ids.upcoming1);
  assert.equal(b.redactedAt, null);
  assert.equal(b.customerEmail, customerEmail);
  assert.equal((await getData(tokenOf(ids.upcoming1))).status, 200);
  assert.equal((await row(ids.past2)).redactedAt, null, "still nothing at the other host");
});

test("each booking has its own budget: hammering one leaked link is stopped, the customer's other links are not", { skip }, async () => {
  const token = tokenOf(ids.upcoming1);
  const used = 1; // the kept-booking test above already downloaded once with this booking's link
  const statuses: number[] = [];
  for (let i = 0; i < IDENTITY_RULES.manageDataBooking.limit + 2; i++) statuses.push((await getData(token)).status);
  assert.deepEqual(statuses.filter((s) => s === 200).length, IDENTITY_RULES.manageDataBooking.limit - used, "up to the budget, counting what was used");
  assert.deepEqual(statuses.filter((s) => s === 429).length, 3);
  const limited = await getData(token);
  assert.equal(limited.status, 429);
  assert.ok(limited.headers.get("retry-after"));
  assert.equal((await getData(tokenOf(ids.past2))).status, 200, "another booking of the same customer has its own budget");
  const erasures: number[] = [];
  for (let i = 0; i < IDENTITY_RULES.manageEraseBooking.limit + 1; i++) erasures.push((await erase(token)).status);
  assert.deepEqual(erasures.slice(-1), [429]);
  assert.ok(IDENTITY_RULES.manageDataBooking.limit <= 5 && IDENTITY_RULES.manageEraseBooking.limit <= 3 && IDENTITY_RULES.manageDataBooking.windowMs >= 3_600_000);
});

test("both endpoints are also limited per IP at the proxy with tight budgets, and the link in the path is never logged", { skip }, () => {
  const data = matchRouteRule("GET", "/api/manage/abc.def/data");
  assert.equal(data?.name, "manage-data");
  assert.ok(data && data.limit <= 10 && data.windowMs >= 3_600_000 && data.by === "ip", "per IP here; per booking in the handler (IDENTITY_RULES)");
  assert.equal(matchRouteRule("HEAD", "/api/manage/abc.def/data")?.name, "manage-data");
  const del = matchRouteRule("POST", "/api/manage/abc.def/erase");
  assert.equal(del?.name, "manage-erase");
  assert.ok(del && del.limit <= 5 && del.windowMs >= 3_600_000);
  // Reading the manage page and acting on the booking keep their own rules.
  assert.equal(matchRouteRule("GET", "/api/manage/abc.def")?.name, "self-service-view");
  assert.equal(matchRouteRule("POST", "/api/manage/abc.def")?.name, "self-service");
  assert.equal(matchRouteRule("GET", "/api/manage/abc.def/other")?.name, "self-service");
  assert.equal(loggablePath("/api/manage/abc.def/data"), "/api/manage/:token/data");
  assert.equal(loggablePath("/api/manage/abc.def/erase"), "/api/manage/:token/erase");
});
