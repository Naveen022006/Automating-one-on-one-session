// Integration test of the five dashboard endpoints behind the Overview, Sessions, Messages, Customers and Earnings pages
// (needs DATABASE_URL, TOKEN_ENCRYPTION_KEY, APP_SECRET; skipped otherwise):
//   D1 GET /api/dashboard/overview   D2 GET /api/dashboard/sessions   D3 GET /api/dashboard/messages
//   D4 GET /api/dashboard/customers  D5 GET /api/dashboard/earnings
// Two influencers ("Alpha" and "Bravo") each get the same kinds of rows; every endpoint must show a signed-in influencer
// their own rows and never the other's. Only `next/headers` is replaced (the cookies of a request are chosen per call).
// Every body goes through assertNoSecretKeys and the exact key sets are pinned, so adding a field is a deliberate act.
import "dotenv/config";
import assert from "node:assert/strict";
import { after, before, mock, test } from "node:test";
import { prisma } from "../lib/db";
import { parsePageParam } from "../lib/views/dashboard-params";
import { parseMessageStatus } from "../lib/views/dashboard-messages";
import { parseSessionView } from "../lib/views/dashboard-sessions";
import { assertNoSecretKeys } from "./helpers/assert-no-secret-keys";

const skip = process.env.DATABASE_URL && process.env.TOKEN_ENCRYPTION_KEY && process.env.APP_SECRET ? false : "DATABASE_URL / TOKEN_ENCRYPTION_KEY / APP_SECRET not set";
const run = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
const DAY = 86_400_000;

const jar = new Map<string, string>();
type Handler = (req: Request) => Promise<Response>;
let routes: { overview: Handler; sessions: Handler; messages: Handler; customers: Handler; earnings: Handler };
let authLib: typeof import("../lib/auth/session");

interface Owner {
  label: "Alpha" | "Bravo";
  userId: string;
  influencerId: string;
  cookie: string;
  name: string;
  slug: string;
  /** Amounts in paise, so the two owners' totals differ. */
  pay: { upcoming: number; past: number; pastRefund: number; cancelled: number };
}
const owners: Record<"A" | "B", Owner> = {
  A: { label: "Alpha", userId: "", influencerId: "", cookie: "", name: `Alpha Owner ${run}`, slug: `core-a-${run}`, pay: { upcoming: 1000, past: 2000, pastRefund: 500, cancelled: 700 } },
  B: { label: "Bravo", userId: "", influencerId: "", cookie: "", name: `Bravo Owner ${run}`, slug: `core-b-${run}`, pay: { upcoming: 1100, past: 3000, pastRefund: 0, cancelled: 900 } },
};
const A = owners.A;
const B = owners.B;

const customerName = (o: Owner, kind: string) => `${o.label} ${kind} ${run}`;
const customerEmail = (o: Owner, kind: string) => `${o.label}-${kind}-${run}@example.com`.toLowerCase();
const failedError = (o: Owner) => `boom-${o.label}-${run}`;

async function ask(handler: Handler, query = "", cookie?: string): Promise<{ status: number; body: Record<string, unknown>; headers: Headers }> {
  jar.clear();
  if (cookie !== undefined) jar.set(authLib.sessionCookieName(), cookie);
  const res = await handler(new Request(`http://localhost/api/dashboard/x${query}`));
  return { status: res.status, body: (await res.json()) as Record<string, unknown>, headers: res.headers };
}
const keys = (o: unknown) => Object.keys(o as object).sort();

/** The same kinds of rows for one owner: an upcoming paid session, a past one with a part-refunded payment, a request, a cancellation due a refund, an erased customer. */
async function seed(o: Owner) {
  const service = await prisma.service.create({ data: { influencerId: o.influencerId, title: `${o.label} call ${run}`, durationMin: 30, priceMinor: 1000 } });
  const session = async (startOffsetMs: number) => {
    const start = new Date(Date.now() + startOffsetMs);
    return prisma.session.create({ data: { serviceId: service.id, startTime: start, endTime: new Date(start.getTime() + 30 * 60_000) } });
  };
  const booking = (sessionId: string, kind: string, status: "SCHEDULED" | "COMPLETED" | "REQUESTED" | "CANCELLED", extra: Record<string, unknown> = {}) =>
    prisma.booking.create({
      data: { sessionId, status, customerName: customerName(o, kind), customerEmail: customerEmail(o, kind), whatsappE164: "+919876543210", whatsappOptIn: true, ...extra },
    });
  const payment = (bookingId: string, kind: string, amountMinor: number, extra: Record<string, unknown> = {}) =>
    prisma.payment.create({ data: { bookingId, providerOrderId: `order_${o.label}_${kind}_${run}`, amountMinor, currency: "INR", status: "CAPTURED", ...extra } });

  const upcoming = await booking((await session(3 * DAY)).id, "Upcoming", "SCHEDULED");
  await payment(upcoming.id, "up", o.pay.upcoming);
  await prisma.message.create({ data: { bookingId: upcoming.id, channel: "EMAIL", template: "booking-confirmation", status: "DELIVERED" } });
  await prisma.message.create({ data: { bookingId: upcoming.id, channel: "WHATSAPP", template: "booking-confirmation", status: "FAILED", error: failedError(o) } });

  const past = await booking((await session(-2 * DAY)).id, "Past", "COMPLETED");
  await payment(past.id, "past", o.pay.past, { createdAt: new Date("2024-03-31T23:30:00.000Z"), ...(o.pay.pastRefund ? { refundAmountMinor: o.pay.pastRefund, refundStatus: "processed" } : {}) });
  await prisma.message.create({ data: { bookingId: past.id, channel: "EMAIL", template: "receipt", status: "PENDING" } });

  await booking((await session(4 * DAY)).id, "Request", "REQUESTED", { holdExpiresAt: new Date(Date.now() + DAY) });

  const cancelled = await booking((await session(5 * DAY)).id, "Cancelled", "CANCELLED");
  await payment(cancelled.id, "canc", o.pay.cancelled, { createdAt: new Date("2024-03-10T12:00:00.000Z"), needsRefund: true });

  await booking((await session(-3 * DAY)).id, "Erased", "COMPLETED", { redactedAt: new Date() });
}

before(async () => {
  if (skip) return;
  process.env.RATE_LIMIT_STORE = "memory";
  mock.module("next/headers", {
    namedExports: {
      cookies: async () => ({ get: (name: string) => (jar.has(name) ? { name, value: jar.get(name) } : undefined) }),
      headers: async () => new Headers(),
    },
  });
  authLib = await import("../lib/auth/session");
  const email = await import("../lib/email");
  email.setEmailSender(async () => ({ providerMessageId: null }));
  routes = {
    overview: (await import("../app/api/dashboard/overview/route")).GET,
    sessions: (await import("../app/api/dashboard/sessions/route")).GET,
    messages: (await import("../app/api/dashboard/messages/route")).GET,
    customers: (await import("../app/api/dashboard/customers/route")).GET,
    earnings: (await import("../app/api/dashboard/earnings/route")).GET,
  };
  const accounts = await import("../lib/auth/accounts");
  for (const o of [A, B]) {
    const registered = await accounts.registerAccount({
      name: o.name,
      email: `core-${o.label}-${run}@example.com`.toLowerCase(),
      password: "a long passphrase for the core test",
      slug: o.slug,
      timezone: "Asia/Kolkata",
      acceptTerms: true,
    });
    o.userId = registered.userId;
    o.influencerId = (await prisma.user.findUniqueOrThrow({ where: { id: o.userId } })).influencerId;
    o.cookie = await authLib.createSession(o.userId);
    await seed(o);
  }
});

after(async () => {
  if (!skip) await prisma.influencer.deleteMany({ where: { id: { in: [A.influencerId, B.influencerId].filter(Boolean) } } });
  await prisma.$disconnect();
});

/** Nothing of the other owner may be in a body: no name, email, service title, error text, id. */
function assertOnlyOwn(body: unknown, mine: Owner, theirs: Owner) {
  const text = JSON.stringify(body);
  assert.ok(!text.includes(theirs.label), `the body of ${mine.label} mentions ${theirs.label}`);
  assert.ok(!text.includes(theirs.influencerId) && !text.includes(theirs.userId) && !text.includes(theirs.cookie));
  assert.ok(!text.includes(mine.userId) && !text.includes(mine.influencerId) && !text.includes(mine.cookie), "no influencer id, user id or session token");
  assertNoSecretKeys(body);
}

/* ---------- pure URL rules (no database) ---------- */

test("URL parameters: an odd page is page 1, an unknown view is upcoming, an unknown status is all", () => {
  for (const odd of [null, undefined, "", "0", "-3", "abc", "1e9", "10000", "99999999999", "NaN", " "]) assert.equal(parsePageParam(odd), 1, `page ${JSON.stringify(odd)}`);
  assert.equal(parsePageParam("2"), 2);
  assert.equal(parsePageParam("2.7"), 2);
  assert.equal(parsePageParam("9999"), 9999);
  for (const v of ["upcoming", "requests", "past", "cancelled", "attention"]) assert.equal(parseSessionView(v), v);
  for (const odd of [null, undefined, "", "UPCOMING", "all", "../x", "past ", "__proto__"]) assert.equal(parseSessionView(odd), "upcoming", `view ${JSON.stringify(odd)}`);
  for (const s of ["FAILED", "PENDING", "DELIVERED"]) assert.equal(parseMessageStatus(s), s);
  for (const odd of [null, undefined, "", "SENT", "READ", "failed", "all", "constructor"]) assert.equal(parseMessageStatus(odd), "", `status ${JSON.stringify(odd)}`);
});

/* ---------- 401 ---------- */

test("every endpoint answers 401 without a session cookie, or a blank or garbage one, and sends no data", { skip }, async () => {
  for (const [name, handler] of Object.entries(routes)) {
    for (const cookie of [undefined, "", "not-a-real-session-token"]) {
      const out = await ask(handler, "", cookie);
      assert.equal(out.status, 401, `${name} with cookie ${JSON.stringify(cookie)}`);
      assert.deepEqual(keys(out.body), ["error"], `${name}: only an error sentence`);
      assert.equal(typeof out.body.error, "string");
    }
  }
});

/* ---------- D1 ---------- */

test("D1 GET /api/dashboard/overview: the owner's own checklist, attention items, week and month, with exactly the hand-picked fields", { skip }, async () => {
  const out = await ask(routes.overview, "", A.cookie);
  assert.equal(out.status, 200);
  assert.equal(out.headers.get("cache-control"), "private, no-store");
  assert.equal(out.headers.get("access-control-allow-origin"), null);
  assert.deepEqual(keys(out.body), ["firstName", "live", "overview", "publicUrl", "readiness"]);
  assert.deepEqual(keys(out.body.overview), ["attention", "monthEarnings", "sessionsThisWeek", "upcoming"], "no Google status and no per-service breakdown");
  assert.deepEqual(keys((out.body.overview as { monthEarnings: object }).monthEarnings), ["totalsByCurrency"]);
  assert.deepEqual(keys(out.body.readiness), ["blockers", "items", "ready"]);

  assert.equal(out.body.firstName, "Alpha");
  assert.equal(out.body.publicUrl, `${(process.env.APP_URL || "http://localhost:3000").replace(/\/$/, "")}/${A.slug}`);
  assert.equal(out.body.live, false, "email and Google are not set up yet, so the page is not live");

  const overview = out.body.overview as {
    attention: { kind: string; href: string }[];
    sessionsThisWeek: number;
    monthEarnings: { totalsByCurrency: { currency: string; amountMinor: number }[] };
    upcoming: { serviceTitle: string; bookings: { customerName: string }[] }[];
  };
  assert.deepEqual(
    overview.attention.map((a) => a.kind).sort(),
    ["booking-request", "failed-message", "google", "needs-refund", "verify-email"],
  );
  assert.equal(overview.attention.find((a) => a.kind === "needs-refund")!.href, "/dashboard/sessions?view=attention");
  assert.equal(overview.attention.find((a) => a.kind === "google")!.href, "/dashboard/settings#google");
  assert.equal(overview.sessionsThisWeek, 1);
  assert.deepEqual(overview.upcoming.map((s) => s.bookings.map((b) => b.customerName)), [[customerName(A, "Upcoming")]]);
  assert.deepEqual(overview.monthEarnings.totalsByCurrency, [{ currency: "INR", amountMinor: A.pay.upcoming }], "only the payment made this month");
  assertOnlyOwn(out.body, A, B);

  const theirs = await ask(routes.overview, "", B.cookie);
  assert.equal(theirs.body.firstName, "Bravo");
  assert.deepEqual((theirs.body.overview as typeof overview).monthEarnings.totalsByCurrency, [{ currency: "INR", amountMinor: B.pay.upcoming }]);
  assertOnlyOwn(theirs.body, B, A);
});

test("D1: the checklist, the live flag and the attention list follow the account's real state", { skip }, async () => {
  await prisma.user.update({ where: { id: A.userId }, data: { emailVerifiedAt: new Date() } });
  try {
    const out = await ask(routes.overview, "", A.cookie);
    const kinds = ((out.body.overview as { attention: { kind: string }[] }).attention).map((a) => a.kind);
    assert.ok(!kinds.includes("verify-email"), "no email item once the email is confirmed");
    const readiness = out.body.readiness as { items: { key: string; state: string }[]; blockers: { key: string }[] };
    assert.equal(readiness.items.find((i) => i.key === "email")!.state, "done");
    assert.equal(readiness.items.find((i) => i.key === "service")!.state, "done", "the seeded service counts");
    assert.ok(readiness.blockers.some((b) => b.key === "availability"), "no weekly hours yet: still blocked");
    // `live` is the old page's rule: nothing blocks it except steps that are not email or a connection (which connections are
    // required is configuration, so the expectation is derived from the blockers the same response carries).
    assert.equal(out.body.live, readiness.blockers.every((b) => !["email", "google", "gmail", "whatsapp", "payout"].includes(b.key)));
  } finally {
    await prisma.user.update({ where: { id: A.userId }, data: { emailVerifiedAt: null } });
  }
});

/* ---------- D2 ---------- */

test("D2 GET /api/dashboard/sessions: each tab shows the owner's matching sessions only, an unknown view is upcoming, odd pages are page 1", { skip }, async () => {
  const names = (body: Record<string, unknown>) => (body.sessions as { bookings: { customerName: string }[] }[]).flatMap((s) => s.bookings.map((b) => b.customerName)).sort();
  const expected: Record<string, string[]> = {
    upcoming: [customerName(A, "Upcoming")],
    requests: [customerName(A, "Request")],
    past: [customerName(A, "Erased"), customerName(A, "Past")].sort(),
    cancelled: [customerName(A, "Cancelled")],
    attention: [customerName(A, "Cancelled")],
  };
  for (const [view, who] of Object.entries(expected)) {
    const out = await ask(routes.sessions, `?view=${view}`, A.cookie);
    assert.equal(out.status, 200, view);
    assert.equal(out.headers.get("cache-control"), "private, no-store");
    assert.deepEqual(keys(out.body), ["page", "pageCount", "sessions", "total", "view"]);
    assert.equal(out.body.view, view);
    assert.equal(out.body.total, who.length, `${view}: total`);
    assert.equal(out.body.page, 1);
    assert.equal(out.body.pageCount, 1);
    assert.deepEqual(names(out.body), who, view);
    assertOnlyOwn(out.body, A, B);
  }

  // The other owner gets their own rows from the same URL, and no tab of one ever contains the other's.
  for (const view of Object.keys(expected)) {
    const out = await ask(routes.sessions, `?view=${view}`, B.cookie);
    assert.ok(names(out.body).every((n) => n.startsWith("Bravo")), `${view}: only Bravo's customers`);
    assert.equal(out.body.total, expected[view].length);
    assertOnlyOwn(out.body, B, A);
  }

  // Fallbacks.
  for (const odd of ["", "?view=bogus", "?view=UPCOMING", "?view=", "?view=__proto__", "?view=past;drop"]) {
    const out = await ask(routes.sessions, odd, A.cookie);
    assert.equal(out.body.view, "upcoming", `view fallback for ${odd}`);
    assert.deepEqual(names(out.body), expected.upcoming);
  }
  for (const odd of ["?page=0", "?page=-2", "?page=abc", "?page=1e9", "?page=99999999999999", "?page=%00"]) {
    const out = await ask(routes.sessions, odd, A.cookie);
    assert.equal(out.status, 200, odd);
    assert.equal(out.body.page, 1, `page fallback for ${odd}`);
  }
  const beyond = await ask(routes.sessions, "?page=3", A.cookie);
  assert.equal(beyond.body.page, 3, "a page past the end is allowed and empty, as the old page did");
  assert.deepEqual(beyond.body.sessions, []);
  assert.equal(beyond.body.total, 1);
});

test("D2: a session row has exactly the fields SessionsBoard takes, and the redacted customer is marked", { skip }, async () => {
  const past = await ask(routes.sessions, "?view=past", A.cookie);
  const rows = past.body.sessions as Record<string, unknown>[];
  assert.deepEqual(keys(rows[0]), ["bookings", "capacity", "durationMin", "endTime", "id", "meetLink", "seatsFilled", "serviceId", "serviceTitle", "serviceType", "startTime"]);
  const bookings = rows.flatMap((r) => r.bookings as Record<string, unknown>[]);
  assert.deepEqual(keys(bookings[0]), ["customerEmail", "customerName", "id", "lastError", "latestByChannel", "meetLink", "payment", "redacted", "status"]);
  assert.equal(bookings.filter((b) => b.redacted === true).length, 1);
  const withPayment = bookings.find((b) => b.payment !== null)!;
  assert.deepEqual(keys(withPayment.payment), ["amountMinor", "currency", "needsRefund", "status"]);
  assert.equal(typeof rows[0].startTime, "string", "times are ISO strings");
});

/* ---------- D3 ---------- */

test("D3 GET /api/dashboard/messages: the owner's messages only, the status filter is a whitelist, odd pages are page 1", { skip }, async () => {
  const all = await ask(routes.messages, "", A.cookie);
  assert.equal(all.status, 200);
  assert.equal(all.headers.get("cache-control"), "private, no-store");
  assert.deepEqual(keys(all.body), ["messages", "page", "pageCount", "status"]);
  const rows = all.body.messages as Record<string, unknown>[];
  assert.equal(rows.length, 3);
  assert.deepEqual(keys(rows[0]), ["at", "bookingId", "channel", "customerName", "error", "serviceTitle", "sessionStart", "status", "template"]);
  assert.ok(rows.every((m) => String(m.customerName).startsWith("Alpha") && String(m.serviceTitle) === `Alpha call ${run}`));
  assertOnlyOwn(all.body, A, B);

  const by = async (status: string) => (await ask(routes.messages, `?status=${status}`, A.cookie)).body;
  const failed = await by("FAILED");
  assert.equal(failed.status, "FAILED");
  assert.deepEqual((failed.messages as { error: string }[]).map((m) => m.error), [failedError(A)]);
  assert.deepEqual(((await by("DELIVERED")).messages as { template: string; channel: string }[]).map((m) => `${m.channel}:${m.template}`), ["EMAIL:booking-confirmation"]);
  assert.deepEqual(((await by("PENDING")).messages as { template: string }[]).map((m) => m.template), ["receipt"]);
  for (const odd of ["SENT", "READ", "failed", "all", "", "x%27%20OR%201=1"]) {
    const out = await by(odd);
    assert.equal(out.status, "", `status fallback for ${odd}`);
    assert.equal((out.messages as unknown[]).length, 3, odd);
  }
  for (const odd of ["0", "-1", "abc", "1e9"]) assert.equal((await ask(routes.messages, `?page=${odd}`, A.cookie)).body.page, 1, `page ${odd}`);

  const theirs = await ask(routes.messages, "", B.cookie);
  assert.equal((theirs.body.messages as unknown[]).length, 3);
  assert.deepEqual(((await ask(routes.messages, "?status=FAILED", B.cookie)).body.messages as { error: string }[]).map((m) => m.error), [failedError(B)]);
  assertOnlyOwn(theirs.body, B, A);
});

/* ---------- D4 ---------- */

test("D4 GET /api/dashboard/customers: the owner's customers grouped by email, searchable, the erased and requested excluded, never the other owner's", { skip }, async () => {
  const out = await ask(routes.customers, "", A.cookie);
  assert.equal(out.status, 200);
  assert.equal(out.headers.get("cache-control"), "private, no-store");
  assert.deepEqual(keys(out.body), ["customers", "q"]);
  assert.equal(out.body.q, "");
  const customers = out.body.customers as { name: string; email: string; bookings: number; spentByCurrency: unknown[]; lastSession: string | null; nextSession: string | null }[];
  assert.deepEqual(customers.map((c) => c.name).sort(), [customerName(A, "Cancelled"), customerName(A, "Past"), customerName(A, "Upcoming")].sort(), "no erased customer, no unpaid request");
  assert.deepEqual(keys(customers[0]), ["bookings", "email", "lastSession", "name", "nextSession", "spentByCurrency"]);
  const upcoming = customers.find((c) => c.name === customerName(A, "Upcoming"))!;
  assert.equal(upcoming.email, customerEmail(A, "Upcoming"));
  assert.deepEqual(upcoming.spentByCurrency, [{ currency: "INR", amountMinor: A.pay.upcoming }]);
  assert.equal(upcoming.lastSession, null);
  assert.equal(typeof upcoming.nextSession, "string");
  assertNoSecretKeys(out.body);
  assert.ok(!JSON.stringify(out.body).includes("Bravo"));

  // Search: by name (any case), by email, trimmed, and what was used is echoed back.
  const byName = await ask(routes.customers, `?q=${encodeURIComponent(`  ALPHA past ${run}  `)}`, A.cookie);
  assert.equal(byName.body.q, `ALPHA past ${run}`, "trimmed, case kept for the box");
  assert.deepEqual((byName.body.customers as { name: string }[]).map((c) => c.name), [customerName(A, "Past")]);
  const byEmail = await ask(routes.customers, `?q=${encodeURIComponent(customerEmail(A, "Upcoming"))}`, A.cookie);
  assert.deepEqual((byEmail.body.customers as { email: string }[]).map((c) => c.email), [customerEmail(A, "Upcoming")]);
  assert.deepEqual((await ask(routes.customers, "?q=Bravo", A.cookie)).body.customers, [], "searching for the other owner's name finds nothing");
  assert.deepEqual((await ask(routes.customers, `?q=${encodeURIComponent(customerEmail(B, "Upcoming"))}`, A.cookie)).body.customers, []);
  const blank = await ask(routes.customers, "?q=%20%20", A.cookie);
  assert.equal(blank.body.q, "");
  assert.equal((blank.body.customers as unknown[]).length, 3, "a blank search lists everyone");
  const long = await ask(routes.customers, `?q=${"x".repeat(500)}`, A.cookie);
  assert.equal((long.body.q as string).length, 200, "at most 200 characters");
  assert.deepEqual(long.body.customers, []);

  const theirs = await ask(routes.customers, "", B.cookie);
  assert.deepEqual((theirs.body.customers as { name: string }[]).map((c) => c.name).sort(), [customerName(B, "Cancelled"), customerName(B, "Past"), customerName(B, "Upcoming")].sort());
  assert.ok(!JSON.stringify(theirs.body).includes("Alpha"));
  assert.deepEqual((await ask(routes.customers, "?q=Alpha", B.cookie)).body.customers, []);
});

/* ---------- D5 ---------- */

test("D5 GET /api/dashboard/earnings: dates default to this month (UTC), the range is inclusive of its last day, nothing of the other owner is counted", { skip }, async () => {
  const before = new Date();
  const out = await ask(routes.earnings, "", A.cookie);
  const after = new Date();
  assert.equal(out.status, 200);
  assert.equal(out.headers.get("cache-control"), "private, no-store");
  assert.deepEqual(keys(out.body), ["from", "paymentCount", "refundedCount", "summary", "to"]);
  assert.deepEqual(keys(out.body.summary), ["byService", "totalsByCurrency"]);
  const monthStart = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)).toISOString().slice(0, 10);
  assert.ok([monthStart(before), monthStart(after)].includes(out.body.from as string), "from = the 1st of this month (UTC)");
  assert.ok([before.toISOString().slice(0, 10), after.toISOString().slice(0, 10)].includes(out.body.to as string), "to = today (UTC)");
  assert.equal(out.body.paymentCount, 1, "this month only the upcoming booking's payment");
  assert.deepEqual((out.body.summary as { totalsByCurrency: unknown }).totalsByCurrency, [{ currency: "INR", amountMinor: A.pay.upcoming }]);

  const march = await ask(routes.earnings, "?from=2024-03-01&to=2024-03-31", A.cookie);
  assert.equal(march.body.from, "2024-03-01");
  assert.equal(march.body.to, "2024-03-31");
  assert.equal(march.body.paymentCount, 2);
  assert.equal(march.body.refundedCount, 1);
  const summary = march.body.summary as { totalsByCurrency: { currency: string; amountMinor: number }[]; byService: Record<string, unknown>[] };
  assert.deepEqual(summary.totalsByCurrency, [{ currency: "INR", amountMinor: A.pay.past - A.pay.pastRefund + A.pay.cancelled }], "net of the refund");
  assert.deepEqual(summary.byService, [{ serviceTitle: `Alpha call ${run}`, currency: "INR", amountMinor: A.pay.past - A.pay.pastRefund + A.pay.cancelled, count: 2 }]);
  assert.deepEqual(keys(summary.byService[0]), ["amountMinor", "count", "currency", "serviceTitle"], "no service id");
  assertOnlyOwn(march.body, A, B);

  // The last day counts in full (a payment at 23:30 UTC on the 31st), the day before does not include it.
  const to30 = await ask(routes.earnings, "?from=2024-03-01&to=2024-03-30", A.cookie);
  assert.equal(to30.body.paymentCount, 1);
  assert.deepEqual((to30.body.summary as typeof summary).totalsByCurrency, [{ currency: "INR", amountMinor: A.pay.cancelled }]);
  const oneDay = await ask(routes.earnings, "?from=2024-03-31&to=2024-03-31", A.cookie);
  assert.equal(oneDay.body.paymentCount, 1);
  const none = await ask(routes.earnings, "?from=2024-04-01&to=2024-04-30", A.cookie);
  assert.equal(none.body.paymentCount, 0);
  assert.deepEqual((none.body.summary as typeof summary).totalsByCurrency, []);
  const backwards = await ask(routes.earnings, "?from=2024-03-31&to=2024-03-01", A.cookie);
  assert.equal(backwards.status, 200);
  assert.equal(backwards.body.paymentCount, 0, "an upside-down range is simply empty");

  // The other owner: same month, their own amounts.
  const theirs = await ask(routes.earnings, "?from=2024-03-01&to=2024-03-31", B.cookie);
  assert.equal(theirs.body.paymentCount, 2);
  assert.equal(theirs.body.refundedCount, 0);
  assert.deepEqual((theirs.body.summary as typeof summary).totalsByCurrency, [{ currency: "INR", amountMinor: B.pay.past + B.pay.cancelled }]);
  assertOnlyOwn(theirs.body, B, A);
});

test("D5: missing or invalid dates fall back to the defaults instead of failing", { skip }, async () => {
  const defaults = await ask(routes.earnings, "", A.cookie);
  for (const odd of ["?from=abc&to=xyz", "?from=2026-02-31", "?from=2024-13-01&to=2024-00-10", "?from=2024-3-1", "?to=", "?from=&to=", "?from=2024-03-01T00:00:00Z", "?from=%00"]) {
    const out = await ask(routes.earnings, odd, A.cookie);
    assert.equal(out.status, 200, odd);
    const wanted = (name: "from" | "to") => (new URLSearchParams(odd.slice(1)).get(name) === "2024-03-01" ? "2024-03-01" : defaults.body[name]);
    assert.equal(out.body.from, wanted("from"), `from for ${odd}`);
    assert.equal(out.body.to, defaults.body.to, `to for ${odd}`);
  }
  // One valid end and one invalid: the valid one is kept.
  const half = await ask(routes.earnings, "?from=2024-03-01&to=nope", A.cookie);
  assert.equal(half.body.from, "2024-03-01");
  assert.equal(half.body.to, defaults.body.to);
});

test("D5: loadEarningsView fills in this month from the clock it is given", { skip }, async () => {
  const { loadEarningsView } = await import("../lib/views/dashboard-earnings");
  const view = await loadEarningsView(A.influencerId, {}, new Date("2031-05-20T08:00:00.000Z"));
  assert.equal(view.from, "2031-05-01");
  assert.equal(view.to, "2031-05-20");
  assert.equal(view.paymentCount, 0);
  // A month that starts at midnight UTC: the first of the month is both ends.
  const first = await loadEarningsView(A.influencerId, {}, new Date("2031-06-01T00:00:00.000Z"));
  assert.equal(first.from, "2031-06-01");
  assert.equal(first.to, "2031-06-01");
});
