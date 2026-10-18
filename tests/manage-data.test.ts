// Customer data export and erasure through the signed manage link (doc/15, 4.12): GET /api/manage/:token/data and POST
// /api/manage/:token/erase, the way to the portal's two actions when the platform sends no e-mail. Needs DATABASE_URL, TOKEN_ENCRYPTION_KEY,
// APP_SECRET (skipped otherwise). Nothing is replaced: the routes are called directly.
import "dotenv/config";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { prisma } from "../lib/db";
import { buildPortalExport } from "../lib/customer-portal";
import { loggablePath } from "../lib/rate-limit/redact";
import { matchRouteRule } from "../lib/rate-limit/policies";
import { buildPayUrl, buildSelfServiceUrl } from "../lib/self-service";
import { assertNoSecretKeys } from "./helpers/assert-no-secret-keys";

const skip = process.env.DATABASE_URL && process.env.TOKEN_ENCRYPTION_KEY && process.env.APP_SECRET ? false : "DATABASE_URL / TOKEN_ENCRYPTION_KEY / APP_SECRET not set";
const run = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
const DAY = 86_400_000;
const ENV_KEYS = ["EMAIL_PROVIDER", "APP_URL", "MESSAGING_DRY_RUN"] as const;
const savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};
let envSaved = false;

type Ctx = { params: Promise<{ token: string }> };
let dataRoute: { GET: (req: Request, ctx: Ctx) => Promise<Response> };
let eraseRoute: { POST: (req: Request, ctx: Ctx) => Promise<Response> };
let influencerId = "";
const customerEmail = `md-cust-${run}@example.com`;
const otherEmail = `md-other-${run}@example.com`;
const ids = { past: "", upcoming: "", other: "", redacted: "" };
const startedAt = new Date();

const tokenOf = (bookingId: string, ttl?: number) => new URL(buildSelfServiceUrl(bookingId, ttl)).pathname.split("/").pop()!;
const getData = (token: string) => dataRoute.GET(new Request(`http://localhost/api/manage/${token}/data`), { params: Promise.resolve({ token }) });
const erase = (token: string, body: unknown = { confirm: true }) =>
  eraseRoute.POST(new Request(`http://localhost/api/manage/${token}/erase`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }), { params: Promise.resolve({ token }) });
const keys = (o: unknown) => Object.keys(o as object).sort();

async function booking(startOffsetMs: number, status: "COMPLETED" | "SCHEDULED", email: string, name: string) {
  const start = new Date(Date.now() + startOffsetMs);
  const service = await prisma.service.findFirstOrThrow({ where: { influencerId } });
  const session = await prisma.session.create({ data: { serviceId: service.id, startTime: start, endTime: new Date(start.getTime() + 30 * 60_000) } });
  const b = await prisma.booking.create({ data: { sessionId: session.id, status, customerName: name, customerEmail: email, whatsappE164: "+919876543210", meetLink: "https://meet.google.com/aaa-bbbb-ccc" } });
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
  process.env.EMAIL_PROVIDER = "none";
  process.env.MESSAGING_DRY_RUN = "true";
  process.env.APP_URL = "http://localhost:3000";
  dataRoute = await import("../app/api/manage/[token]/data/route");
  eraseRoute = await import("../app/api/manage/[token]/erase/route");
  influencerId = (await prisma.influencer.create({ data: { slug: `md${run}`, name: `Md Host ${run}`, email: `md-host-${run}@example.com`, onboardedAt: new Date() } })).id;
  await prisma.service.create({ data: { influencerId, title: "Md 1:1", durationMin: 30, priceMinor: 1000 } });
  ids.past = await booking(-3 * DAY, "COMPLETED", customerEmail, "Md Customer");
  ids.upcoming = await booking(4 * DAY, "SCHEDULED", customerEmail, "Md Customer");
  ids.other = await booking(5 * DAY, "SCHEDULED", otherEmail, "Md Other");
  ids.redacted = await booking(-9 * DAY, "COMPLETED", `md-gone-${run}@example.com`, "Md Gone");
  await prisma.booking.update({ where: { id: ids.redacted }, data: { redactedAt: new Date(), customerName: "Erased", customerEmail: `erased-${run}@erased.invalid`, whatsappE164: "+0" } });
});

after(async () => {
  try {
    if (!skip) {
      for (const [what, fn] of [
        // The one system audit row this file's erasure wrote (it has no address in it): narrowed to this run's start and its exact numbers.
        ["audit row", () => prisma.adminAuditLog.deleteMany({ where: { adminEmail: "system:customer-request", action: "customer.erased", createdAt: { gte: startedAt }, detail: { equals: { erased: 1, blocked: 1 } } } })],
        ["influencer", () => prisma.influencer.deleteMany({ where: { id: influencerId } })],
      ] as const) {
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
  const payToken = new URL(buildPayUrl(ids.past, 3600)).pathname.split("/").pop()!;
  for (const token of ["garbage", "x".repeat(43), ids.past, payToken, tokenOf(ids.past, -10)]) {
    const d = await getData(token);
    assert.equal(d.status, 403, `GET ${token.slice(0, 12)}`);
    assert.deepEqual(await d.json(), { state: "expired" });
    const e = await erase(token);
    assert.equal(e.status, 403, `POST ${token.slice(0, 12)}`);
    assert.deepEqual(await e.json(), { state: "expired" });
  }
  assert.equal(await prisma.booking.count({ where: { customerEmail, redactedAt: null } }), 2, "nothing was erased");
});

test("a booking that is gone (erased) is a generic 404 for both", { skip }, async () => {
  const token = tokenOf(ids.redacted);
  const d = await getData(token);
  assert.equal(d.status, 404);
  assert.deepEqual(await d.json(), { state: "gone" });
  assert.equal(d.headers.get("cache-control"), "private, no-store");
  const e = await erase(token);
  assert.equal(e.status, 404);
  assert.deepEqual(await e.json(), { state: "gone" });
});

test("GET data: the portal's export for the booking customer's address, exact keys, no secrets, nobody else's data, private and no-store", { skip }, async () => {
  const res = await getData(tokenOf(ids.upcoming));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("cache-control"), "private, no-store");
  assert.match(res.headers.get("content-type") ?? "", /^application\/json/);
  assert.match(res.headers.get("content-disposition") ?? "", /^attachment; filename="my-bookings-\d{4}-\d{2}-\d{2}\.json"$/);
  assert.equal(res.headers.get("referrer-policy"), "no-referrer");
  assert.equal(res.headers.get("access-control-allow-origin"), null);
  const text = await res.text();
  const body = JSON.parse(text) as Record<string, unknown>;
  assert.deepEqual(keys(body), ["bookings", "email", "exportedAt"]);
  assert.equal(body.email, customerEmail);
  const bookings = body.bookings as Record<string, unknown>[];
  assert.equal(bookings.length, 2, "both of this customer's bookings, from the address");
  for (const b of bookings) {
    assert.deepEqual(keys(b), ["createdAt", "email", "endTime", "influencer", "intakeAnswers", "messages", "name", "payments", "phone", "reference", "service", "startTime", "status", "timeZone", "whatsappOptIn"]);
  }
  assert.deepEqual(bookings.map((b) => b.reference).sort(), [ids.past, ids.upcoming].sort());
  assertNoSecretKeys(body);
  assert.ok(!text.includes(otherEmail) && !text.includes(ids.other), "nothing of another customer");
  assert.ok(!text.includes("meet.google.com") && !/\/manage\/|token=/.test(text), "no Meet link, no manage link, no token");
  assert.ok(!text.includes(`order_md_${run}`), "no Razorpay order id");
  // The very same builder as the portal's export, so the two cannot drift.
  const portal = await buildPortalExport(customerEmail, new Date(body.exportedAt as string));
  assert.deepEqual(body, JSON.parse(JSON.stringify(portal)));
});

test("POST erase needs confirm: true, and says how many were erased and how many upcoming ones were kept", { skip }, async () => {
  assert.equal((await erase(tokenOf(ids.upcoming), {})).status, 400);
  assert.equal((await erase(tokenOf(ids.upcoming), { confirm: false })).status, 400);
  assert.equal(await prisma.booking.count({ where: { customerEmail, redactedAt: null } }), 2, "a refused request erases nothing");

  const res = await erase(tokenOf(ids.upcoming));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("cache-control"), "private, no-store");
  const body = (await res.json()) as Record<string, unknown>;
  assert.deepEqual(body, { ok: true, erased: 1, blocked: 1 });
  assertNoSecretKeys(body);

  const past = await prisma.booking.findUniqueOrThrow({ where: { id: ids.past }, include: { payments: true } });
  assert.notEqual(past.redactedAt, null, "the finished session was erased");
  assert.ok(!past.customerEmail.includes("md-cust") && past.customerName !== "Md Customer");
  assert.equal(past.payments.length, 1, "the payment record stays for accounting");
  const upcoming = await prisma.booking.findUniqueOrThrow({ where: { id: ids.upcoming } });
  assert.equal(upcoming.redactedAt, null, "an upcoming session is kept until it is cancelled or over");
  assert.equal(upcoming.customerEmail, customerEmail);
  const other = await prisma.booking.findUniqueOrThrow({ where: { id: ids.other } });
  assert.equal(other.redactedAt, null);
  assert.equal(other.customerEmail, otherEmail, "another customer is untouched");

  // The erased booking's link is now a clean 404; the kept one still works and lists only what is left.
  assert.equal((await erase(tokenOf(ids.past))).status, 404);
  assert.equal((await getData(tokenOf(ids.past))).status, 404);
  const after = JSON.parse(await (await getData(tokenOf(ids.upcoming))).text()) as { bookings: { reference: string }[] };
  assert.deepEqual(after.bookings.map((b) => b.reference), [ids.upcoming]);
});

test("the two endpoints are rate limited per address with tight budgets, and the link in the path is never logged", { skip }, () => {
  const data = matchRouteRule("GET", "/api/manage/abc.def/data");
  assert.equal(data?.name, "manage-data");
  assert.ok(data && data.limit <= 10 && data.windowMs >= 3_600_000 && data.by === "ip");
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
