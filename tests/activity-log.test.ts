// WP-C, the influencer account activity log (doc/13-product-build-plan.md). Two parts:
//
//   1. no database: the wording (summariseActivity), the detail allowlist, the device summary, the page parser, and recordActivity
//      against stand-in databases (it must never throw, never wait longer than its timeout, and store only what is allowed);
//   2. with DATABASE_URL, TOKEN_ENCRYPTION_KEY and APP_SECRET (skipped otherwise): the two endpoints (401/403/404, ownership, exact key
//      set, assertNoSecretKeys, paging limits), the route handlers that write entries (sign-in, failed sign-in, refund with Razorpay
//      injected, customer erasure, payout details, service price, log out everywhere) and the retention sweep.
//
// Only `next/headers` is replaced (the cookie a request carries is chosen per call). No test calls Razorpay, Google or Meta.
import "dotenv/config";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, mock, test } from "node:test";
import { ACTIVITY_ACTIONS, ACTIVITY_DETAIL_KEYS, describeDevice, isActivityAction, sanitiseActivityDetail, summariseActivity, type ActivityAction } from "../lib/activity-actions";
import { ACTIVITY_WRITE_TIMEOUT_MS, recordActivity } from "../lib/activity";
import { hashPassword } from "../lib/auth/password";
import { hashToken, randomToken } from "../lib/auth/tokens";
import { prisma } from "../lib/db";
import { ACTIVITY_MAX_PAGE, ACTIVITY_PAGE_SIZE, parseActivityPage } from "../lib/views/dashboard-activity";
import { assertNoSecretKeys } from "./helpers/assert-no-secret-keys";

const skip = process.env.DATABASE_URL && process.env.TOKEN_ENCRYPTION_KEY && process.env.APP_SECRET ? false : "DATABASE_URL / TOKEN_ENCRYPTION_KEY / APP_SECRET not set";
const run = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
const PASSWORD = "a long passphrase for the activity test";
const ADMIN_PASSWORD = "correct-horse-battery-9";
const CHROME_WINDOWS = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const keys = (o: unknown) => Object.keys(o as object).sort();

/** Runs `fn` with console.warn collected: a failed log write leaves exactly one JSON warning line (the cause, no input). */
async function warnings(fn: () => Promise<void>): Promise<{ where?: string; action?: string; level?: string; message?: string }[]> {
  const real = console.warn;
  const lines: string[] = [];
  console.warn = (line: unknown) => void lines.push(String(line));
  try {
    await fn();
  } finally {
    console.warn = real;
  }
  return lines.map((l) => JSON.parse(l));
}

/* ------------------------------------------------------------------------------------------------------------------------------- */
/* 1. No database                                                                                                                  */
/* ------------------------------------------------------------------------------------------------------------------------------- */

const SAMPLE_DETAIL: Record<ActivityAction, Record<string, string | number | boolean | null>> = {
  "auth.registered": {},
  "auth.login": {},
  "auth.login_failed": {},
  "auth.email_verified": {},
  "auth.password_changed": {},
  "auth.password_reset": {},
  "auth.logout_all": { sessions: 3 },
  "auth.session_revoked": {},
  "auth.reauthenticated": {},
  "auth.admin_reset_link": {},
  "profile.updated": { fields: "name,slug", slugFrom: "old-page", slugTo: "new-page" },
  "service.created": { serviceId: "svc1", title: "Career call", priceTo: 150000, currency: "INR", activeTo: true },
  "service.updated": { serviceId: "svc1", title: "Career call", priceFrom: 100000, priceTo: 120000, currency: "INR", activeFrom: true, activeTo: false },
  "availability.changed": { change: "day-blocked" },
  "booking.cancelled": { bookingId: "bk1" },
  "booking.rescheduled": { bookingId: "bk1" },
  "booking.request_approved": { bookingId: "bk1" },
  "booking.request_declined": { bookingId: "bk1" },
  "booking.refunded": { bookingId: "bk1", amountMinor: 50000, currency: "INR", status: "processed" },
  "customers.erased": { erased: 2, blocked: 1 },
  "payout_account.updated": { method: "BANK", destination: "XXXXXXXX9012" },
  "google.connected": { account: "pat@gmail.example" },
  "google.disconnected": { account: "pat@gmail.example" },
  "google.client_saved": { client: "…wxyz", replaced: true },
  "google.client_removed": { client: "…wxyz" },
  "whatsapp.connected": { phone: "+91 98765 43210" },
  "whatsapp.disconnected": { phone: "+91 98765 43210" },
  "whatsapp_web.consent": { version: "wa-web-2026-11-2" },
  "whatsapp_web.linked": { phone: "+91 ••••••• 210" },
  "whatsapp_web.disconnected": { phone: "+91 ••••••• 210", reason: "influencer" },
  "whatsapp_web.suspended": { code: "send-failures" },
  "onboarding.completed": {},
  "earnings.exported": { from: "2026-01-01", to: "2026-01-31", rows: 12 },
};

test("every action has a label, a detail allowlist and a sample, and the wording of every action contains no '@' except the influencer's own Google account", () => {
  const actions = Object.keys(ACTIVITY_ACTIONS) as ActivityAction[];
  assert.ok(actions.length >= 20 && actions.length <= 40, `a few dozen actions, got ${actions.length}`); // upper bound raised 30 -> 40 with doc/15 (Google client, admin reset-link and WhatsApp QR entries)
  assert.deepEqual(Object.keys(ACTIVITY_DETAIL_KEYS).sort(), [...actions].sort());
  assert.deepEqual(Object.keys(SAMPLE_DETAIL).sort(), [...actions].sort());
  for (const action of actions) {
    assert.ok(isActivityAction(action));
    const text = summariseActivity(action, SAMPLE_DETAIL[action]);
    assert.ok(text.length > 0 && text.length < 200, `${action}: ${text}`);
    if (action === "google.connected" || action === "google.disconnected") assert.match(text, /pat@gmail\.example/, "the influencer's own Google account is the point of the entry");
    else assert.ok(!text.includes("@"), `${action} must not contain an e-mail address: ${text}`);
    assert.doesNotMatch(text, /X{4,}9012|123456789012/, `${action} shows at most the last four digits`);
    // Detail that is not on the action's allowlist never appears, even when the call site passes it.
    const hostile = summariseActivity(action, { ...SAMPLE_DETAIL[action], customerEmail: "asha@example.com", customerName: "Asha Seed", customerPhone: "+919999999999" });
    assert.ok(!hostile.includes("asha@example.com") && !hostile.includes("Asha Seed") && !hostile.includes("+919999999999"), `${action} leaks free detail`);
  }
  assert.equal(summariseActivity("auth.login"), "Signed in");
  assert.equal(summariseActivity("auth.login_failed"), "Failed sign-in");
  assert.equal(summariseActivity("not.an.action", { x: 1 }), "Account activity", "an unknown action (a row from another release) shows a neutral line");
});

test("wording: the plan's acceptance sentences", () => {
  assert.equal(summariseActivity("service.updated", { title: "Career call", priceFrom: 100000, priceTo: 120000, currency: "INR" }), "Service updated (Career call): price 1,000 → 1,200 INR");
  assert.equal(summariseActivity("service.updated", { title: "Career call", activeFrom: true, activeTo: false }), "Service updated (Career call): now hidden from your page");
  assert.equal(summariseActivity("payout_account.updated", { method: "BANK", destination: "XXXXXXXX9012" }), "Payout details changed (bank account ending 9012), sent for review");
  assert.equal(summariseActivity("payout_account.updated", { method: "UPI", destination: "ab***@okaxis" }), "Payout details changed (UPI ID), sent for review");
  assert.equal(summariseActivity("booking.refunded", { amountMinor: 50000, currency: "INR", status: "processed" }), "Refund issued: 500 INR (processed)");
  assert.equal(summariseActivity("customers.erased", { erased: 1, blocked: 0 }), "Customer data erased: 1 booking erased");
  assert.equal(summariseActivity("customers.erased", { erased: 2, blocked: 1 }), "Customer data erased: 2 bookings erased, 1 upcoming kept");
  assert.equal(summariseActivity("profile.updated", { fields: "name,slug", slugFrom: "a", slugTo: "b" }), "Profile updated: name (page address /a → /b)");
  assert.equal(summariseActivity("auth.logout_all", { sessions: 1 }), "Signed out everywhere (1 device)");
});

test("sanitiseActivityDetail keeps only allowlisted keys with plain values and cuts long strings", () => {
  assert.equal(sanitiseActivityDetail("auth.login", { anything: "x" }), undefined, "an action with no detail keys stores none");
  assert.equal(sanitiseActivityDetail("auth.login", undefined), undefined);
  assert.equal(sanitiseActivityDetail("auth.login", [1, 2]), undefined);
  assert.deepEqual(sanitiseActivityDetail("customers.erased", { erased: 1, blocked: 0, email: "asha@example.com", customerName: "Asha" }), { erased: 1, blocked: 0 });
  assert.deepEqual(sanitiseActivityDetail("booking.refunded", { bookingId: "bk1", amountMinor: Number.NaN, currency: "INR", status: { nested: true } }), { bookingId: "bk1", currency: "INR" });
  const long = sanitiseActivityDetail("service.created", { title: `A${"b".repeat(500)}\u0000\n` });
  assert.equal((long?.title as string).length, 120);
  assert.ok(!/[\u0000-\u001f]/.test(long?.title as string));
  assert.deepEqual(sanitiseActivityDetail("google.connected", { account: null }), { account: null });
});

test("describeDevice names the browser and system and never returns the raw header", () => {
  assert.equal(describeDevice(CHROME_WINDOWS), "Chrome on Windows");
  assert.equal(describeDevice("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0"), "Edge on Windows");
  assert.equal(describeDevice("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1"), "Safari on iOS");
  assert.equal(describeDevice("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Gecko/20100101 Firefox/121.0"), "Firefox on macOS");
  assert.equal(describeDevice("Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36"), "Chrome on Android");
  assert.equal(describeDevice("curl/8.4.0"), "Unknown device");
  assert.equal(describeDevice(""), null);
  assert.equal(describeDevice(null), null);
});

test("parseActivityPage accepts 1 to 400 only", () => {
  assert.equal(ACTIVITY_PAGE_SIZE, 25);
  assert.equal(ACTIVITY_MAX_PAGE, 400);
  for (const [input, expected] of [["1", 1], ["2", 2], ["400", 400], ["401", 1], ["0", 1], ["-1", 1], ["2.5", 1], ["abc", 1], ["1e9", 1], ["99999", 1], ["", 1], [null, 1], [undefined, 1], [" 3", 1]] as const) {
    assert.equal(parseActivityPage(input), expected, String(input));
  }
});

test("recordActivity never throws: a failing, rejecting or unknown-action insert leaves one warning line and is swallowed", async () => {
  const logged = await warnings(async () => {
    await recordActivity({ influencerId: "inf1", action: "auth.login" }, { influencerActivity: { create: (() => { throw new Error("sync boom"); }) as never } });
    await recordActivity({ influencerId: "inf1", action: "auth.login" }, { influencerActivity: { create: (() => Promise.reject(new Error("async boom"))) as never } });
    await recordActivity({ influencerId: "inf1", action: "not.an.action" as ActivityAction }, { influencerActivity: { create: (async () => ({})) as never } });
  });
  assert.equal(logged.length, 3);
  assert.ok(logged.every((c) => c.where === "activity-log" && c.level === "warn"));
  assert.deepEqual(logged.map((c) => c.message), ["sync boom", "async boom", "unknown activity action not.an.action"]);
  assert.equal(logged[0].action, "auth.login");
});

test("recordActivity stops waiting after its timeout (a saturated pool cannot slow an action down)", async () => {
  const started = Date.now();
  const logged = await warnings(() => recordActivity({ influencerId: "inf1", action: "auth.login" }, { influencerActivity: { create: (() => new Promise(() => {})) as never } }));
  const took = Date.now() - started;
  assert.ok(took >= ACTIVITY_WRITE_TIMEOUT_MS - 50 && took < ACTIVITY_WRITE_TIMEOUT_MS + 1500, `waited ${took} ms`);
  assert.equal(logged.length, 1);
});

test("recordActivity stores the allowlisted detail, the client IP and a cut user agent, and nothing else", async () => {
  const written: { data: Record<string, unknown> }[] = [];
  const db = { influencerActivity: { create: (async (args: { data: Record<string, unknown> }) => (written.push(args), { id: "x" })) as never } };
  const req = new Request("http://localhost/api/x", { headers: { "x-forwarded-for": "198.51.100.4", "user-agent": `${CHROME_WINDOWS} ${"x".repeat(400)}` } });
  await recordActivity(
    { influencerId: "inf1", action: "customers.erased", detail: { erased: 1, blocked: 0, email: "asha@example.com" } as never, req, targetType: "customer", targetId: "t".repeat(100) },
    db,
  );
  await recordActivity({ influencerId: "inf1", action: "auth.login", actor: "system" }, db);
  assert.equal(written.length, 2);
  const first = written[0].data;
  assert.deepEqual(first.detail, { erased: 1, blocked: 0 });
  assert.equal(first.ip, "198.51.100.4");
  assert.equal((first.userAgent as string).length, 200);
  assert.equal(first.actor, "influencer");
  assert.equal((first.targetId as string).length, 64);
  assert.ok(!JSON.stringify(first).includes("asha@example.com"));
  assert.equal(written[1].data.ip, null, "no request: no IP");
  assert.equal(written[1].data.userAgent, null);
  assert.equal(written[1].data.actor, "system");
});

test("the login route does not await the failed-login entry (the answer takes the same time whether or not the account exists)", () => {
  const source = readFileSync("app/api/auth/login/route.ts", "utf8");
  assert.match(source, /^\s*recordFailedLogin\(email, req\);/m);
  assert.doesNotMatch(source, /await recordFailedLogin/);
});

/* ------------------------------------------------------------------------------------------------------------------------------- */
/* 2. With the database                                                                                                            */
/* ------------------------------------------------------------------------------------------------------------------------------- */

const jar = new Map<string, string>();
type Handler = (req: Request, ctx?: never) => Promise<Response>;
type AdminHandler = (req: Request, ctx: { params: Promise<{ id: string }> }) => Promise<Response>;
let routes: {
  activity: Handler;
  adminActivity: AdminHandler;
  login: Handler;
  refund: (req: Request, ctx: { params: Promise<{ id: string }> }) => Promise<Response>;
  erase: Handler;
  payout: Handler;
  services: Handler;
  servicesPatch: Handler;
  logoutAll: Handler;
  profile: Handler;
  googleDisconnect: Handler;
  earningsExport: Handler;
  bookingAction: (req: Request, ctx: { params: Promise<{ id: string }> }) => Promise<Response>;
};
let authLib: typeof import("../lib/auth/session");
let adminSessionLib: typeof import("../lib/admin/session");

interface Owner {
  label: "Alpha" | "Bravo";
  userId: string;
  influencerId: string;
  cookie: string;
  email: string;
  slug: string;
}
const A: Owner = { label: "Alpha", userId: "", influencerId: "", cookie: "", email: `act-alpha-${run}@example.com`, slug: `act-a-${run}` };
const B: Owner = { label: "Bravo", userId: "", influencerId: "", cookie: "", email: `act-bravo-${run}@example.com`, slug: `act-b-${run}` };
const adminEmail = `act-admin-${run}@example.com`;
const adminMfaEmail = `act-admin-mfa-${run}@example.com`;
let adminId = "";
let adminMfaId = "";
const customerEmail = `act-customer-${run}@example.com`;
const customerName = `Actcustomer Person ${run}`;
let refundBookingId = "";
let providerPaymentId = "";
/** What the injected Razorpay does: answer, or time out (an unclear outcome). */
let razorpay = "ok" as "ok" | "timeout";
/** What the injected calendar step of lib/manage does for the booking route. */
let calendar = "ok" as "ok" | "rejected" | "warning";

const ENV_KEYS = ["ADMIN_REQUIRE_2FA", "RATE_LIMIT_STORE"] as const;
const savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};
let envSaved = false;
let emailSenderSet = false;

async function call(handler: (req: Request, ctx?: never) => Promise<Response>, init: { cookie?: string; method?: string; query?: string; body?: unknown; headers?: Record<string, string> } = {}) {
  jar.clear();
  if (init.cookie !== undefined) jar.set(authLib.sessionCookieName(), init.cookie);
  const res = await handler(
    new Request(`http://localhost/api/x${init.query ?? ""}`, {
      method: init.method ?? "GET",
      headers: { ...(init.body !== undefined ? { "content-type": "application/json" } : {}), ...init.headers },
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    }),
  );
  return { status: res.status, body: (await res.json()) as Record<string, unknown>, headers: res.headers };
}

async function callAdmin(id: string, cookie: string | undefined, query = "") {
  jar.clear();
  if (cookie !== undefined) jar.set(adminSessionLib.adminCookieName(), cookie);
  const res = await routes.adminActivity(new Request(`http://localhost/api/admin/influencers/${id}/activity${query}`), { params: Promise.resolve({ id }) });
  return { status: res.status, body: (await res.json()) as Record<string, unknown>, headers: res.headers };
}

async function waitFor<T>(read: () => Promise<T | null | undefined | false>, ms = 10_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const found = await read();
    if (found) return found;
    if (Date.now() > end) throw new Error("timed out waiting for the activity row");
    await new Promise((r) => setTimeout(r, 150));
  }
}

const rowsOf = (influencerId: string, action?: string) => prisma.influencerActivity.findMany({ where: { influencerId, ...(action ? { action } : {}) }, orderBy: { createdAt: "asc" } });

before(async () => {
  if (skip) return;
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  envSaved = true;
  process.env.RATE_LIMIT_STORE = "memory";
  delete process.env.REDIS_URL; // nothing here may open a Redis connection
  mock.module("next/headers", {
    namedExports: {
      cookies: async () => ({ get: (name: string) => (jar.has(name) ? { name, value: jar.get(name) } : undefined) }),
      headers: async () => new Headers(),
    },
  });
  // Razorpay is injected: the refund route reaches it only through createRefund.
  const payments = await import("../lib/payments");
  mock.module("@/lib/payments", {
    namedExports: {
      ...payments,
      createRefund: async (input: { providerPaymentId: string; amountMinor: number }) => (razorpay === "timeout" ? Promise.reject(new Error("The operation was aborted due to timeout")) : { id: `rfnd_act_${run}`, payment_id: input.providerPaymentId, amount: input.amountMinor, currency: "INR", status: "processed" }),
      listRefunds: async () => [],
    },
  });
  // The booking route reaches the calendar through lib/manage: reschedule and cancel are replaced, the error classes are the real ones.
  const manage = await import("../lib/manage");
  mock.module("@/lib/manage", {
    namedExports: {
      ...manage,
      rescheduleBooking: async () => {
        if (calendar === "rejected") throw new manage.ManageRejectedError("Google refused the calendar update");
      },
      cancelBooking: async () => ({ refund: null, ...(calendar === "warning" ? { warning: "calendar not updated" } : {}) }),
      autoRefundOnCancel: () => false,
    },
  });
  authLib = await import("../lib/auth/session");
  adminSessionLib = await import("../lib/admin/session");
  const email = await import("../lib/email");
  email.setEmailSender(async () => ({ providerMessageId: null }));
  emailSenderSet = true;
  routes = {
    activity: (await import("../app/api/dashboard/activity/route")).GET as Handler,
    adminActivity: (await import("../app/api/admin/influencers/[id]/activity/route")).GET as AdminHandler,
    login: (await import("../app/api/auth/login/route")).POST as Handler,
    refund: (await import("../app/api/dashboard/bookings/[id]/refund/route")).POST as typeof routes.refund,
    erase: (await import("../app/api/dashboard/customers/erase/route")).POST as Handler,
    payout: (await import("../app/api/dashboard/payout-account/route")).PUT as Handler,
    services: (await import("../app/api/dashboard/services/route")).POST as Handler,
    servicesPatch: (await import("../app/api/dashboard/services/route")).PATCH as Handler,
    logoutAll: (await import("../app/api/auth/logout-all/route")).POST as Handler,
    profile: (await import("../app/api/dashboard/profile/route")).PATCH as Handler,
    googleDisconnect: (await import("../app/api/dashboard/google/route")).DELETE as Handler,
    earningsExport: (await import("../app/api/dashboard/earnings/export/route")).GET as Handler,
    bookingAction: (await import("../app/api/dashboard/bookings/[id]/route")).POST as typeof routes.bookingAction,
  };

  const accounts = await import("../lib/auth/accounts");
  for (const o of [A, B]) {
    const registered = await accounts.registerAccount({ name: `${o.label} Activity ${run}`, email: o.email, password: PASSWORD, slug: o.slug, timezone: "Asia/Kolkata", acceptTerms: true });
    o.userId = registered.userId;
    o.influencerId = (await prisma.user.findUniqueOrThrow({ where: { id: o.userId } })).influencerId;
    o.cookie = await authLib.createSession(o.userId);
    // Verified and onboarded, so the sensitive routes are reachable.
    await prisma.user.update({ where: { id: o.userId }, data: { emailVerifiedAt: new Date() } });
    await prisma.influencer.update({ where: { id: o.influencerId }, data: { onboardedAt: new Date() } });
  }

  // A's fixture for the refund and erase routes: a service, a past session with a captured payment, a booking whose customer will be erased.
  const service = await prisma.service.create({ data: { influencerId: A.influencerId, title: `Alpha call ${run}`, durationMin: 30, priceMinor: 5000 } });
  const start = new Date(Date.now() - 3 * 86_400_000);
  const session = await prisma.session.create({ data: { serviceId: service.id, startTime: start, endTime: new Date(start.getTime() + 30 * 60_000) } });
  const booking = await prisma.booking.create({ data: { sessionId: session.id, status: "COMPLETED", customerName, customerEmail, whatsappE164: "+919876543210", whatsappOptIn: false } });
  refundBookingId = booking.id;
  providerPaymentId = `pay_act_${run}`;
  await prisma.payment.create({ data: { bookingId: booking.id, providerOrderId: `order_act_${run}`, providerPaymentId, amountMinor: 5000, currency: "INR", status: "CAPTURED", reconciledAt: new Date() } });

  // Two administrators: one without two-factor, one with.
  const hash = await hashPassword(ADMIN_PASSWORD);
  adminId = (await prisma.adminUser.create({ data: { email: adminEmail, name: "Activity Admin", passwordHash: hash } })).id;
  adminMfaId = (await prisma.adminUser.create({ data: { email: adminMfaEmail, name: "Activity Admin MFA", passwordHash: hash } })).id;
  const mfa = await import("../lib/admin/mfa");
  const totp = await import("../lib/admin/totp");
  const past = Date.now() - 60_000;
  const secret = (await mfa.startTotpEnrollment(adminMfaId)).secret;
  assert.ok((await mfa.confirmTotpEnrollment(adminMfaId, totp.totpAt(secret, past), null, past)).ok);
});

after(async () => {
  // Every step on its own, so one failure cannot leave the rest behind; the pool is always closed.
  try {
    if (!skip) {
      const step = async (what: string, fn: () => Promise<unknown>) => {
        try {
          await fn();
        } catch (e) {
          console.error(`[activity-log] cleanup step failed (${what}):`, e instanceof Error ? e.message : e);
        }
      };
      const ids = [A.influencerId, B.influencerId].filter(Boolean);
      await step("influencers", () => prisma.influencer.deleteMany({ where: { OR: [{ id: { in: ids } }, { slug: { in: [A.slug, B.slug] } }] } }));
      await step("users", () => prisma.user.deleteMany({ where: { email: { in: [A.email, B.email] } } }));
      await step("administrators", () => prisma.adminUser.deleteMany({ where: { email: { in: [adminEmail, adminMfaEmail] } } }));
    }
  } finally {
    if (emailSenderSet) (await import("../lib/email")).setEmailSender(null);
    if (envSaved) {
      for (const k of ENV_KEYS) {
        if (savedEnv[k] === undefined) delete process.env[k];
        else process.env[k] = savedEnv[k];
      }
    }
    await prisma.$disconnect().catch(() => undefined);
  }
});

test("recordActivity with a real database: a good influencer id is stored, an unknown one is swallowed with one warning", { skip }, async () => {
  await recordActivity({ influencerId: A.influencerId, action: "auth.reauthenticated", req: new Request("http://localhost/x", { headers: { "x-forwarded-for": "198.51.100.8", "user-agent": CHROME_WINDOWS } }) });
  const rows = await rowsOf(A.influencerId, "auth.reauthenticated");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].ip, "198.51.100.8");
  assert.equal(rows[0].actor, "influencer");
  const logged = await warnings(() => recordActivity({ influencerId: `no-such-influencer-${run}`, action: "auth.login" }));
  assert.equal(logged.length, 1, "the foreign-key failure was logged once");
  assert.equal(logged[0].where, "activity-log");
  assert.ok(!JSON.stringify(logged).includes("no-such-influencer"), "the log line carries the cause, not the input");
  assert.equal(await prisma.influencerActivity.count({ where: { influencerId: `no-such-influencer-${run}` } }), 0);
  await prisma.influencerActivity.deleteMany({ where: { influencerId: A.influencerId } });
});

test("GET /api/dashboard/activity: 401 without a session, own rows only, exact key set, no secret-looking key, paging", { skip }, async () => {
  assert.equal((await call(routes.activity)).status, 401);
  assert.equal((await call(routes.activity, { cookie: "garbage" })).status, 401);

  // 30 rows for Alpha (two pages), 2 for Bravo whose wording must never show for Alpha.
  const base = Date.now() - 3_600_000;
  await prisma.influencerActivity.createMany({
    data: Array.from({ length: 30 }, (_, i) => ({
      influencerId: A.influencerId,
      action: "service.updated",
      detail: { serviceId: "s", title: `Alpha title ${i}`, priceFrom: 1000, priceTo: 2000 + i, currency: "INR" },
      ip: "203.0.113.1",
      userAgent: CHROME_WINDOWS,
      createdAt: new Date(base + i * 1000),
    })),
  });
  await prisma.influencerActivity.createMany({
    data: [
      { influencerId: B.influencerId, action: "service.updated", detail: { title: `BravoSecretTitle${run}`, priceFrom: 1, priceTo: 2, currency: "INR" }, ip: "203.0.113.99", userAgent: CHROME_WINDOWS },
      { influencerId: B.influencerId, action: "auth.login", actor: "system", ip: "203.0.113.98" },
    ],
  });

  const first = await call(routes.activity, { cookie: A.cookie });
  assert.equal(first.status, 200);
  assert.equal(first.headers.get("cache-control"), "private, no-store");
  assert.deepEqual(keys(first.body), ["page", "pageCount", "rows"]);
  const rows = first.body.rows as Record<string, unknown>[];
  assert.equal(rows.length, 25);
  assert.equal(first.body.page, 1);
  assert.equal(first.body.pageCount, 2);
  for (const r of rows) assert.deepEqual(keys(r), ["action", "actor", "createdAt", "device", "id", "ip", "summary"]);
  assert.equal(rows[0].summary, `Service updated (Alpha title 29): price 10 → 20.29 INR`, "newest first, worded by the server");
  assert.equal(rows[0].actor, "you");
  assert.equal(rows[0].device, "Chrome on Windows");
  assert.equal(rows[0].ip, "203.0.113.1");
  assert.ok(!JSON.stringify(first.body).includes(CHROME_WINDOWS), "the raw user agent is never sent");
  assert.ok(!JSON.stringify(first.body).includes("BravoSecretTitle") && !JSON.stringify(first.body).includes("203.0.113.9"), "nothing of Bravo");
  assert.ok(!JSON.stringify(first.body).includes(A.influencerId) && !JSON.stringify(first.body).includes(A.userId), "no influencer or user id");
  assertNoSecretKeys(first.body);

  const second = await call(routes.activity, { cookie: A.cookie, query: "?page=2" });
  assert.equal((second.body.rows as unknown[]).length, 5);
  assert.equal(second.body.page, 2);

  // Bravo sees exactly Bravo's two rows, one of them by the platform.
  const bravo = await call(routes.activity, { cookie: B.cookie });
  const bravoRows = bravo.body.rows as { summary: string; actor: string }[];
  assert.equal(bravoRows.length, 2);
  assert.deepEqual(bravoRows.map((r) => r.actor).sort(), ["system", "you"]);
  assert.ok(bravoRows.some((r) => r.summary.includes(`BravoSecretTitle${run}`)));
  assert.ok(!JSON.stringify(bravo.body).includes("Alpha title"));
  assertNoSecretKeys(bravo.body);

  // Paging limits: nothing outside 1..400 changes the page; the id is never taken from the URL.
  for (const q of ["?page=0", "?page=-5", "?page=abc", "?page=2.5", "?page=401", "?page=1e9", "?page=99999"]) {
    const r = await call(routes.activity, { cookie: A.cookie, query: q });
    assert.equal(r.status, 200, q);
    assert.equal(r.body.page, 1, q);
    assert.equal((r.body.rows as unknown[]).length, 25, q);
  }
  const last = await call(routes.activity, { cookie: A.cookie, query: "?page=400" });
  assert.equal(last.body.page, 400);
  assert.deepEqual(last.body.rows, [], "a page past the end is empty, not an error");
  assert.ok((last.body.pageCount as number) <= 400);
  const spoof = await call(routes.activity, { cookie: A.cookie, query: `?influencerId=${B.influencerId}&id=${B.influencerId}` });
  assert.ok(!JSON.stringify(spoof.body).includes("BravoSecretTitle"), "a query-string influencer id is ignored");
});

test("GET /api/admin/influencers/:id/activity: 401 signed out, 403 enroll, 403 verify, 404 unknown id, any influencer's rows, exact key set", { skip }, async () => {
  assert.equal((await callAdmin(A.influencerId, undefined)).status, 401);
  assert.equal((await callAdmin(A.influencerId, "garbage")).status, 401);
  // An influencer's own session is not an administrator's.
  assert.equal((await callAdmin(A.influencerId, A.cookie)).status, 401);

  const plain = await adminSessionLib.createAdminSession(adminId);
  const passwordOnly = randomToken();
  await prisma.adminSession.create({ data: { tokenHash: hashToken(passwordOnly), adminId: adminMfaId, expiresAt: new Date(Date.now() + 3_600_000) } });
  const verified = await adminSessionLib.createAdminSession(adminMfaId, {}, { mfaVerified: true });

  process.env.ADMIN_REQUIRE_2FA = "true";
  try {
    const enroll = await callAdmin(A.influencerId, plain);
    assert.equal(enroll.status, 403);
    assert.equal(enroll.body.mfaRequired, true);
    assert.equal(enroll.body.mfaAction, "enroll");
    const verify = await callAdmin(A.influencerId, passwordOnly);
    assert.equal(verify.status, 403);
    assert.equal(verify.body.mfaAction, "verify");
    assert.deepEqual(Object.keys(verify.body).includes("rows"), false);
  } finally {
    delete process.env.ADMIN_REQUIRE_2FA;
  }

  assert.equal((await callAdmin(`no-such-influencer-${run}`, plain)).status, 404);
  assert.equal((await callAdmin("bad id/with slash", plain)).status, 404);
  assert.equal((await callAdmin("x".repeat(100), plain)).status, 404);

  const ok = await callAdmin(A.influencerId, plain);
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get("cache-control"), "private, no-store");
  assert.deepEqual(keys(ok.body), ["page", "pageCount", "rows"]);
  assert.equal((ok.body.rows as unknown[]).length, 25);
  assert.equal(ok.body.pageCount, 2);
  for (const r of ok.body.rows as Record<string, unknown>[]) {
    assert.deepEqual(keys(r), ["action", "actor", "createdAt", "device", "id", "ip", "summary"]);
    assert.equal(r.actor, "influencer");
  }
  assertNoSecretKeys(ok.body);
  assert.ok(!JSON.stringify(ok.body).includes(CHROME_WINDOWS));

  const bravo = await callAdmin(B.influencerId, verified);
  assert.equal(bravo.status, 200);
  const bravoRows = bravo.body.rows as { actor: string; summary: string }[];
  assert.deepEqual(bravoRows.map((r) => r.actor).sort(), ["influencer", "system"]);
  assert.ok(!JSON.stringify(bravo.body).includes("Alpha title"));
  assert.equal(((await callAdmin(A.influencerId, plain, "?page=2")).body.rows as unknown[]).length, 5);
  assert.equal((await callAdmin(A.influencerId, plain, "?page=401")).body.page, 1);
});

test("the sign-in route writes 'Signed in' and 'Failed sign-in'; an unknown e-mail writes nothing; the answers do not change", { skip }, async () => {
  await prisma.influencerActivity.deleteMany({ where: { influencerId: A.influencerId } });
  const headers = { "x-forwarded-for": "203.0.113.77", "user-agent": CHROME_WINDOWS };

  const good = await call(routes.login, { method: "POST", body: { email: A.email, password: PASSWORD }, headers });
  assert.equal(good.status, 200);
  const login = await waitFor(async () => (await rowsOf(A.influencerId, "auth.login"))[0]);
  assert.equal(login.ip, "203.0.113.77");
  assert.equal(login.userAgent, CHROME_WINDOWS);
  assert.equal(login.detail, null);

  const bad = await call(routes.login, { method: "POST", body: { email: A.email, password: "not the password at all" }, headers });
  assert.equal(bad.status, 401);
  assert.equal(bad.body.error, "That email and password do not match.");
  const failed = await waitFor(async () => (await rowsOf(A.influencerId, "auth.login_failed"))[0]);
  assert.equal(failed.ip, "203.0.113.77");
  assert.ok(!JSON.stringify(failed).includes("not the password"), "the tried password is never stored");

  const unknown = await call(routes.login, { method: "POST", body: { email: `nobody-${run}@example.com`, password: "not the password at all" }, headers: { ...headers, "x-forwarded-for": "203.0.113.78" } });
  assert.equal(unknown.status, 401);
  assert.equal(unknown.body.error, bad.body.error, "the same answer for an unknown e-mail");
  await new Promise((r) => setTimeout(r, 1500));
  assert.equal(await prisma.influencerActivity.count({ where: { ip: "203.0.113.78" } }), 0, "an e-mail without an account records nothing");

  // The influencer reads both in Settings, newest first, worded and with the device.
  const mine = await call(routes.activity, { cookie: A.cookie });
  const summaries = (mine.body.rows as { summary: string; device: string; ip: string }[]).map((r) => r.summary);
  assert.deepEqual(summaries.slice(0, 2).sort(), ["Failed sign-in", "Signed in"]);
  assert.equal((mine.body.rows as { device: string }[])[0].device, "Chrome on Windows");
});

test("a service price change is written as 'price 1,000 -> 1,200'", { skip }, async () => {
  const created = await call(routes.services, { method: "POST", cookie: A.cookie, body: { title: `Pricing ${run}`, durationMin: 30, priceMinor: 100000 } });
  assert.equal(created.status, 201);
  const serviceId = created.body.serviceId as string;
  const patched = await call(routes.servicesPatch, { method: "PATCH", cookie: A.cookie, body: { serviceId, priceMinor: 120000 } });
  assert.equal(patched.status, 200);
  const row = await waitFor(async () => (await rowsOf(A.influencerId, "service.updated")).find((r) => (r.detail as { serviceId?: string } | null)?.serviceId === serviceId));
  assert.equal(row.targetType, "service");
  assert.equal(row.targetId, serviceId);
  const mine = await call(routes.activity, { cookie: A.cookie });
  const summaries = (mine.body.rows as { summary: string }[]).map((r) => r.summary);
  assert.ok(summaries.includes(`Service updated (Pricing ${run}): price 1,000 → 1,200 INR`), summaries.slice(0, 4).join(" | "));
  assert.ok(summaries.some((s) => s.startsWith(`Service created (Pricing ${run})`)));
  // A change that is not about the price names no price.
  const rename = await call(routes.servicesPatch, { method: "PATCH", cookie: A.cookie, body: { serviceId, description: "x" } });
  assert.equal(rename.status, 200);
  const rows = await waitFor(async () => {
    const all = (await rowsOf(A.influencerId, "service.updated")).filter((r) => (r.detail as { serviceId?: string } | null)?.serviceId === serviceId);
    return all.length >= 2 ? all : null;
  });
  assert.ok(rows.some((r) => !("priceTo" in (r.detail as object))));
});

test("a refund through the route writes 'Refund issued' with the amount (Razorpay injected)", { skip }, async () => {
  const res = await routes.refund(
    (() => {
      jar.clear();
      jar.set(authLib.sessionCookieName(), A.cookie);
      return new Request("http://localhost/api/x", { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.50" }, body: JSON.stringify({ amountMinor: 2000, reason: "test" }) });
    })(),
    { params: Promise.resolve({ id: refundBookingId }) },
  );
  assert.equal(res.status, 200);
  const row = await waitFor(async () => (await rowsOf(A.influencerId, "booking.refunded"))[0]);
  assert.deepEqual(row.detail, { bookingId: refundBookingId, amountMinor: 2000, currency: "INR", status: "processed" });
  assert.equal(row.targetType, "booking");
  assert.equal(row.targetId, refundBookingId);
  assert.equal(row.ip, "203.0.113.50");
  const text = JSON.stringify(row);
  assert.ok(!text.includes(customerEmail) && !text.includes(customerName) && !text.includes("+919876543210"), "no customer data in the row");
  assert.equal(summariseActivity(row.action, row.detail), "Refund issued: 20 INR (processed)");
  // Bravo cannot refund Alpha's booking and nothing is written for the refusal.
  const before = await prisma.influencerActivity.count({ where: { influencerId: B.influencerId, action: "booking.refunded" } });
  jar.clear();
  jar.set(authLib.sessionCookieName(), B.cookie);
  const denied = await routes.refund(new Request("http://localhost/api/x", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({}) }), { params: Promise.resolve({ id: refundBookingId }) });
  assert.equal(denied.status, 404);
  assert.equal(await prisma.influencerActivity.count({ where: { influencerId: B.influencerId, action: "booking.refunded" } }), before);
});

test("erasing a customer writes only the counts, never the e-mail", { skip }, async () => {
  const res = await call(routes.erase, { method: "POST", cookie: A.cookie, body: { email: customerEmail } });
  assert.equal(res.status, 200);
  const row = await waitFor(async () => (await rowsOf(A.influencerId, "customers.erased"))[0]);
  assert.deepEqual(row.detail, { erased: 1, blocked: 0 });
  const text = JSON.stringify(row);
  assert.ok(!text.includes(customerEmail) && !text.includes(customerEmail.split("@")[0]) && !text.includes(customerName));
  // The page the influencer reads shows it as a sentence without the e-mail.
  const mine = await call(routes.activity, { cookie: A.cookie });
  assert.ok((mine.body.rows as { summary: string }[]).some((r) => r.summary === "Customer data erased: 1 booking erased"));
  assert.ok(!JSON.stringify(mine.body).includes(customerEmail));
  // Nothing found: refused, and no entry.
  const again = await call(routes.erase, { method: "POST", cookie: A.cookie, body: { email: `nobody-${run}@example.com` } });
  assert.equal(again.status, 404);
  assert.equal((await rowsOf(A.influencerId, "customers.erased")).length, 1);
});

test("saving payout details writes the masked destination, never the number that was typed", { skip }, async () => {
  const FULL = "123456789012";
  const res = await call(routes.payout, {
    method: "PUT",
    cookie: A.cookie,
    body: { method: "BANK", accountHolderName: "Alpha Holder", bankName: "HDFC Bank", ifsc: "HDFC0001234", accountNumber: FULL, confirmAccountNumber: FULL },
  });
  assert.equal(res.status, 200);
  const row = await waitFor(async () => (await rowsOf(A.influencerId, "payout_account.updated"))[0]);
  assert.deepEqual(row.detail, { method: "BANK", destination: "XXXXXXXX9012" });
  assert.ok(!JSON.stringify(row).includes(FULL));
  const mine = await call(routes.activity, { cookie: A.cookie });
  const sentence = (mine.body.rows as { summary: string }[]).find((r) => r.summary.startsWith("Payout details changed"))?.summary;
  assert.equal(sentence, "Payout details changed (bank account ending 9012), sent for review");
});

test("sweepOldActivity deletes rows older than 365 days only", { skip }, async () => {
  const { sweepOldActivity, ACTIVITY_RETENTION_DAYS } = await import("../lib/activity-retention");
  assert.equal(ACTIVITY_RETENTION_DAYS, 365);
  const day = 86_400_000;
  const mark = `sweep-${run}`;
  const make = (ageDays: number) => prisma.influencerActivity.create({ data: { influencerId: B.influencerId, action: "auth.login", targetId: mark, createdAt: new Date(Date.now() - ageDays * day) } });
  const old = await make(400);
  const edge = await make(366);
  const recent = await make(364);
  const fresh = await make(1);
  const deleted = await sweepOldActivity();
  assert.ok(deleted >= 2, `deleted ${deleted}`);
  const left = await prisma.influencerActivity.findMany({ where: { targetId: mark }, select: { id: true } });
  assert.deepEqual(left.map((r) => r.id).sort(), [recent.id, fresh.id].sort());
  assert.ok(![old.id, edge.id].some((id) => left.some((r) => r.id === id)));
  // The worker's housekeeping calls it.
  assert.match(readFileSync("lib/auth/sweep.ts", "utf8"), /sweepOldActivity/);
});

test("log out everywhere writes the number of devices, and the entry is still readable by the admin afterwards", { skip }, async () => {
  const res = await call(routes.logoutAll, { method: "POST", cookie: A.cookie, headers: { "x-forwarded-for": "203.0.113.60" } });
  assert.equal(res.status, 200);
  const row = await waitFor(async () => (await rowsOf(A.influencerId, "auth.logout_all"))[0]);
  assert.ok(typeof (row.detail as { sessions: number }).sessions === "number" && (row.detail as { sessions: number }).sessions >= 1);
  assert.equal(row.ip, "203.0.113.60");
  // The influencer's own session is gone (that is what the action does) ...
  assert.equal((await call(routes.activity, { cookie: A.cookie })).status, 401);
  // ... and an administrator still reads the trail.
  const plain = await adminSessionLib.createAdminSession(adminId);
  const seen = await callAdmin(A.influencerId, plain);
  assert.ok((seen.body.rows as { summary: string }[]).some((r) => r.summary.startsWith("Signed out everywhere")));
});

/* ------------------------------------------------------------------------------------------------------------------------------- */
/* 3. Merging repeated low-value entries, security entries never merged (no database: an in-memory stand-in)                       */
/* ------------------------------------------------------------------------------------------------------------------------------- */

interface StubRow {
  id: string;
  influencerId: string;
  action: string;
  actor: string;
  ip: string | null;
  createdAt: Date;
  detail: Record<string, unknown> | null;
}

/** A stand-in for the activity table with the three calls recordActivity may make; `wheres` keeps what it looked for. */
function stubDb(opts: { seed?: StubRow[]; userDelayMs?: number; createDelayMs?: number } = {}) {
  const rows: StubRow[] = [...(opts.seed ?? [])];
  const stats = { finds: 0, updates: 0, creates: 0, wheres: [] as { createdAt: { gte: Date } }[] };
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const db = {
    user: { findUnique: (async () => (await sleep(opts.userDelayMs ?? 0), { influencerId: "inf1" })) as never },
    influencerActivity: {
      create: (async ({ data }: { data: Record<string, unknown> }) => {
        await sleep(opts.createDelayMs ?? 0);
        stats.creates++;
        const detail = data.detail !== null && typeof data.detail === "object" && Object.keys(data.detail as object).length > 0 ? (data.detail as Record<string, unknown>) : null;
        const row: StubRow = { id: `r${rows.length + 1}`, influencerId: data.influencerId as string, action: data.action as string, actor: data.actor as string, ip: (data.ip as string | null) ?? null, createdAt: new Date(), detail };
        rows.push(row);
        return { id: row.id };
      }) as never,
      findFirst: (async ({ where }: { where: { influencerId: string; action: string; actor: string; ip: string | null; createdAt: { gte: Date } } }) => {
        stats.finds++;
        stats.wheres.push(where);
        const hit = rows
          .filter((r) => r.influencerId === where.influencerId && r.action === where.action && r.actor === where.actor && r.ip === where.ip && r.createdAt >= where.createdAt.gte)
          .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
        return hit ? { id: hit.id, detail: hit.detail } : null;
      }) as never,
      update: (async ({ where, data }: { where: { id: string }; data: { detail: Record<string, unknown> } }) => {
        stats.updates++;
        rows.find((r) => r.id === where.id)!.detail = data.detail;
        return { id: where.id };
      }) as never,
    },
  };
  return { db, rows, stats };
}

const reqFrom = (ip: string) => new Request("http://localhost/x", { headers: { "x-forwarded-for": ip, "user-agent": CHROME_WINDOWS } });

test("repeated failed sign-ins from one address inside the window are one row with a count; another address is another row", async () => {
  const { COALESCED_ACTIONS, ACTIVITY_COALESCE_WINDOW_MS } = await import("../lib/activity-actions");
  assert.deepEqual([...COALESCED_ACTIONS].sort(), ["auth.login_failed", "auth.reauthenticated", "availability.changed", "earnings.exported", "profile.updated"]);
  const { db, rows, stats } = stubDb();
  for (let i = 0; i < 3; i++) await recordActivity({ influencerId: "inf1", action: "auth.login_failed", req: reqFrom("198.51.100.1") }, db);
  assert.equal(rows.length, 1);
  assert.equal(stats.updates, 2);
  assert.deepEqual(rows[0].detail, { count: 3 });
  assert.equal(summariseActivity("auth.login_failed", rows[0].detail), "Failed sign-in (3 times)");
  await recordActivity({ influencerId: "inf1", action: "auth.login_failed", req: reqFrom("198.51.100.2") }, db);
  assert.equal(rows.length, 2, "another address is not merged");
  await recordActivity({ influencerId: "inf2", action: "auth.login_failed", req: reqFrom("198.51.100.1") }, db);
  assert.equal(rows.length, 3, "another influencer is not merged");
  // The window is a quarter of an hour back from now.
  const gte = stats.wheres[0].createdAt.gte.getTime();
  assert.ok(ACTIVITY_COALESCE_WINDOW_MS === 15 * 60_000 && Math.abs(gte - (Date.now() - ACTIVITY_COALESCE_WINDOW_MS)) < 5_000);
  // An older row (outside the window) is not merged into.
  const old = stubDb({ seed: [{ id: "old", influencerId: "inf1", action: "auth.login_failed", actor: "influencer", ip: "198.51.100.1", createdAt: new Date(Date.now() - 20 * 60_000), detail: { count: 9 } }] });
  await recordActivity({ influencerId: "inf1", action: "auth.login_failed", req: reqFrom("198.51.100.1") }, old.db);
  assert.equal(old.rows.length, 2);
  assert.equal(old.stats.updates, 0);
});

test("profile saves merge their fields, availability changes merge only when they are the same kind of change", async () => {
  const profile = stubDb();
  const req = reqFrom("198.51.100.3");
  await recordActivity({ influencerId: "inf1", action: "profile.updated", detail: { fields: "bio" }, req }, profile.db);
  await recordActivity({ influencerId: "inf1", action: "profile.updated", detail: { fields: "name,bio" }, req }, profile.db);
  assert.equal(profile.rows.length, 1);
  assert.deepEqual(profile.rows[0].detail, { fields: "bio,name", count: 2 });
  assert.equal(summariseActivity("profile.updated", profile.rows[0].detail), "Profile updated: bio, name (2 times)");

  const avail = stubDb();
  await recordActivity({ influencerId: "inf1", action: "availability.changed", detail: { change: "rule-added" }, req }, avail.db);
  await recordActivity({ influencerId: "inf1", action: "availability.changed", detail: { change: "rule-added" }, req }, avail.db);
  await recordActivity({ influencerId: "inf1", action: "availability.changed", detail: { change: "rule-removed" }, req }, avail.db);
  assert.equal(avail.rows.length, 2);
  assert.equal(summariseActivity("availability.changed", avail.rows[0].detail), "Availability changed: weekly time added (2 times)");
  assert.equal(summariseActivity("availability.changed", avail.rows[1].detail), "Availability changed: weekly time removed");
});

test("security and money entries are never merged or looked up: every repeat is its own row", async () => {
  const never: [ActivityAction, Record<string, string | number | boolean | null>][] = [
    ["auth.login", {}],
    ["auth.registered", {}],
    ["auth.password_changed", {}],
    ["auth.password_reset", {}],
    ["auth.logout_all", { sessions: 2 }],
    ["auth.session_revoked", {}],
    ["payout_account.updated", { method: "BANK", destination: "XXXXXXXX9012" }],
    ["booking.refunded", { bookingId: "b1", amountMinor: 100, currency: "INR", status: "processed" }],
    ["booking.cancelled", { bookingId: "b1" }],
    ["booking.rescheduled", { bookingId: "b1" }],
    ["service.created", { serviceId: "s1", title: "x", priceTo: 1, currency: "INR", activeTo: true }],
    ["service.updated", { serviceId: "s1", title: "x", priceFrom: 1, priceTo: 2, currency: "INR" }],
    ["customers.erased", { erased: 1, blocked: 0 }],
    ["google.connected", { account: "pat@gmail.example" }],
    ["google.disconnected", { account: "pat@gmail.example" }],
    ["whatsapp.connected", { phone: "+91 98765 43210" }],
    ["whatsapp.disconnected", { phone: "+91 98765 43210" }],
    ["onboarding.completed", {}],
  ];
  for (const [action, detail] of never) {
    const { db, rows, stats } = stubDb();
    for (let i = 0; i < 3; i++) await recordActivity({ influencerId: "inf1", action, detail, req: reqFrom("198.51.100.9") }, db);
    assert.equal(rows.length, 3, `${action} repeated three times is three rows`);
    assert.equal(stats.finds + stats.updates, 0, `${action} is never looked up or updated`);
    assert.ok(rows.every((r) => !("count" in (r.detail ?? {}))), `${action} carries no count`);
  }
});

test("recordActivityForUser waits one 2 s deadline for the lookup and the insert together", async () => {
  const { recordActivityForUser } = await import("../lib/activity");
  const slow = stubDb({ userDelayMs: 1500, createDelayMs: 1500 });
  const started = Date.now();
  const logged = await warnings(() => recordActivityForUser("u1", { action: "auth.registered" }, slow.db as never));
  const took = Date.now() - started;
  assert.ok(took < ACTIVITY_WRITE_TIMEOUT_MS + 700, `waited ${took} ms (one deadline, not two)`);
  assert.equal(logged.length, 1);
  const fast = stubDb();
  await recordActivityForUser("u1", { action: "auth.registered" }, fast.db as never);
  assert.equal(fast.rows.length, 1);
  assert.equal(fast.rows[0].influencerId, "inf1");
});

test("wording: a booking change names a calendar left behind, an unconfirmed refund is not 'issued', profile fields are named", () => {
  assert.equal(summariseActivity("booking.rescheduled", { bookingId: "b", calendar: "not-updated" }), "Booking rescheduled (Google Calendar was not updated)");
  assert.equal(summariseActivity("booking.cancelled", { bookingId: "b", calendar: "not-updated" }), "Booking cancelled (Google Calendar was not updated)");
  assert.equal(summariseActivity("booking.cancelled", { bookingId: "b" }), "Booking cancelled");
  assert.equal(summariseActivity("booking.refunded", { bookingId: "b", currency: "INR", status: "unconfirmed" }), "Refund requested (not confirmed yet)");
  assert.equal(summariseActivity("booking.refunded", { bookingId: "b", currency: "INR", amountMinor: 20000, status: "unconfirmed" }), "Refund requested: 200 INR (not confirmed yet)");
  assert.equal(summariseActivity("profile.updated", { fields: "photoUrl,timezone,notifyByEmail" }), "Profile updated: photo, time zone, e-mail alerts");
  assert.equal(summariseActivity("profile.updated", { fields: "slug", slugFrom: "a", slugTo: "b" }), "Profile updated (page address /a → /b)");
  assert.equal(summariseActivity("auth.login_failed", { count: 1 }), "Failed sign-in", "a count of one says nothing");
  assert.equal(summariseActivity("auth.login", { count: 5 }), "Signed in", "a count on an action that is never merged is ignored");
  assert.ok(readFileSync("web/src/components/app/SettingsForms.tsx", "utf8").includes('"sa:activity-changed"'));
  assert.ok(readFileSync("web/src/components/app/ApiProvider.tsx", "utf8").includes('"sa:activity-changed"'));
  assert.ok(readFileSync("web/src/components/app/AccountActivityPanel.tsx", "utf8").includes('ACTIVITY_CHANGED_EVENT = "sa:activity-changed"'));
});

/* ------------------------------------------------------------------------------------------------------------------------------- */
/* 4. With the database: merging, the action filter, and the routes the review named                                               */
/* ------------------------------------------------------------------------------------------------------------------------------- */

test("a loop of failed sign-ins is one row with a count; the action filter reaches an old payout entry however many newer rows exist", { skip }, async () => {
  // Real merging through the database: three failures from one address are one row.
  const req = reqFrom("203.0.113.111");
  for (let i = 0; i < 3; i++) await recordActivity({ influencerId: B.influencerId, action: "auth.login_failed", req });
  const failed = await rowsOf(B.influencerId, "auth.login_failed");
  assert.equal(failed.length, 1);
  assert.deepEqual(failed[0].detail, { count: 3 });

  // 30 newer low-value rows push a payout entry from two days ago past the first page.
  const old = new Date(Date.now() - 2 * 86_400_000);
  await prisma.influencerActivity.create({ data: { influencerId: B.influencerId, action: "payout_account.updated", detail: { method: "BANK", destination: "XXXXXXXX4321" }, createdAt: old } });
  await prisma.influencerActivity.createMany({
    data: Array.from({ length: 30 }, (_, i) => ({ influencerId: B.influencerId, action: "profile.updated", detail: { fields: "bio" }, createdAt: new Date(Date.now() - i * 1000) })),
  });
  const bravo = await authLib.createSession(B.userId);
  const all = await call(routes.activity, { cookie: bravo });
  assert.ok((all.body.pageCount as number) >= 2);
  assert.ok(!(all.body.rows as { action: string }[]).some((r) => r.action === "payout_account.updated"), "the payout entry is not on the first page of the full log");
  assert.equal((all.body.rows as { summary: string }[]).filter((r) => r.summary === "Failed sign-in (3 times)").length, 1);

  const filtered = await call(routes.activity, { cookie: bravo, query: "?action=payout_account.updated" });
  assert.equal(filtered.status, 200);
  assert.deepEqual(keys(filtered.body), ["page", "pageCount", "rows"]);
  assert.equal(filtered.body.pageCount, 1, "the page count applies to the narrowed list");
  const rows = filtered.body.rows as { action: string; summary: string }[];
  assert.equal(rows.length, 1);
  assert.equal(rows[0].summary, "Payout details changed (bank account ending 4321), sent for review");
  assertNoSecretKeys(filtered.body);
  // Anything that is not a known action is ignored (all entries), including look-alikes and injection attempts.
  for (const q of ["?action=nope", "?action=", "?action=payout_account.updated%27%20OR%201=1", "?action=__proto__", "?action=constructor"]) {
    const r = await call(routes.activity, { cookie: bravo, query: q });
    assert.equal(r.status, 200, q);
    assert.equal((r.body.rows as unknown[]).length, 25, q);
  }
  // Another influencer's payout entry never shows in Bravo's filter, and Bravo's never in Alpha's.
  const alphaFiltered = await call(routes.activity, { cookie: await authLib.createSession(A.userId), query: "?action=payout_account.updated" });
  assert.ok(!(alphaFiltered.body.rows as { summary: string }[]).some((r) => r.summary.includes("4321")));

  // The administrator has the same filter, and page 2 of a filter is that filter's page 2.
  const adminCookie = await adminSessionLib.createAdminSession(adminId);
  const adminFiltered = await callAdmin(B.influencerId, adminCookie, "?action=payout_account.updated");
  assert.equal(adminFiltered.status, 200);
  assert.equal((adminFiltered.body.rows as unknown[]).length, 1);
  assert.equal((adminFiltered.body.rows as { actor: string }[])[0].actor, "influencer");
  const adminProfile = await callAdmin(B.influencerId, adminCookie, "?action=profile.updated&page=2");
  assert.equal(adminProfile.body.page, 2);
  assert.equal((adminProfile.body.rows as unknown[]).length, 5, "30 profile rows: 25 on page 1, 5 on page 2 of the filter");
  assert.ok((adminProfile.body.rows as { action: string }[]).every((r) => r.action === "profile.updated"));
  const adminIgnored = await callAdmin(B.influencerId, adminCookie, "?action=nope");
  assert.equal((adminIgnored.body.rows as unknown[]).length, 25);
  assert.equal((await callAdmin(B.influencerId, undefined, "?action=payout_account.updated")).status, 401);
});

test("a reschedule that Google refused is still recorded, and says the calendar was not updated (the answer stays 502)", { skip }, async () => {
  const cookie = await authLib.createSession(A.userId);
  const ask = async (body: unknown) => {
    jar.clear();
    jar.set(authLib.sessionCookieName(), cookie);
    const res = await routes.bookingAction(
      new Request("http://localhost/api/x", { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.120" }, body: JSON.stringify(body) }),
      { params: Promise.resolve({ id: refundBookingId }) },
    );
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };
  const startTime = new Date(Date.now() + 5 * 86_400_000).toISOString();
  await prisma.influencerActivity.deleteMany({ where: { influencerId: A.influencerId, action: { in: ["booking.rescheduled", "booking.cancelled"] } } });

  calendar = "rejected";
  try {
    const refused = await ask({ action: "reschedule", startTime });
    assert.equal(refused.status, 502);
    const row = await waitFor(async () => (await rowsOf(A.influencerId, "booking.rescheduled"))[0]);
    assert.deepEqual(row.detail, { bookingId: refundBookingId, calendar: "not-updated" });
    assert.equal(summariseActivity(row.action, row.detail), "Booking rescheduled (Google Calendar was not updated)");

    calendar = "ok";
    const fine = await ask({ action: "reschedule", startTime });
    assert.equal(fine.status, 200);
    const rows = await waitFor(async () => {
      const all = await rowsOf(A.influencerId, "booking.rescheduled");
      return all.length >= 2 ? all : null;
    });
    assert.deepEqual(rows[1].detail, { bookingId: refundBookingId }, "a clean reschedule carries no calendar note");

    calendar = "warning";
    const cancelled = await ask({ action: "cancel" });
    assert.equal(cancelled.status, 200);
    const cancelRow = await waitFor(async () => (await rowsOf(A.influencerId, "booking.cancelled"))[0]);
    assert.deepEqual(cancelRow.detail, { bookingId: refundBookingId, calendar: "not-updated" });
  } finally {
    calendar = "ok";
  }
});

test("a refund whose Razorpay answer is lost is logged as requested, not issued, with no amount when none was asked for", { skip }, async () => {
  const cookie = await authLib.createSession(A.userId);
  await prisma.influencerActivity.deleteMany({ where: { influencerId: A.influencerId, action: "booking.refunded" } });
  razorpay = "timeout";
  try {
    jar.clear();
    jar.set(authLib.sessionCookieName(), cookie);
    const res = await routes.refund(
      new Request("http://localhost/api/x", { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.130" }, body: JSON.stringify({}) }),
      { params: Promise.resolve({ id: refundBookingId }) },
    );
    assert.equal(res.status, 202);
    const row = await waitFor(async () => (await rowsOf(A.influencerId, "booking.refunded"))[0]);
    assert.deepEqual(row.detail, { bookingId: refundBookingId, currency: "INR", status: "unconfirmed" });
    assert.equal(summariseActivity(row.action, row.detail), "Refund requested (not confirmed yet)");
  } finally {
    razorpay = "ok";
  }
});

test("a profile save logs only the fields that changed, nothing when nothing changed, and repeats merge", { skip }, async () => {
  const cookie = await authLib.createSession(A.userId);
  await prisma.influencerActivity.deleteMany({ where: { influencerId: A.influencerId, action: "profile.updated" } });
  const headers = { "x-forwarded-for": "203.0.113.140" };
  // The Profile form sends all four fields every time; none differs from what is stored.
  const same = await call(routes.profile, { method: "PATCH", cookie, headers, body: { name: `Alpha Activity ${run}`, bio: null, photoUrl: null, timezone: "Asia/Kolkata" } });
  assert.equal(same.status, 200);
  await new Promise((r) => setTimeout(r, 300));
  assert.equal((await rowsOf(A.influencerId, "profile.updated")).length, 0, "nothing changed: no entry");

  const changed = await call(routes.profile, { method: "PATCH", cookie, headers, body: { name: `Alpha Activity ${run}`, bio: "Hello there", photoUrl: null, timezone: "Asia/Kolkata" } });
  assert.equal(changed.status, 200);
  const row = await waitFor(async () => (await rowsOf(A.influencerId, "profile.updated"))[0]);
  assert.deepEqual(row.detail, { fields: "bio" });
  assert.equal(summariseActivity(row.action, row.detail), "Profile updated: bio");

  const again = await call(routes.profile, { method: "PATCH", cookie, headers, body: { bio: "Hello again" } });
  assert.equal(again.status, 200);
  const merged = await waitFor(async () => {
    const all = await rowsOf(A.influencerId, "profile.updated");
    return all.length === 1 && (all[0].detail as { count?: number } | null)?.count === 2 ? all : null;
  });
  assert.equal(summariseActivity(merged[0].action, merged[0].detail), "Profile updated: bio (2 times)");

  const notify = await call(routes.profile, { method: "PATCH", cookie, headers: { "x-forwarded-for": "203.0.113.141" }, body: { notifyByEmail: false } });
  assert.equal(notify.status, 200);
  const rows = await waitFor(async () => {
    const all = await rowsOf(A.influencerId, "profile.updated");
    return all.length === 2 ? all : null;
  });
  assert.ok(rows.some((r) => (r.detail as { fields?: string }).fields === "notifyByEmail"));
  await call(routes.profile, { method: "PATCH", cookie, headers, body: { notifyByEmail: true } });
});

test("disconnecting Google with nothing connected writes no entry", { skip }, async () => {
  const cookie = await authLib.createSession(A.userId);
  await prisma.influencerActivity.deleteMany({ where: { influencerId: A.influencerId, action: "google.disconnected" } });
  const res = await call(routes.googleDisconnect, { method: "DELETE", cookie, headers: { "x-forwarded-for": "203.0.113.150" } });
  assert.equal(res.status, 200);
  await new Promise((r) => setTimeout(r, 300));
  assert.equal((await rowsOf(A.influencerId, "google.disconnected")).length, 0);
});

test("the earnings export is logged for a same-site GET only (not HEAD, not a link from another site)", { skip }, async () => {
  const cookie = await authLib.createSession(A.userId);
  await prisma.influencerActivity.deleteMany({ where: { influencerId: A.influencerId, action: "earnings.exported" } });
  const fetchExport = async (method: string, extra: Record<string, string>) => {
    jar.clear();
    jar.set(authLib.sessionCookieName(), cookie);
    const res = await routes.earningsExport(new Request("http://localhost/api/dashboard/earnings/export?from=2024-01-01&to=2024-12-31", { method, headers: { "x-forwarded-for": "203.0.113.160", ...extra } }));
    await res.text();
    return res.status;
  };
  assert.equal(await fetchExport("HEAD", { "sec-fetch-site": "same-origin" }), 200);
  assert.equal(await fetchExport("GET", { "sec-fetch-site": "cross-site" }), 200, "the file is still served");
  assert.equal(await fetchExport("GET", { origin: "http://evil.example" }), 200);
  await new Promise((r) => setTimeout(r, 300));
  assert.equal((await rowsOf(A.influencerId, "earnings.exported")).length, 0, "no entry for HEAD or a cross-site request");
  assert.equal(await fetchExport("GET", { "sec-fetch-site": "same-origin" }), 200);
  const row = await waitFor(async () => (await rowsOf(A.influencerId, "earnings.exported"))[0]);
  assert.equal((row.detail as { from: string }).from, "2024-01-01");
  assert.equal(await fetchExport("GET", { "sec-fetch-site": "none" }), 200, "a typed address");
  const merged = await waitFor(async () => {
    const all = await rowsOf(A.influencerId, "earnings.exported");
    return all.length === 1 && (all[0].detail as { count?: number }).count === 2 ? all : null;
  });
  assert.match(summariseActivity(merged[0].action, merged[0].detail), /\(2 times\)$/);
});
