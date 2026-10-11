// Branch spa/41-admin-money: the admin Payments, Payouts, Bookings, Health and Audit pages are shared views that BOTH the old Next
// page and the SPA page render, fed by five GET endpoints:
//   M5 GET /api/admin/payments   M6 GET /api/admin/payouts   M7 GET /api/admin/bookings   M8 GET /api/admin/health   M9 GET /api/admin/audit
// The database part (needs DATABASE_URL, TOKEN_ENCRYPTION_KEY, APP_SECRET; skipped otherwise) calls the real route handlers with only
// `next/headers` replaced (the cookies of a request are chosen per call): every endpoint must refuse a signed-out caller (401), an
// admin who still has to enrol (403 enroll) and a password-only session of an admin who has 2FA (403 verify), and answer a fully
// signed-in admin with exactly the hand-picked fields. Every body goes through assertNoSecretKeys. The rest needs no database: the
// views are rendered from fixtures (including a stale worker heartbeat) and the old-page / SPA-page wiring is checked on the sources.
import "dotenv/config";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { after, before, mock, test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { repoPathProblem, specifierProblem } from "../web/vite-server-guard";
import { hashPassword } from "../lib/auth/password";
import { hashToken, randomToken } from "../lib/auth/tokens";
import { prisma } from "../lib/db";
import { BRAND_NAME } from "../lib/brand";
import { jsonify, type Jsonify } from "../lib/jsonify";
import { DEFAULT_THRESHOLDS, type HealthSnapshot } from "../lib/health-eval";
import { QUEUE_NAMES } from "../lib/queue";
import { matchRouteRule } from "../lib/rate-limit/policies";
import { formatTitle, spaRouteById, type SpaRouteId } from "../lib/spa/routes";
import { buildAdminHealthView, scrubHealthText } from "../lib/views/admin-health";
import { parseBookingStatus } from "../lib/views/admin-bookings";
import { parsePaymentView } from "../lib/views/admin-payments";
import { parsePayoutFilter, type AdminPayoutsView } from "../lib/views/admin-payouts";
import { assertNoSecretKeys } from "./helpers/assert-no-secret-keys";
import { fakeNavigate } from "./helpers/fake-navigate";

const skip = process.env.DATABASE_URL && process.env.TOKEN_ENCRYPTION_KEY && process.env.APP_SECRET ? false : "DATABASE_URL / TOKEN_ENCRYPTION_KEY / APP_SECRET not set";
const run = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
const DAY = 86_400_000;
const PASSWORD = "correct-horse-battery-9";
const emailX = `money-x-${run}@example.com`; // administrator with two-factor
const emailY = `money-y-${run}@example.com`; // administrator without; creates the pending payout
const emailZ = `money-z-${run}@example.com`; // a second administrator who can approve it
const auditEmail = `money-audit-${run}@example.com`;
const DETAIL_MARKER = `detail-marker-${run}`;

const root = path.resolve(__dirname, "..");
const read = (rel: string) => readFileSync(path.join(root, rel), "utf8");
const count = (haystack: string, needle: string) => haystack.split(needle).length - 1;
const keys = (o: unknown) => Object.keys(o as object).sort();

const jar = new Map<string, string>();
type Handler = (req: Request) => Promise<Response>;
let routes: { payments: Handler; payouts: Handler; bookings: Handler; health: Handler; audit: Handler };
let sessionLib: typeof import("../lib/admin/session");
let payoutsLib: typeof import("../lib/payouts");
let X = "";
let Y = "";
let Z = "";
let influencerId = "";
let payoutPending = ""; // created by Y, awaiting approval
let payoutPaid = ""; // paid, with a payment refunded since
let payoutCancelled = "";
const savedEnv: Record<string, string | undefined> = {};
let secretValues: string[] = [];

/** A password-only session row for an admin who has two-factor (createAdminSession refuses to make one). */
async function passwordOnlySession(adminId: string): Promise<string> {
  const token = randomToken();
  await prisma.adminSession.create({ data: { tokenHash: hashToken(token), adminId, expiresAt: new Date(Date.now() + 3_600_000) } });
  return token;
}

async function ask(handler: Handler, query = "", cookie?: string): Promise<{ status: number; body: Record<string, unknown>; headers: Headers }> {
  jar.clear();
  if (cookie !== undefined) jar.set(sessionLib.adminCookieName(), cookie);
  const res = await handler(new Request(`http://localhost/api/admin/x${query}`));
  return { status: res.status, body: (await res.json()) as Record<string, unknown>, headers: res.headers };
}

/**
 * Reads pages 1, 2, ... of a list endpoint until `done(rows)` says every row of THIS run has been seen. Other tests and other people
 * share the database and add newer rows all the time, so this run's rows need not be on page 1; and when a row is added between two
 * reads, the one at the end of a page moves to the start of the next, so rows are de-duplicated by id. Returns every page's body
 * and the unique rows. `query` is "" or "?x=y".
 */
async function walk<R extends { id: string }>(handler: Handler, query: string, token: string, done: (rows: R[]) => boolean, maxPages = 15) {
  const bodies: Record<string, unknown>[] = [];
  const byId = new Map<string, R>();
  for (let p = 1; p <= maxPages; p++) {
    const out = await ask(handler, `${query}${query.includes("?") ? "&" : "?"}page=${p}`, token);
    assert.equal(out.status, 200, `${query} page ${p}`);
    bodies.push(out.body);
    for (const r of out.body.rows as R[]) if (!byId.has(r.id)) byId.set(r.id, r);
    if (done([...byId.values()]) || p >= (out.body.pageCount as number)) break;
  }
  return { bodies, rows: [...byId.values()] };
}

const orderId = (kind: string) => `order_${run}_${kind}`;
const customer = (kind: string) => `Money ${kind} ${run}`;

/**
 * Values stored in rows the pages never show them from: encrypted tokens of the influencer's connections, bank details, customer
 * contact data, internal notes. They sit in the same rows the endpoints read (or hang off the same influencer), so a careless
 * `...row` or `include` would put them on the wire. No response may contain any of them.
 */
const hidden: string[] = [DETAIL_MARKER];
const secret = (label: string) => {
  const value = `hidden-${label}-${run}`;
  hidden.push(value);
  return value;
};

/** One payment of every kind the Payments tabs tell apart, a booking of each status the Bookings tabs filter by, and three payouts. */
async function seed() {
  const service = await prisma.service.create({ data: { influencerId, title: `Money call ${run}`, durationMin: 30, priceMinor: 1000 } });
  // The influencer's connections hold encrypted tokens and bank details.
  await prisma.googleToken.create({ data: { influencerId, refreshTokenEnc: secret("google-refresh-enc"), scope: secret("google-scope"), googleEmail: `${secret("google-email")}@example.com` } });
  await prisma.whatsAppConnection.create({
    data: { influencerId, wabaId: secret("waba"), phoneNumberId: secret("phone-number-id"), tokenEnc: secret("whatsapp-token-enc"), registrationPinEnc: secret("whatsapp-pin-enc"), lastError: secret("whatsapp-error") },
  });
  await prisma.payoutAccount.create({
    data: {
      influencerId,
      method: "BANK",
      accountHolderName: secret("holder"),
      bankName: secret("bank"),
      ifsc: secret("ifsc"),
      accountNumberEnc: secret("account-number-enc"),
      accountNumberMasked: secret("account-masked"),
      upiIdEnc: secret("upi-enc"),
      status: "VERIFIED",
      reviewedByEmail: `${secret("reviewer")}@example.com`,
    },
  });
  let n = 0;
  const booking = async (kind: string, status: "SCHEDULED" | "EXPIRED" | "CANCELLED" | "PENDING_PAYMENT" | "COMPLETED" | "FAILED" | "REQUESTED", extra: Record<string, unknown> = {}) => {
    const start = new Date(Date.now() + (3 + n++) * DAY);
    const session = await prisma.session.create({ data: { serviceId: service.id, startTime: start, endTime: new Date(start.getTime() + 30 * 60_000) } });
    return prisma.booking.create({
      data: {
        sessionId: session.id,
        status,
        customerName: customer(kind),
        customerEmail: `${secret(`customer-email-${kind}`)}@example.com`.toLowerCase(),
        whatsappE164: `+91${secret(`phone-${kind}`)}`,
        whatsappOptIn: true,
        meetLink: `https://meet.google.com/${secret(`meet-${kind}`)}`,
        eventId: secret(`event-${kind}`),
        intakeAnswers: [{ id: "q1", label: "Question", answer: secret(`intake-${kind}`) }],
        declineReason: secret(`decline-${kind}`),
        ...extra,
      },
    });
  };
  const payment = (bookingId: string, kind: string, extra: Record<string, unknown> = {}) =>
    prisma.payment.create({
      data: {
        bookingId,
        providerOrderId: orderId(kind),
        providerPaymentId: `pay_${run}_${kind}`,
        amountMinor: 1000,
        currency: "INR",
        status: "CAPTURED",
        failureReason: secret(`failure-${kind}`),
        recoveryError: secret(`recovery-${kind}`),
        reconciledByEmail: `${secret(`reconciler-${kind}`)}@example.com`,
        ...extra,
      },
    });

  await payment((await booking("recon", "SCHEDULED")).id, "recon"); // captured, not reconciled: the "To reconcile" tab
  await payment((await booking("mismatch", "EXPIRED")).id, "mismatch"); // captured, but the booking expired: "No paid booking"
  await payment((await booking("done", "SCHEDULED")).id, "done", { reconciledAt: new Date() });
  const refunded = await payment((await booking("refunded", "CANCELLED")).id, "refunded", { status: "REFUNDED", refundStatus: "processed", refundAmountMinor: 1000, reconciledAt: new Date() });
  await prisma.refund.create({ data: { paymentId: refunded.id, providerRefundId: secret("refund-id-refunded"), amountMinor: 1000, status: "processed" } });
  await payment((await booking("unpaid", "PENDING_PAYMENT", { holdExpiresAt: new Date(Date.now() + DAY) })).id, "unpaid", { status: "CREATED", providerPaymentId: null });
  await payment((await booking("needsrefund", "CANCELLED")).id, "needsrefund", { needsRefund: true });

  const payoutBase = { influencerId, currency: "INR", grossMinor: 1000, refundsMinor: 0, feeBps: 1050, feeMinor: 105, netMinor: 895, paymentCount: 1, destination: "UPI ****1234", createdByEmail: emailY, note: secret("payout-note") };
  payoutPending = (await prisma.payout.create({ data: { ...payoutBase, status: "PENDING" } })).id;
  payoutPaid = (await prisma.payout.create({ data: { ...payoutBase, status: "PAID", reference: `UTR${run}`, paidAt: new Date(), paidByEmail: `${secret("payer")}@example.com`, approvedAt: new Date(), approvedByEmail: emailZ } })).id;
  payoutCancelled = (await prisma.payout.create({ data: { ...payoutBase, status: "CANCELLED" } })).id;
  // A payment in the paid payout that was partly refunded afterwards: money the influencer received that should come back.
  const inPayout = await payment((await booking("inpayout", "COMPLETED")).id, "inpayout", { reconciledAt: new Date(), payoutId: payoutPaid, refundStatus: "processed", refundAmountMinor: 300 });
  await prisma.refund.create({ data: { paymentId: inPayout.id, providerRefundId: secret("refund-id-inpayout"), amountMinor: 300, status: "processed" } });
  // A webhook event the gateway sent (this table keeps only the ids of the events, there is no payload column), and what the administrators hold:
  // X's encrypted authenticator secret, a recovery-code hash, and every password hash. Session token hashes are collected by the exposure test.
  await prisma.webhookEvent.create({ data: { provider: secret("webhook-provider"), eventId: secret("webhook-event"), type: secret("webhook-type") } });
  await prisma.adminRecoveryCode.create({ data: { adminId: X, codeHash: secret("recovery-code-hash") } });
  const adminX = await prisma.adminUser.findUniqueOrThrow({ where: { id: X }, select: { totpSecretEnc: true, passwordHash: true } });
  assert.ok(adminX.totpSecretEnc, "X has an encrypted authenticator secret");
  hidden.push(adminX.totpSecretEnc, adminX.passwordHash);

  await booking("failed", "FAILED", { lastError: "E".repeat(200) });
  await booking("requested", "REQUESTED", { holdExpiresAt: new Date(Date.now() + DAY) });

  // 30 audit entries (more than one page), newest first by their timestamps, each with a free-form `detail` that must never be sent.
  const now = Date.now();
  await prisma.adminAuditLog.createMany({
    data: Array.from({ length: 30 }, (_, i) => ({
      adminEmail: auditEmail,
      action: `test.money.${String(i).padStart(2, "0")}`,
      targetType: "payout",
      targetId: `target-${run}-${i}`,
      detail: { marker: DETAIL_MARKER },
      ip: "203.0.113.7",
      createdAt: new Date(now - i * 1000),
    })),
  });
}

/** Every environment setting these tests depend on is saved here before they change it, and put back by `after`, so the test passes alone and with any .env. */
const ENV_NAMES = ["RATE_LIMIT_STORE", "REDIS_URL", "PAYOUT_FOUR_EYES", "PAYOUT_FOUR_EYES_MIN_MINOR", "ADMIN_REQUIRE_2FA"];
function restoreEnv() {
  for (const [name, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}

before(async () => {
  for (const name of ENV_NAMES) savedEnv[name] = process.env[name];
  if (skip) return;
  process.env.RATE_LIMIT_STORE = "memory";
  // GET /api/admin/health builds the health report, which would open BullMQ/Redis connections that keep the test process alive
  // (and touch the shared Redis). Without REDIS_URL the report degrades exactly as it does in production when Redis is down.
  secretValues = Object.entries(process.env)
    .filter(([name, value]) => /SECRET|PASSWORD|TOKEN|_KEY|PRIVATE|DATABASE_URL|REDIS_URL/.test(name) && (value ?? "").length >= 8)
    .map(([, value]) => value as string);
  delete process.env.REDIS_URL;
  delete process.env.PAYOUT_FOUR_EYES_MIN_MINOR;
  // Both switches default to ON in production, so they are set explicitly: the result does not depend on NODE_ENV or the .env.
  process.env.ADMIN_REQUIRE_2FA = "false";
  process.env.PAYOUT_FOUR_EYES = "true"; // a payout needs a second administrator to approve it
  mock.module("next/headers", {
    namedExports: {
      cookies: async () => ({ get: (name: string) => (jar.has(name) ? { name, value: jar.get(name) } : undefined) }),
      headers: async () => new Headers(),
    },
  });
  sessionLib = await import("../lib/admin/session");
  payoutsLib = await import("../lib/payouts");
  const mfa = await import("../lib/admin/mfa");
  const totp = await import("../lib/admin/totp");
  routes = {
    payments: (await import("../app/api/admin/payments/route")).GET,
    payouts: (await import("../app/api/admin/payouts/route")).GET,
    bookings: (await import("../app/api/admin/bookings/route")).GET,
    health: (await import("../app/api/admin/health/route")).GET,
    audit: (await import("../app/api/admin/audit/route")).GET,
  };

  const accounts = await import("../lib/auth/accounts");
  const registered = await accounts.registerAccount({
    name: `Money Owner ${run}`,
    email: `money-owner-${run}@example.com`,
    password: "a long passphrase for the money test",
    slug: `money-${run}`,
    timezone: "Asia/Kolkata",
    acceptTerms: true,
  });
  influencerId = (await prisma.user.findUniqueOrThrow({ where: { id: registered.userId } })).influencerId;

  const hash = await hashPassword(PASSWORD);
  X = (await prisma.adminUser.create({ data: { email: emailX, name: "Money Admin X", passwordHash: hash } })).id;
  Y = (await prisma.adminUser.create({ data: { email: emailY, name: "Money Admin Y", passwordHash: hash } })).id;
  Z = (await prisma.adminUser.create({ data: { email: emailZ, name: "Money Admin Z", passwordHash: hash } })).id;
  const past = Date.now() - 60_000;
  const secret = (await mfa.startTotpEnrollment(X)).secret;
  assert.ok((await mfa.confirmTotpEnrollment(X, totp.totpAt(secret, past), null, past)).ok);
  await seed();
});

after(async () => {
  try {
    if (!skip) {
      // Each step on its own (and tried twice), so a pool timeout on the slow shared database in one of them never leaves the rows of the
      // others behind. Rows are found by the run's own markers, not by ids a failed `before` may not have stored.
      const slug = `money-${run}`;
      const steps: [string, () => Promise<unknown>][] = [
        // Payouts restrict the influencer's deletion (their payments let go of them: SET NULL).
        ["payouts", () => prisma.payout.deleteMany({ where: { influencer: { slug } } })],
        ["influencer", () => prisma.influencer.deleteMany({ where: { slug } })],
        ["webhook", () => prisma.webhookEvent.deleteMany({ where: { eventId: { contains: run } } })],
        ["audit", () => prisma.adminAuditLog.deleteMany({ where: { OR: [{ adminEmail: { in: [emailX, emailY, emailZ, auditEmail] } }, { targetId: `pay-row-${run}` }] } })],
        ["admins", () => prisma.adminUser.deleteMany({ where: { email: { in: [emailX, emailY, emailZ] } } })],
      ];
      for (const [name, step] of steps) {
        for (let attempt = 1; attempt <= 2; attempt++) {
          try {
            await step();
            break;
          } catch (e) {
            if (attempt === 2) console.error(`[spa-admin-money cleanup] ${name} failed:`, e instanceof Error ? e.message : e);
          }
        }
      }
    }
  } finally {
    restoreEnv();
    await prisma.$disconnect().catch(() => {});
  }
});

/* ---------- the gate: the same one the console pages have ---------- */

const ENDPOINTS: { name: string; handler: () => Handler }[] = [
  { name: "M5 payments", handler: () => routes.payments },
  { name: "M6 payouts", handler: () => routes.payouts },
  { name: "M7 bookings", handler: () => routes.bookings },
  { name: "M8 health", handler: () => routes.health },
  { name: "M9 audit", handler: () => routes.audit },
];

test("every endpoint answers 401 without an administrator session, or with a garbage cookie or an influencer-style one, and sends no data", { skip }, async () => {
  for (const e of ENDPOINTS) {
    for (const cookie of [undefined, "", "not-a-real-admin-session-token"]) {
      const out = await ask(e.handler(), "", cookie);
      assert.equal(out.status, 401, `${e.name} with cookie ${JSON.stringify(cookie)}`);
      assert.deepEqual(keys(out.body), ["error"], `${e.name}: only an error sentence`);
      assert.equal(typeof out.body.error, "string");
    }
  }
});

test("every endpoint: 200 for a signed-in admin, 403 enroll when 2FA is required and not set up, 403 verify for a password-only session of a 2FA admin", { skip }, async () => {
  const plain = await sessionLib.createAdminSession(Y);
  const stale = await passwordOnlySession(X);
  const verified = await sessionLib.createAdminSession(X, {}, { mfaVerified: true });
  const denied = (out: { status: number; body: Record<string, unknown> }, action: "enroll" | "verify", where: string) => {
    assert.equal(out.status, 403, where);
    assert.equal(out.body.mfaRequired, true, where);
    assert.equal(out.body.mfaAction, action, where);
    assert.deepEqual(keys(out.body), ["error", "mfaAction", "mfaRequired"], `${where}: nothing of the console leaks to a denied session`);
  };

  for (const e of ENDPOINTS) {
    // Neither required nor enabled: ok. (A fresh request each time; the health endpoint measures on every call.)
    const ok = await ask(e.handler(), "", plain);
    assert.equal(ok.status, 200, `${e.name}: ok`);
    assert.equal(ok.headers.get("cache-control"), "private, no-store", e.name);
    assert.equal(ok.headers.get("access-control-allow-origin"), null, e.name);
    assertNoSecretKeys(ok.body);

    // An admin with 2FA whose session did not pass it ("verify"), with or without the requirement.
    denied(await ask(e.handler(), "", stale), "verify", `${e.name}: password-only session`);
  }

  process.env.ADMIN_REQUIRE_2FA = "true";
  try {
    for (const e of ENDPOINTS) {
      denied(await ask(e.handler(), "", plain), "enroll", `${e.name}: must enrol`);
      denied(await ask(e.handler(), "", stale), "verify", `${e.name}: password-only session, 2FA required`);
      const ok = await ask(e.handler(), "", verified);
      assert.equal(ok.status, 200, `${e.name}: a session that passed the second factor`);
      assertNoSecretKeys(ok.body);
    }
  } finally {
    process.env.ADMIN_REQUIRE_2FA = "false"; // back to what `before` set
  }
});

test("a disabled administrator's session stops working at once on every endpoint", { skip }, async () => {
  const token = await sessionLib.createAdminSession(Z);
  assert.equal((await ask(routes.audit, "", token)).status, 200);
  await prisma.adminUser.update({ where: { id: Z }, data: { disabledAt: new Date() } });
  try {
    for (const e of ENDPOINTS) assert.equal((await ask(e.handler(), "", token)).status, 401, e.name);
  } finally {
    await prisma.adminUser.update({ where: { id: Z }, data: { disabledAt: null } });
  }
});

/* ---------- M5 payments ---------- */

const PAYMENT_ROW_KEYS = [
  "amountMinor", "booking", "createdAt", "currency", "id", "inPayout", "influencer", "mismatch", "needsRefund", "razorpayId",
  "reconciled", "refundAmountMinor", "refundStatus", "service", "status",
];
type PaymentRow = { id: string; razorpayId: string; status: string; mismatch: boolean; needsRefund: boolean; booking: { status: string; customerName: string }; inPayout: boolean; reconciled: boolean; influencer: { id: string; name: string }; service: { title: string } };
/** The kind a seeded payment was created with ("recon", "done"...): the Razorpay id column holds `pay_<run>_<kind>`, or `order_<run>_<kind>` while there is no payment id. */
const kindOf = (r: { razorpayId: string }) => (r.razorpayId.includes(`_${run}_`) ? r.razorpayId.split(`_${run}_`)[1] : null);

test("M5 GET /api/admin/payments: each tab shows the matching payments, the counts are the tabs', and a row has exactly the hand-picked fields", { skip }, async () => {
  const token = await sessionLib.createAdminSession(Y);
  // `expected` kinds of this run's payments make a tab "done" (see walk: they need not be on page 1 of a busy shared database).
  const kinds = async (view: string, expected: number) => {
    const { bodies, rows } = await walk<PaymentRow>(routes.payments, `?view=${view}`, token, (rs) => rs.filter((r) => kindOf(r) !== null).length >= expected);
    const body = bodies[0];
    assert.deepEqual(keys(body), ["counts", "page", "pageCount", "rows", "total", "view"]);
    assert.deepEqual(keys(body.counts), ["all", "captured", "mismatch", "needsRefund", "unpaid", "unreconciled"]);
    assert.equal(body.view, view);
    for (const b of bodies) {
      assert.ok((b.rows as unknown[]).length <= 25, "one page at a time");
      assertNoSecretKeys(b);
    }
    return { body, bodies, rows, mine: rows.map(kindOf).filter((k): k is string => k !== null).sort() };
  };

  assert.deepEqual((await kinds("all", 7)).mine, ["done", "inpayout", "mismatch", "needsrefund", "recon", "refunded", "unpaid"]);
  assert.deepEqual((await kinds("unreconciled", 3)).mine, ["mismatch", "needsrefund", "recon"], "captured, not reconciled, not in a payout");
  assert.deepEqual((await kinds("captured", 6)).mine, ["done", "inpayout", "mismatch", "needsrefund", "recon", "refunded"], "captured and refunded");
  assert.deepEqual((await kinds("needs-refund", 1)).mine, ["needsrefund"]);
  assert.deepEqual((await kinds("mismatch", 1)).mine, ["mismatch"], "captured while the booking expired");
  assert.deepEqual((await kinds("unpaid", 1)).mine, ["unpaid"]);

  // The fields of a row, and the values worked out on the server.
  const all = await kinds("all", 7);
  const row = (kind: string) => all.rows.find((r) => kindOf(r) === kind)!;
  for (const r of all.rows) assert.deepEqual(keys(r), PAYMENT_ROW_KEYS);
  assert.equal(row("mismatch").mismatch, true);
  for (const k of ["recon", "done", "refunded", "unpaid", "needsrefund", "inpayout"]) assert.equal(row(k).mismatch, false, k);
  assert.equal(row("needsrefund").needsRefund, true);
  assert.equal(row("inpayout").inPayout, true);
  for (const k of ["recon", "done", "refunded", "unpaid", "needsrefund", "mismatch"]) assert.equal(row(k).inPayout, false, k);
  assert.equal(row("done").reconciled, true);
  assert.equal(row("recon").reconciled, false);
  assert.equal(row("recon").razorpayId, `pay_${run}_recon`, "the Razorpay payment id");
  assert.equal(row("unpaid").razorpayId, orderId("unpaid"), "the order id while there is no payment id");
  const text = JSON.stringify(all.bodies);
  assert.ok(!text.includes(payoutPaid) && !text.includes(orderId("recon")), "neither the payout id nor an order id that has a payment id is sent");
  assert.deepEqual(row("recon").booking, { status: "SCHEDULED", customerName: customer("recon") });
  assert.equal(row("recon").service.title, `Money call ${run}`);
  assert.equal(row("recon").influencer.name, `Money Owner ${run}`);
  assert.equal(row("recon").influencer.id, influencerId);
  assert.deepEqual(keys(row("recon").booking), ["customerName", "status"]);
  assert.deepEqual(keys(row("recon").service), ["title"]);
  assert.deepEqual(keys(row("recon").influencer), ["id", "name"]);

  // Counts are the real numbers behind the tabs (the same function the sidebar badge uses).
  const { paymentViewCounts } = await import("../lib/admin/data");
  const counts = all.body.counts as Record<string, number>;
  const truth = await paymentViewCounts();
  for (const [k, v] of Object.entries(truth)) assert.ok(Math.abs(counts[k] - v) <= 25, `count ${k} (${counts[k]} vs ${v}; other tests share the database and add or remove rows between the two reads)`);
  assert.ok(counts.all >= 7 && counts.unreconciled >= 3 && counts.mismatch >= 1 && counts.needsRefund >= 1 && counts.unpaid >= 1);

  // Fallbacks and odd pages.
  for (const odd of ["", "?view=bogus", "?view=ALL", "?view=__proto__", "?view=needs-refund;drop"]) {
    const out = await ask(routes.payments, odd, token);
    assert.equal(out.status, 200, odd);
    assert.equal(out.body.view, "all", odd);
  }
  for (const odd of ["?page=0", "?page=-2", "?page=abc", "?page=1e9", "?page=10000", "?page=99999999999", "?page="]) assert.equal((await ask(routes.payments, odd, token)).body.page, 1, `page ${odd}`);
  const far = await ask(routes.payments, "?page=9999", token);
  assert.equal(far.status, 200);
  assert.deepEqual(far.body.rows, [], "a page past the end is empty, not an error");
});

test("the five GET endpoints fall under the generic admin rate rule (120 a minute); the money actions next to them keep their tight ones", () => {
  // The proxy matches the path only (the query string is not part of it), so one path each is the whole question.
  for (const p of ["payments", "payouts", "bookings", "health", "audit"]) {
    const rule = matchRouteRule("GET", `/api/admin/${p}`);
    assert.equal(rule?.name, "admin", `GET /api/admin/${p}`);
    assert.equal(rule?.limit, 120, `GET /api/admin/${p}: 120 a minute`);
  }
  assert.equal(matchRouteRule("POST", "/api/admin/payouts/abc")?.name, "admin-money", "approve, mark paid and cancel (payouts/[id]) keep the money rule");
  assert.equal(matchRouteRule("POST", "/api/admin/payments/reconcile")?.name, "admin-reconcile");
  assert.equal(matchRouteRule("POST", "/api/admin/payments/abc/unreconcile")?.name, "admin-money");
});

test("payment, payout and booking URL rules: an unknown tab is the default one, never an error", () => {
  for (const v of ["all", "unreconciled", "captured", "needs-refund", "mismatch", "unpaid"]) assert.equal(parsePaymentView(v), v);
  for (const odd of [null, undefined, "", "ALL", "needsRefund", "../x", "__proto__", "captured "]) assert.equal(parsePaymentView(odd), "all", JSON.stringify(odd));
  for (const s of ["PENDING", "PAID", "CANCELLED", "all"]) assert.equal(parsePayoutFilter(s), s);
  for (const odd of [null, undefined, "", "pending", "paid", "FAILED", "__proto__", "ALL"]) assert.equal(parsePayoutFilter(odd), "PENDING", JSON.stringify(odd));
  for (const s of ["all", "REQUESTED", "PENDING_PAYMENT", "PAID", "SCHEDULED", "COMPLETED", "CANCELLED", "FAILED", "EXPIRED"]) assert.equal(parseBookingStatus(s), s);
  for (const odd of [null, undefined, "", "HELD", "paid", "scheduled", "__proto__", "SCHEDULED;x"]) assert.equal(parseBookingStatus(odd), "all", JSON.stringify(odd));
});

/* ---------- M6 payouts ---------- */

const PAYOUT_ROW_KEYS = ["approval", "createdAt", "currency", "destination", "feeMinor", "feePercentText", "grossAfterRefundsMinor", "id", "influencer", "netMinor", "owedMinor", "reference", "status"];
type PayoutRow = Jsonify<AdminPayoutsView>["rows"][number];

test("M6 GET /api/admin/payouts: the tabs and their counts, the destination masked, 'refunded since' on a paid payout, exactly the hand-picked fields", { skip }, async () => {
  const token = await sessionLib.createAdminSession(Y);
  // This run's payouts on a tab: found by walking the pages (see walk: they need not be on page 1 of a busy shared database).
  const onTab = async (query: string, expected: number) => {
    const { bodies, rows } = await walk<PayoutRow>(routes.payouts, query, token, (rs) => rs.filter((r) => r.influencer.id === influencerId).length >= expected);
    for (const b of bodies) {
      assert.ok((b.rows as unknown[]).length <= 25);
      assertNoSecretKeys(b);
    }
    return { body: bodies[0], bodies, rows, mine: rows.filter((r) => r.influencer.id === influencerId) };
  };
  const pending = await onTab("", 1);
  assert.deepEqual(keys(pending.body), ["counts", "onlyOneAdmin", "page", "pageCount", "rows", "status"]);
  assert.deepEqual(keys(pending.body.counts), ["CANCELLED", "PAID", "PENDING", "all"]);
  assert.equal(pending.body.status, "PENDING", "the default tab is 'To send'");
  assert.deepEqual(pending.mine.map((r) => r.id), [payoutPending]);

  const byTab: Record<string, string[]> = { PAID: [payoutPaid], CANCELLED: [payoutCancelled], all: [payoutPending, payoutPaid, payoutCancelled].sort() };
  for (const [tab, ids] of Object.entries(byTab)) {
    const out = await onTab(`?status=${tab}`, ids.length);
    assert.equal(out.body.status, tab);
    assert.deepEqual(out.mine.map((r) => r.id).sort(), ids, tab);
  }
  for (const odd of ["?status=pending", "?status=bogus", "?status=", "?status=__proto__"]) assert.equal((await ask(routes.payouts, odd, token)).body.status, "PENDING", odd);

  const counts = pending.body.counts as Record<string, number>;
  assert.ok(counts.PENDING >= 1 && counts.PAID >= 1 && counts.CANCELLED >= 1);
  assert.ok(Math.abs(counts.all - (counts.PENDING + counts.PAID + counts.CANCELLED)) <= 10, "the All tab counts every status (other tests may add payouts between the reads)");

  const paidTab = await onTab("?status=PAID", 1);
  const paid = paidTab.mine[0];
  assert.deepEqual(keys(paid), PAYOUT_ROW_KEYS);
  assert.deepEqual(keys(paid.influencer), ["id", "name"]);
  assert.deepEqual(keys(paid.approval), ["approved", "approvedByEmail", "canApprove", "canMarkPaid", "createdByViewer", "required"]);
  assert.equal(paid.destination, "UPI ****1234", "the destination is the masked label stored with the payout");
  assert.equal(paid.reference, `UTR${run}`);
  assert.equal(paid.feePercentText, "10.50%");
  assert.equal(paid.grossAfterRefundsMinor, 1000);
  assert.equal(paid.approval.approvedByEmail, null, "the page names an approver only on a payout still to send; the address of another administrator is not sent for a paid one");
  assert.equal(paid.owedMinor, 300, "refunded since it was paid");
  assert.equal(paid.netMinor, 895);
  const text = JSON.stringify(paidTab.bodies);
  for (const forbidden of ["accountNumber", "ifsc", "upiId", "paidByEmail"]) assert.ok(!text.includes(forbidden), `no ${forbidden}`);
  assert.equal(pending.mine[0].owedMinor, 0, "only a paid payout can owe");

  // onlyOneAdmin is the real fact: four-eyes is on here and this database has more than one active administrator (these tests made three).
  const active = await prisma.adminUser.count({ where: { disabledAt: null } });
  assert.equal(pending.body.onlyOneAdmin, payoutsLib.fourEyesEnabled() && active < 2);
  assert.equal(pending.body.onlyOneAdmin, false);
});

test("M6: what a row lets the viewer do is worked out per viewer on the server (the creator cannot approve, a second administrator can)", { skip }, async () => {
  const asY = await sessionLib.createAdminSession(Y);
  const asZ = await sessionLib.createAdminSession(Z);
  const approvalOf = async (token: string, id: string, tab = "PENDING") => {
    const { rows } = await walk<PayoutRow>(routes.payouts, `?status=${tab}`, token, (rs) => rs.some((r) => r.id === id));
    return rows.find((r) => r.id === id)!.approval;
  };

  assert.deepEqual(await approvalOf(asY, payoutPending), { required: true, approved: false, approvedByEmail: null, canApprove: false, createdByViewer: true, canMarkPaid: false }, "the creator");
  assert.deepEqual(await approvalOf(asZ, payoutPending), { required: true, approved: false, approvedByEmail: null, canApprove: true, createdByViewer: false, canMarkPaid: false }, "a second administrator");

  // Once Z has approved it, the creator can mark it paid (and nobody can approve it again).
  await prisma.payout.update({ where: { id: payoutPending }, data: { approvedAt: new Date(), approvedByEmail: emailZ } });
  try {
    assert.deepEqual(await approvalOf(asY, payoutPending), { required: true, approved: true, approvedByEmail: emailZ, canApprove: false, createdByViewer: true, canMarkPaid: true });
    assert.deepEqual(await approvalOf(asZ, payoutPending), { required: true, approved: true, approvedByEmail: emailZ, canApprove: false, createdByViewer: false, canMarkPaid: true });
  } finally {
    await prisma.payout.update({ where: { id: payoutPending }, data: { approvedAt: null, approvedByEmail: null } });
  }

  // A paid payout offers nothing to anyone.
  for (const token of [asY, asZ]) {
    const a = await approvalOf(token, payoutPaid, "PAID");
    assert.equal(a.canApprove, false);
    assert.equal(a.canMarkPaid, false);
  }
  // The decision matches the library function the old page used (one source of truth), for the same viewer.
  const row = await prisma.payout.findUniqueOrThrow({ where: { id: payoutPending } });
  const expected = payoutsLib.payoutApprovalView(row, emailZ, process.env, 0);
  assert.deepEqual(await approvalOf(asZ, payoutPending), { required: expected.required, approved: expected.approved, approvedByEmail: expected.approvedByEmail, canApprove: expected.canApprove, createdByViewer: expected.createdByViewer, canMarkPaid: expected.canMarkPaid });
});

/* ---------- M7 bookings ---------- */

const BOOKING_ROW_KEYS = ["currency", "customerName", "id", "influencer", "lastError", "paidMinor", "serviceTitle", "startTime", "status"];
type BookingRow = { id: string; customerName: string; status: string; lastError: string | null; paidMinor: number; currency: string; serviceTitle: string };

test("M7 GET /api/admin/bookings: the status filters, the error text cut to 80 characters, the paid total, exactly the hand-picked fields", { skip }, async () => {
  const token = await sessionLib.createAdminSession(Y);
  const isMine = (r: BookingRow) => r.customerName.endsWith(` ${run}`);
  const kindOfBooking = (r: BookingRow) => r.customerName.replace(/^Money /, "").replace(` ${run}`, "");
  // This run's bookings on a filter: found by walking the pages (see walk: they need not be on page 1 of a busy shared database).
  const onFilter = async (query: string, expected: number) => {
    const { bodies, rows } = await walk<BookingRow>(routes.bookings, query, token, (rs) => rs.filter(isMine).length >= expected);
    for (const b of bodies) {
      assert.ok((b.rows as unknown[]).length <= 25);
      assertNoSecretKeys(b);
    }
    return { body: bodies[0], rows, mine: rows.filter(isMine) };
  };

  const all = await onFilter("", 9);
  assert.deepEqual(keys(all.body), ["page", "pageCount", "rows", "status", "total"]);
  assert.equal(all.body.status, "all");
  assert.ok((all.body.total as number) >= 9);
  for (const r of all.rows) assert.deepEqual(keys(r), BOOKING_ROW_KEYS);

  const expected: Record<string, string[]> = {
    REQUESTED: ["requested"],
    PENDING_PAYMENT: ["unpaid"],
    SCHEDULED: ["done", "recon"],
    COMPLETED: ["inpayout"],
    CANCELLED: ["needsrefund", "refunded"],
    FAILED: ["failed"],
    EXPIRED: ["mismatch"],
    PAID: [],
  };
  for (const [status, who] of Object.entries(expected)) {
    const out = await onFilter(`?status=${status}`, who.length);
    assert.equal(out.body.status, status);
    assert.deepEqual(out.mine.map(kindOfBooking).sort(), who, status);
    assert.ok(out.rows.every((r) => r.status === status), `${status}: only that status`);
  }
  for (const odd of ["?status=HELD", "?status=bogus", "?status=paid", "?status=", "?status=__proto__"]) assert.equal((await ask(routes.bookings, odd, token)).body.status, "all", odd);

  const failed = (await onFilter("?status=FAILED", 1)).mine[0];
  assert.equal(failed.lastError, "E".repeat(80), "only the first 80 characters leave the server");
  const row = (kind: string) => all.mine.find((r) => r.customerName === customer(kind))!;
  assert.equal(row("recon").paidMinor, 1000);
  assert.equal(row("refunded").paidMinor, 1000, "a refunded payment still counts as paid");
  assert.equal(row("unpaid").paidMinor, 0, "a payment that was never captured does not");
  assert.equal(row("recon").currency, "INR");
  assert.equal(row("recon").serviceTitle, `Money call ${run}`);
});

/* ---------- M9 audit ---------- */

test("M9 GET /api/admin/audit: 25 entries a page, newest first, no free-form detail, odd pages are page 1, there is no way to read it all at once", { skip }, async () => {
  const token = await sessionLib.createAdminSession(Y);
  const page = async (query: string) => {
    const out = await ask(routes.audit, query, token);
    assert.equal(out.status, 200, query);
    assert.deepEqual(keys(out.body), ["page", "pageCount", "rows"]);
    assert.ok((out.body.rows as unknown[]).length <= 25, `${query}: at most 25 entries`);
    assert.equal(typeof out.body.pageCount, "number");
    assertNoSecretKeys(out.body);
    return out.body as { page: number; pageCount: number; rows: { id: string; action: string; adminEmail: string }[] };
  };

  const first = await page("");
  assert.equal(first.page, 1);
  assert.ok(first.pageCount >= 2, "more than one page exists (30 entries were added)");
  assert.equal(first.rows.length, 25);
  for (const r of first.rows) assert.deepEqual(keys(r), ["action", "adminEmail", "createdAt", "id", "ip", "targetId", "targetType"]);
  const text = JSON.stringify(first);
  assert.ok(!text.includes(DETAIL_MARKER) && !text.includes('"detail"'), "the detail column is never sent");
  const times = (first.rows as unknown as { createdAt: string }[]).map((r) => Date.parse(r.createdAt));
  assert.deepEqual(times, [...times].sort((a, b) => b - a), "newest first");

  const second = await page("?page=2");
  assert.equal(second.page, 2);
  assert.ok(second.pageCount >= first.pageCount, "the log may grow between two reads (other tests write entries too), never shrink");
  assert.ok(second.rows.length >= 1);

  // This run's own 30 entries, found by walking the pages. Entries other tests add meanwhile push rows from one page to the next, so one
  // of ours can be seen twice but never missed: the walk keeps the first sighting of each and ends when all 30 are found.
  const own = new Map<string, string>();
  for (let p = 1; p <= first.pageCount + 1 && own.size < 30; p++) {
    for (const r of (await page(`?page=${p}`)).rows) if (r.adminEmail === auditEmail) own.set(r.id, r.action);
  }
  const ownActions = [...own.values()];
  assert.equal(ownActions.length, 30, "all of this run's entries are reachable page by page");
  assert.deepEqual(ownActions, [...ownActions].sort(), "newest first across the pages: test.money.00 first, test.money.29 last");

  for (const odd of ["?page=0", "?page=-1", "?page=abc", "?page=1e9", "?page=10000", "?page=99999999999", "?page=", "?page=1.5x"]) {
    assert.equal((await page(odd)).page, 1, `page ${odd}`);
  }
  assert.equal((await page("?page=2.7")).page, 2, "a decimal is read as its whole part, like the old page");
  const far = await page("?page=9999");
  assert.equal(far.page, 9999);
  assert.deepEqual(far.rows, []);
  const limitParam = await page("?limit=100000&pageSize=100000&take=100000");
  assert.equal(limitParam.rows.length, 25, "no parameter changes the page size");
});

/* ---------- M8 health ---------- */

test("M8 GET /api/admin/health: the worker, the conditions, the queues and the lists, with exactly the hand-picked fields and no secret", { skip }, async () => {
  const token = await sessionLib.createAdminSession(Y);
  // A payment-recovery entry with a connection string in its reason, as an error message could carry one.
  const secretReason = "Redis said redis://default:hunter2-password@redis.example.com:6379 refused";
  const recovered = await prisma.adminAuditLog.create({
    data: { adminEmail: "system:payment-recovery", action: "payment.recovered_needs_refund", targetType: "payment", targetId: `pay-row-${run}`, detail: { razorpayPaymentId: `pay_${run}_rec`, bookingId: `bk-${run}`, amountMinor: 5000, currency: "INR", reason: secretReason } },
  });
  let out;
  try {
    out = await ask(routes.health, "", token);
  } finally {
    await prisma.adminAuditLog.delete({ where: { id: recovered.id } });
  }
  assert.equal(out.status, 200);
  assert.deepEqual(keys(out.body), ["at", "failed", "queueNames", "queues", "recovered", "recovery", "report", "thresholds", "worker"]);
  assert.equal(typeof out.body.at, "number");
  assert.deepEqual(keys(out.body.thresholds), ["meetingStuckMinutes", "queueFailedMax", "queueWaitingMax", "workerStaleSeconds"], "only the four limits the page prints");
  assert.deepEqual(keys(out.body.report), ["conditions", "unhealthy", "unknownCount"]);
  const report = out.body.report as { conditions: { id: string }[]; unhealthy: object[]; unknownCount: number };
  assert.ok(report.conditions.length >= 8 && report.conditions.every((c) => c.id !== "worker-heartbeat"), "the table rows: every condition but the worker's, which has its own card");
  for (const c of report.conditions) assert.deepEqual(keys(c), ["detail", "hint", "href", "id", "label", "status", "value"]);
  for (const u of report.unhealthy) assert.deepEqual(keys(u), ["label", "status"]);
  assert.ok(Number.isInteger(report.unknownCount) && report.unknownCount >= 1, "the worker, Redis and the queues cannot be measured without Redis");
  assert.deepEqual(keys(out.body.worker), ["detail", "heartbeatReason", "heartbeatState", "hint", "lastBeatAgeText", "lastBeatAt", "status"]);
  assert.deepEqual(out.body.queueNames, [...QUEUE_NAMES]);
  assert.deepEqual(keys(out.body.queues), [...QUEUE_NAMES].sort(), "one entry per queue (null when Redis cannot be asked)");
  assert.deepEqual(keys(out.body.failed), ["jobs", "unavailable"]);

  // Redis is not configured in this test, so nothing can be said about the worker: Unknown, with the reason, never an error.
  const worker = out.body.worker as { status: string; heartbeatState: string; heartbeatReason: string; lastBeatAt: number | null; lastBeatAgeText: string | null; detail: string | null; hint: string | null };
  assert.equal(worker.status, "unknown");
  assert.equal(worker.detail, null, "the worker's sentence is only sent while it is not running (the alert that shows it)");
  assert.equal(worker.hint, null);
  assert.equal(out.body.recovery, null, "no recovery run recorded without Redis: the card says so");
  assert.equal(worker.heartbeatState, "unknown");
  assert.equal(worker.heartbeatReason, "Redis is not configured");
  assert.equal(worker.lastBeatAt, null);
  assert.equal(worker.lastBeatAgeText, null);
  assert.deepEqual(out.body.failed && (out.body.failed as { unavailable: string[] }).unavailable.sort(), [...QUEUE_NAMES].sort(), "the failed-job lists could not be read");

  // The recovery row has its fields, and the password and host user part of the connection string in its reason are gone.
  const rows = out.body.recovered as { reference: string | null; note: string; outcome: string; amountMinor: number | null }[];
  const row = rows.find((r) => r.reference === `pay_${run}_rec`);
  assert.ok(row, "the recovery entry is listed");
  assert.deepEqual(keys(row), ["amountMinor", "at", "currency", "id", "note", "outcome", "reference"], "the Razorpay id and the note as the page shows them, not the ids behind them");
  assert.equal(row.outcome, "flagged");
  assert.equal(row.note, "Redis said redis://***@redis.example.com:6379 refused");
  assert.ok(!JSON.stringify(out.body).includes(`pay-row-${run}`) && !JSON.stringify(out.body).includes(`bk-${run}`), "neither our payment id (a Razorpay id exists) nor the booking id (a reason exists) is sent");

  // No secret value of this process' environment appears anywhere in the body.
  const textBody = JSON.stringify(out.body);
  assert.ok(!textBody.includes("hunter2-password"));
  for (const value of secretValues) assert.ok(!textBody.includes(value), "no secret environment value in the health body");
  assertNoSecretKeys(out.body);
});

/* ---------- exposure ---------- */

test("no response carries a value its page does not show: encrypted tokens and bank details of the influencer, customer contact data, notes, internal ids", { skip }, async () => {
  assert.ok(hidden.length >= 50, "the fixtures hold the connections' encrypted tokens, the bank account, customer contact data, notes, a webhook event, refunds, and the administrators' encrypted authenticator secret, recovery-code and password hashes");
  assert.ok(hidden.some((h) => h.startsWith("hidden-recovery-code-hash")) && hidden.some((h) => h.startsWith("hidden-refund-id")) && hidden.some((h) => h.startsWith("hidden-webhook-event")));
  const token = await sessionLib.createAdminSession(Y);
  // The administrators' own secrets: the raw session cookie in use, and the stored hash of every session row the tests made.
  const sessions = await prisma.adminSession.findMany({ where: { adminId: { in: [X, Y, Z] } }, select: { tokenHash: true } });
  assert.ok(sessions.length >= 3, "session rows exist (their hashes are stored, never sent)");
  const adminSecrets = [token, ...sessions.map((s) => s.tokenHash)];
  // The text of every page read of an endpoint. A list is read page by page until this run's row is on one (see walk).
  type Row = { id: string } & Record<string, unknown>;
  const bodies: [string, string][] = [];
  const grab = async (label: string, handler: Handler, query: string, mine: (r: Row) => boolean) => {
    const { bodies: pages } = await walk<Row>(handler, query, token, (rs) => rs.some(mine));
    bodies.push([label, JSON.stringify(pages)]);
  };
  await grab("payments", routes.payments, "?view=all", (r) => r.razorpayId === `pay_${run}_recon`);
  await grab("payouts", routes.payouts, "?status=all", (r) => r.reference === `UTR${run}`);
  await grab("bookings", routes.bookings, "", (r) => r.customerName === customer("recon"));
  await grab("audit", routes.audit, "", (r) => r.action === "test.money.00");
  const health = await ask(routes.health, "", token);
  assert.equal(health.status, 200);
  bodies.push(["health", JSON.stringify(health.body)]);

  // The rows really are in the responses (so the check below looks at the data it should).
  assert.ok(bodies[0][1].includes(`pay_${run}_recon`) && bodies[1][1].includes(`UTR${run}`) && bodies[2][1].includes(customer("recon")) && bodies[3][1].includes("test.money.00"));

  for (const [label, text] of bodies) {
    for (const value of [...hidden, ...adminSecrets]) assert.ok(!text.includes(value), `${label}: the response contains ${value.slice(0, 12)}...`);
    assert.ok(!text.includes(`money-owner-${run}@example.com`), `${label}: the influencer's email is shown nowhere`);
    // An administrator's address appears only where a page names an administrator: the audit log's "Admin" column (and "Approved by" on a
    // payout still to send, none here), never the creator or payer of a payout.
    if (label !== "audit") for (const value of [emailX, emailY, emailZ]) assert.ok(!text.includes(value), `${label}: the response contains ${value}`);
    assertNoSecretKeys(JSON.parse(text));
  }
  // Ids of rows a page does not name: the payments page never sends booking, session or payout ids; the bookings page no payment id.
  const payoutIds = await prisma.payout.findMany({ where: { influencer: { slug: `money-${run}` } }, select: { id: true } });
  for (const { id } of payoutIds) assert.ok(!bodies[0][1].includes(id), "payments: no payout id");
  const bookingIds = await prisma.booking.findMany({ where: { session: { service: { influencerId } } }, select: { id: true, sessionId: true } });
  for (const b of bookingIds) assert.ok(!bodies[0][1].includes(b.id) && !bodies[0][1].includes(b.sessionId), "payments: no booking or session id");
  const paymentIds = await prisma.payment.findMany({ where: { booking: { session: { service: { influencerId } } } }, select: { id: true } });
  for (const p of paymentIds) assert.ok(!bodies[2][1].includes(p.id), "bookings: no payment id");
});

/* ---------- no database: scrubbing, fixtures, views, wiring ---------- */

test("scrubHealthText: realistic secrets in an error message never reach the page (fixed strings, one per way a secret can show up)", () => {
  const slack = "https://hooks.slack.com/services/T0001/B0002/Xx9Yy8Zz7";
  const env = {
    REDIS_URL: "redis://default:hunter22pw@redis.example.com:6379",
    RAZORPAY_KEY_SECRET: "abcdefgh12345678",
    ERROR_WEBHOOK_URL: slack,
    SMS_API_URL: "https://sms.example.com/v1/send?k=abc",
    APP_SECRET: "short",
    NODE_ENV: "production",
    LOG_LEVEL: "verbose-logging",
  };
  // [message, what the page may show]
  const cases: [string, string][] = [
    // Secret environment values, by name (SECRET, a webhook, _URL...), wherever they occur.
    ["connect ECONNREFUSED redis://default:hunter22pw@redis.example.com:6379", "connect ECONNREFUSED [hidden]"],
    ["bad key abcdefgh12345678 rejected", "bad key [hidden] rejected"],
    [`POST ${slack} failed (404)`, "POST [hidden] failed (404)"],
    ["sms provider said https://sms.example.com/v1/send?k=abc was down", "sms provider said [hidden] was down"],
    // The user and password part of any URL, whatever the password contains.
    ["a postgres://user:pass@db.example.com:5432/app and rediss://:tok@h:1", "a postgres://***@db.example.com:5432/app and rediss://***@h:1"],
    ["connect failed postgresql://postgres.abc:S3cr3t@pw@host:5432/db (timeout)", "connect failed postgresql://***@host:5432/db (timeout)"],
    ["redis://default:ab/cd1234@host:6379 refused", "redis://***@host:6379 refused"],
    ["redis://default:p#ss1234@host:6379 refused", "redis://***@host:6379 refused"],
    ["redis://default:p?ss1234@host:6379 refused", "redis://***@host:6379 refused"],
    ['"redis://u:p@h:1" ended', '"redis://***@h:1" ended'],
    // Tokens in headers, query strings and JSON bodies.
    ["Authorization: Bearer ya29.a0AfH6SMBxyz-123_456 rejected", "Authorization: Bearer [hidden] rejected"],
    ["GET https://graph.facebook.com/v20.0/me?access_token=EAAGm0PX4ZCpsBA&fields=id failed", "GET https://graph.facebook.com/v20.0/me?access_token=[hidden]&fields=id failed"],
    ["POST https://sms.other.example/send?to=1&authkey=AbCdEf123456 failed", "POST https://sms.other.example/send?to=1&authkey=[hidden] failed"],
    ["https://x.example/y?KEY=abc123&a=b", "https://x.example/y?KEY=[hidden]&a=b"],
    ['{"access_token":"ya29.abc","expires_in":3599}', '{"access_token":"[hidden]","expires_in":3599}'],
    // Nothing else is touched: short values, non-secret names, ordinary messages, a URL or an address without credentials.
    ["value short stays, NODE_ENV production stays, LOG_LEVEL verbose-logging stays", "value short stays, NODE_ENV production stays, LOG_LEVEL verbose-logging stays"],
    ["Redis did not answer: Command timed out", "Redis did not answer: Command timed out"],
    ["a URL without credentials https://example.com/path stays; so does ops@example.com", "a URL without credentials https://example.com/path stays; so does ops@example.com"],
  ];
  for (const [message, shown] of cases) assert.equal(scrubHealthText(message, env), shown, message);
  // The same strings with an empty environment: everything that does not depend on an environment value is still taken out.
  assert.equal(scrubHealthText("redis://default:hunter22pw@redis.example.com:6379", {}), "redis://***@redis.example.com:6379");
  for (const leaked of ["S3cr3t", "pw@host", "ab/cd1234", "p#ss1234", "ya29.", "EAAGm0PX4ZCpsBA", "AbCdEf123456", "abc123"]) {
    for (const [message] of cases) assert.ok(!scrubHealthText(message, {}).includes(leaked), `${leaked} must not survive in: ${message}`);
  }
});

const NOW = Date.parse("2026-10-11T10:00:00.000Z");
const idle = { waiting: 0, active: 0, failed: 0, delayed: 0 };
function snapshot(over: Partial<HealthSnapshot> = {}): HealthSnapshot {
  return {
    at: NOW,
    heartbeat: { state: "ok", at: NOW - 12_000 },
    redis: "ok",
    unrecoveredPayments: 0,
    recovery: { consecutiveFailedRuns: 0, lastRunAt: NOW - 60_000, lastError: null, lastCandidates: 4, lastRecovered: 1 },
    stuckMeetings: 0,
    failedConfirmations: 0,
    unsweptHolds: 0,
    queues: Object.fromEntries(QUEUE_NAMES.map((n) => [n, { ...idle }])),
    ...over,
  };
}
const health = (over: Partial<HealthSnapshot> = {}, extra: { recovered?: Parameters<typeof buildAdminHealthView>[0]["recovered"]; failed?: Parameters<typeof buildAdminHealthView>[0]["failed"] } = {}, env: Record<string, string | undefined> = {}) =>
  jsonify(buildAdminHealthView({ snapshot: snapshot(over), thresholds: DEFAULT_THRESHOLDS, recovered: extra.recovered ?? [], failed: extra.failed ?? { jobs: [], unavailable: [] }, queueNames: QUEUE_NAMES }, env));

test("buildAdminHealthView: a stale heartbeat is a critical worker with its age, a fresh one is running, an unreadable one is unknown", () => {
  const stale = health({ heartbeat: { state: "ok", at: NOW - 10 * 60_000 } });
  assert.equal(stale.worker.status, "critical");
  assert.equal(stale.worker.detail, "Worker is not running: the last heartbeat was 10 min ago.");
  assert.equal(stale.worker.lastBeatAt, NOW - 10 * 60_000);
  assert.equal(stale.worker.lastBeatAgeText, "10 min");
  assert.ok(stale.worker.hint?.includes("npm run worker"));
  assert.deepEqual(stale.report.unhealthy, [{ label: "Background worker", status: "critical" }]);
  assert.ok(stale.report.conditions.every((c) => c.id !== "worker-heartbeat"), "the worker is not a row of the conditions table");
  assert.equal(stale.report.unknownCount, 1, "the recovery loop is not checked while the worker is down");
  assert.equal(stale.at, NOW);

  const missing = health({ heartbeat: { state: "missing" } });
  assert.equal(missing.worker.status, "critical");
  assert.equal(missing.worker.lastBeatAt, null);
  assert.equal(missing.worker.heartbeatState, "missing");
  assert.equal(missing.worker.heartbeatReason, null);

  const fresh = health();
  assert.equal(fresh.worker.status, "ok");
  assert.equal(fresh.worker.lastBeatAgeText, "12 s");
  assert.equal(fresh.worker.hint, null);
  assert.equal(fresh.worker.detail, null, "the worker's sentence is sent only while it is not running");
  assert.deepEqual(fresh.report.unhealthy, []);
  assert.equal(fresh.report.unknownCount, 0);
  assert.deepEqual(fresh.recovery, { lastRunAt: NOW - 60_000, lastCandidates: 4, lastRecovered: 1 });
  assert.equal(health({ recovery: null }).recovery, null);
  assert.equal(health({ recovery: { consecutiveFailedRuns: 0, lastRunAt: null, lastError: "never sent", lastCandidates: 9, lastRecovered: 9 } }).recovery, null, "without a run the card shows nothing of the counts");
  assert.ok(!JSON.stringify(health({ recovery: { consecutiveFailedRuns: 5, lastRunAt: NOW - 1000, lastError: "lookup failed hidden-last-error", lastCandidates: 1, lastRecovered: 0 } }).recovery).includes("hidden-last-error"), "the recovery error is only inside the condition's sentence, not a field of its own");

  const unknown = health({ heartbeat: { state: "unknown", reason: "Redis did not answer: redis://u:pw@h:6379 timed out", redis: "down" }, redis: "down" }, {}, { REDIS_URL: "redis://u:pw@h:6379" });
  assert.equal(unknown.worker.status, "unknown");
  assert.equal(unknown.worker.detail, null, "the unknown worker's sentence repeats the reason; the page shows the reason only once");
  assert.ok(unknown.report.unknownCount >= 1);
  assert.equal(unknown.worker.heartbeatReason, "Redis did not answer: [hidden] timed out", "a secret in the reason is taken out");
  assert.equal(unknown.worker.lastBeatAt, null);
  assert.deepEqual(keys(unknown.queues), [...QUEUE_NAMES].sort());
  assertNoSecretKeys(unknown);
  assertNoSecretKeys(stale);
});

type Views = {
  PaymentsView: typeof import("../web/src/components/views/admin/PaymentsView").PaymentsView;
  PayoutsView: typeof import("../web/src/components/views/admin/PayoutsView").PayoutsView;
  BookingsView: typeof import("../web/src/components/views/admin/BookingsView").BookingsView;
  AuditView: typeof import("../web/src/components/views/admin/AuditView").AuditView;
  HealthView: typeof import("../web/src/components/views/admin/HealthView").HealthView;
};
let viewsLoaded: Promise<Views> | undefined;

/**
 * The views rendered on the server. The navigation hooks (they need a Router and a QueryClient) and the client components that
 * need a provider (the action buttons) are replaced by stand-ins that print their props; then the views are imported
 * (mock.module only affects modules imported afterwards, hence the lazy import). The real link component renders a plain <a> here.
 */
function loadViews(): Promise<Views> {
  viewsLoaded ??= (async () => {
    mock.module("@web/lib/navigate", { namedExports: fakeNavigate("/admin") });
    mock.module("@web/components/admin/PayoutActions", {
      namedExports: {
        ReconcileButton: (p: { ids: string[] }) => (p.ids.length === 0 ? null : createElement("button", { "data-reconcile": p.ids.join(",") })), // like the real one: nothing to reconcile, no button
        UnreconcileButton: (p: { paymentId: string }) => createElement("button", { "data-unreconcile": p.paymentId }),
        PayoutRowActions: (p: { payoutId: string; status: string; approval: unknown }) => createElement("div", { "data-actions": JSON.stringify({ id: p.payoutId, status: p.status, approval: p.approval }) }),
        PayoutStatusBadges: (p: { status: string; approval: unknown }) => createElement("span", { "data-badges": JSON.stringify({ status: p.status, approval: p.approval }) }),
      },
    });
    return {
      PaymentsView: (await import("../web/src/components/views/admin/PaymentsView")).PaymentsView,
      PayoutsView: (await import("../web/src/components/views/admin/PayoutsView")).PayoutsView,
      BookingsView: (await import("../web/src/components/views/admin/BookingsView")).BookingsView,
      AuditView: (await import("../web/src/components/views/admin/AuditView")).AuditView,
      HealthView: (await import("../web/src/components/views/admin/HealthView")).HealthView,
    };
  })();
  return viewsLoaded;
}

const unHtml = (s: string) => s.replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
/** The text of the page's visually hidden live status line. */
function statusLine(html: string): string {
  const m = /<p role="status" class="sr-only">([^<]*)<\/p>/.exec(html);
  assert.ok(m, "the view has a status line");
  return unHtml(m[1]);
}
const busyAttr = (html: string) => /aria-busy="true"/.test(html);
/** The JSON a stand-in printed in a data-* attribute, one entry per occurrence. */
const printed = (html: string, name: string) => [...html.matchAll(new RegExp(`data-${name}="([^"]*)"`, "g"))].map((m) => JSON.parse(unHtml(m[1])) as Record<string, unknown>);

const payment = (over: Record<string, unknown> = {}) => ({
  id: "p1",
  createdAt: "2026-10-01T08:30:00.000Z",
  status: "CAPTURED",
  needsRefund: false,
  refundStatus: null,
  refundAmountMinor: null,
  amountMinor: 250000,
  currency: "INR",
  reconciled: false,
  inPayout: false,
  razorpayId: "pay_ABC",
  mismatch: false,
  booking: { status: "SCHEDULED", customerName: "Cust One" },
  service: { title: "Strategy call" },
  influencer: { id: "inf1", name: "Ina Fluencer" },
  ...over,
});
const counts = { all: 9, unreconciled: 4, captured: 6, needsRefund: 1, mismatch: 2, unpaid: 3 };

test("PaymentsView: tabs with counts, a status line, reconcile ids for the unreconciled captured payments only, badges, busy only when told", async () => {
  const { PaymentsView } = await loadViews();
  const rows = [
    payment({ id: "recon" }),
    payment({ id: "mismatch", mismatch: true, booking: { status: "EXPIRED", customerName: "Cust Two" }, razorpayId: "order_M" }),
    payment({ id: "done", reconciled: true }),
    payment({ id: "inpayout", reconciled: true, inPayout: true }),
    payment({ id: "refund", needsRefund: true, refundStatus: "processed", refundAmountMinor: 100000 }),
    payment({ id: "created", status: "CREATED" }),
  ];
  const html = renderToStaticMarkup(createElement(PaymentsView, { data: jsonify({ view: "unreconciled" as const, page: 2, pageCount: 3, total: 51, counts, rows }) }));
  assert.equal(statusLine(html), "To reconcile: 51 payments, page 2 of 3.");
  assert.equal(count(html, "data-reconcile="), 1);
  assert.ok(html.includes('data-reconcile="recon,mismatch,refund"'), "captured, not reconciled, not in a payout: and nothing else");
  assert.ok(html.includes('data-unreconcile="done"') && !html.includes('data-unreconcile="inpayout"'), "undo only where it is allowed");
  assert.ok(html.includes("Mismatch") && html.includes("In payout") && html.includes("Not yet") && html.includes("Needs refund"));
  assert.ok(html.includes("Refund processed · ") && html.includes("1,000.00"));
  assert.ok(html.includes('href="/admin/influencers/inf1"') && html.includes("pay_ABC") && html.includes("order_M"), "the payment id, else the order id");
  assert.match(html, /<a [^>]*aria-current="page"[^>]*>To reconcile<span class="tab__count">4<\/span>/, "the loaded view is the current tab");
  for (const [label, n] of [["All", 9], ["Paid", 6], ["Needs refund", 1], ["No paid booking", 2], ["Unpaid / failed", 3]] as const) assert.ok(html.includes(`>${label}<span class="tab__count">${n}</span>`), `tab ${label} ${n}`);
  assert.ok(html.includes('href="/admin/payments?view=unreconciled&amp;page=3"'), "Next keeps the tab");
  assert.ok(!busyAttr(html) && busyAttr(renderToStaticMarkup(createElement(PaymentsView, { data: jsonify({ view: "all" as const, page: 1, pageCount: 1, total: 0, counts, rows: [] }), busy: true }))));

  const empty = renderToStaticMarkup(createElement(PaymentsView, { data: jsonify({ view: "mismatch" as const, page: 1, pageCount: 1, total: 0, counts, rows: [] }) }));
  assert.equal(statusLine(empty), "No paid booking: no payments, page 1 of 1.");
  assert.ok(empty.includes("No payments here") && !empty.includes("data-reconcile"));
  const hostile = renderToStaticMarkup(createElement(PaymentsView, { data: jsonify({ view: "all" as const, page: 1, pageCount: 1, total: 1, counts, rows: [payment({ booking: { status: "SCHEDULED", customerName: '"><script>alert(1)</script>' } })] }) }));
  assert.ok(!hostile.includes("<script>"), "a customer name is escaped");
});

test("PayoutsView: the server's approval fields reach the row's buttons untouched, UTR and 'refunded since' show, the lone-administrator warning shows", async () => {
  const { PayoutsView } = await loadViews();
  const approval = { required: true, approved: false, approvedByEmail: null, canApprove: true, createdByViewer: false, canMarkPaid: false };
  const row = (over: Record<string, unknown> = {}) => ({
    id: "po1", createdAt: "2026-10-01T08:30:00.000Z", influencer: { id: "inf1", name: "Ina Fluencer" }, destination: "UPI ****1234", grossAfterRefundsMinor: 90000,
    feeMinor: 9000, feePercentText: "10%", netMinor: 81000, currency: "INR", status: "PENDING", reference: null, owedMinor: 0, approval, ...over,
  });
  const data = (over: Record<string, unknown> = {}) =>
    jsonify({ status: "PENDING" as const, page: 1, pageCount: 1, counts: { PENDING: 2, PAID: 1, CANCELLED: 0, all: 3 }, onlyOneAdmin: false, rows: [row(), row({ id: "po2", status: "PAID", reference: "UTR123456", owedMinor: 30000, approval: { ...approval, canApprove: false, required: false, canMarkPaid: false } })], ...over });

  const html = renderToStaticMarkup(createElement(PayoutsView, { data: data() }));
  assert.equal(statusLine(html), "To send: 2 payouts, page 1 of 1.");
  assert.deepEqual(printed(html, "actions")[0], { id: "po1", status: "PENDING", approval }, "the buttons get what the server decided");
  assert.deepEqual(printed(html, "badges")[0], { status: "PENDING", approval });
  assert.ok(html.includes("UTR UTR123456") && html.includes("Refunded since: ") && html.includes("300.00") && html.includes("to recover"));
  assert.ok(html.includes("(10%)") && html.includes("UPI ****1234"));
  assert.ok(html.includes("900.00"), "gross is shown after refunds (1,000.00 - 100.00)");
  for (const [label, n] of [["To send", 2], ["Paid", 1], ["Cancelled", 0], ["All", 3]] as const) assert.ok(html.includes(`>${label}<span class="tab__count">${n}</span>`), `tab ${label}`);
  assert.ok(!html.includes("Payouts need a second administrator"));
  assert.ok(renderToStaticMarkup(createElement(PayoutsView, { data: data({ onlyOneAdmin: true }) })).includes("Payouts need a second administrator"));
  assert.equal(statusLine(renderToStaticMarkup(createElement(PayoutsView, { data: data({ status: "all", counts: { PENDING: 0, PAID: 0, CANCELLED: 0, all: 0 }, rows: [] }) }))), "All: no payouts, page 1 of 1.");
  assert.ok(!busyAttr(html) && busyAttr(renderToStaticMarkup(createElement(PayoutsView, { data: data(), busy: true }))));
});

test("BookingsView and AuditView: status lines with the filter and page, tab and pagination links, the error text, busy only when told", async () => {
  const { BookingsView, AuditView } = await loadViews();
  const booking = { id: "b1", serviceTitle: "Call", startTime: "2026-10-12T10:00:00.000Z", influencer: { id: "inf1", name: "Ina" }, customerName: "Cust", status: "FAILED", lastError: "meet link failed", paidMinor: 150000, currency: "INR" };
  const html = renderToStaticMarkup(createElement(BookingsView, { data: jsonify({ status: "FAILED" as const, page: 1, pageCount: 2, total: 26, rows: [booking, { ...booking, id: "b2", paidMinor: 0, lastError: null }] }) }));
  assert.equal(statusLine(html), "Needs attention: 26 bookings, page 1 of 2.");
  assert.ok(html.includes("26 bookings") && html.includes("meet link failed") && html.includes("1,500.00") && html.includes("—"));
  assert.ok(html.includes('href="/admin/bookings?status=FAILED&amp;page=2"'), "Next keeps the filter");
  assert.ok(html.includes('href="/admin/bookings?status=PAID"') && html.includes(">Paid, no link<"));
  assert.equal(statusLine(renderToStaticMarkup(createElement(BookingsView, { data: jsonify({ status: "all" as const, page: 1, pageCount: 1, total: 1, rows: [booking] }) }))), "All: 1 booking, page 1 of 1.");
  assert.ok(renderToStaticMarkup(createElement(BookingsView, { data: jsonify({ status: "all" as const, page: 1, pageCount: 1, total: 0, rows: [] }) })).includes("Nothing matches this filter."));
  assert.ok(!busyAttr(html) && busyAttr(renderToStaticMarkup(createElement(BookingsView, { data: jsonify({ status: "all" as const, page: 1, pageCount: 1, total: 0, rows: [] }), busy: true }))));

  const entry = { id: "a1", createdAt: "2026-10-01T08:30:00.000Z", adminEmail: "a@example.com", action: "payout.paid", targetType: "payout", targetId: "po1", ip: "203.0.113.7" };
  const audit = renderToStaticMarkup(createElement(AuditView, { data: jsonify({ page: 2, pageCount: 4, rows: [entry, { ...entry, id: "a2", targetType: null, targetId: null, ip: null }] }) }));
  assert.equal(statusLine(audit), "2 entries shown, page 2 of 4.");
  assert.ok(audit.includes("payout po1") && audit.includes("203.0.113.7") && audit.includes('href="/admin/audit?page=3"') && audit.includes('href="/admin/audit?page=1"'));
  assert.equal(statusLine(renderToStaticMarkup(createElement(AuditView, { data: jsonify({ page: 1, pageCount: 1, rows: [] }) }))), "No entries, page 1 of 1.");
  assert.ok(!busyAttr(audit) && busyAttr(renderToStaticMarkup(createElement(AuditView, { data: jsonify({ page: 1, pageCount: 1, rows: [] }), busy: true }))));
});

test("HealthView: 'Worker is not running' for a stale heartbeat, Running for a fresh one, Unknown with the reason, Refresh says Refreshing while busy", async () => {
  const { HealthView } = await loadViews();
  const render = (over: Partial<HealthSnapshot> = {}, busy?: boolean, extra: Parameters<typeof health>[1] = {}) => renderToStaticMarkup(createElement(HealthView, { data: health(over, extra), busy }));

  const stale = render({ heartbeat: { state: "ok", at: NOW - 10 * 60_000 } });
  assert.ok(stale.includes("Worker is not running"), "the alert title");
  assert.ok(stale.includes("Worker is not running: the last heartbeat was 10 min ago."), "its detail");
  assert.ok(stale.includes("npm run worker"), "and the hint");
  assert.ok(stale.includes(">Not running<") && stale.includes("(10 min ago)"));
  assert.ok(stale.includes("1 condition needs attention") && stale.includes("Background worker."));

  const fresh = render();
  assert.ok(!fresh.includes("Worker is not running"));
  assert.ok(fresh.includes(">Running<") && fresh.includes("(12 s ago)") && fresh.includes("Everything is healthy."));
  assert.ok(fresh.includes("4 checked, 1 recovered"));
  assert.ok(fresh.includes("worker stale after 180 s") && fresh.includes("after 15 min") && fresh.includes("more than 5 failed or 50 waiting"));
  for (const q of QUEUE_NAMES) assert.ok(fresh.includes(`>${q}<`), `queue ${q}`);
  assert.ok(fresh.includes("Monitored conditions") && !fresh.includes('data-label="Condition">Background worker'), "the worker is in its own card, not in the conditions table");

  const unknown = render({ heartbeat: { state: "unknown", reason: "Redis is not configured", redis: "not-configured" }, redis: "not-configured", queues: Object.fromEntries(QUEUE_NAMES.map((n) => [n, null])) });
  assert.ok(unknown.includes(">Unknown<") && unknown.includes("Redis is not configured"));
  assert.ok(unknown.includes("No problems found.") && unknown.includes("could not be measured and"));
  assert.ok(!unknown.includes("Worker is not running"));

  const missing = render({ heartbeat: { state: "missing" } });
  assert.ok(missing.includes("None recorded") && missing.includes("Worker is not running: no heartbeat has been recorded."));

  // The Refresh button: a link to the page itself; "Refreshing…" and aria-busy while the SPA refetches.
  assert.ok(/<a [^>]*href="\/admin\/health"[^>]*>Refresh<\/a>/.test(fresh));
  const busy = render({}, true);
  assert.ok(/<a [^>]*href="\/admin\/health"[^>]*>Refreshing…<\/a>/.test(busy) && busyAttr(busy));
  assert.ok(!busyAttr(fresh));
  // While busy the control is inert, so repeated clicks cannot stack health measurements; when idle it is an ordinary link.
  const refreshTag = (html: string) => /<a [^>]*href="\/admin\/health"[^>]*>/.exec(html)![0];
  assert.ok(refreshTag(busy).includes('aria-disabled="true"') && refreshTag(busy).includes('style="pointer-events:none"'), "inert while busy");
  assert.ok(!refreshTag(fresh).includes("aria-disabled") && !refreshTag(fresh).includes("pointer-events"), "an ordinary link when idle");

  const lists = render({}, undefined, {
    recovered: [
      { id: "r1", at: new Date(NOW - 3600_000), outcome: "recovered", paymentId: "pay-1", razorpayPaymentId: "pay_RZP1", bookingId: "bk1", amountMinor: 50000, currency: "INR", reason: null },
      { id: "r2", at: new Date(NOW - 7200_000), outcome: "flagged", paymentId: "pay-2", razorpayPaymentId: null, bookingId: null, amountMinor: null, currency: null, reason: "Slot taken" },
    ],
    failed: { jobs: [{ queue: "meetings", id: "job-9", name: "create-meeting", bookingId: "bk1", failedReason: "boom", attemptsMade: 5, failedAt: new Date(NOW - 60_000) }], unavailable: ["reminders"] },
  });
  assert.ok(lists.includes("pay_RZP1") && lists.includes("Booked") && lists.includes("Needs refund") && lists.includes("Booking bk1") && lists.includes("Slot taken") && lists.includes("500.00"));
  assert.ok(lists.includes("meetings · create-meeting") && lists.includes("job-9") && lists.includes("boom"));
  assert.ok(lists.includes("Some queues could not be read") && lists.includes("Redis did not answer for: reminders."));
  assert.ok(fresh.includes("No payment has needed recovery.") && fresh.includes("No failed jobs"));
});

/** One row per page: route id, SPA page, the view it renders, the view function, the endpoint. */
const PAGES: { id: SpaRouteId; spa: string; view: string; fn: string; endpoint: string }[] = [
  { id: "admin-payments", spa: "web/src/pages/admin/Payments.tsx", view: "PaymentsView", fn: "lib/views/admin-payments.ts", endpoint: "app/api/admin/payments/route.ts" },
  { id: "admin-payouts", spa: "web/src/pages/admin/Payouts.tsx", view: "PayoutsView", fn: "lib/views/admin-payouts.ts", endpoint: "app/api/admin/payouts/route.ts" },
  { id: "admin-bookings", spa: "web/src/pages/admin/Bookings.tsx", view: "BookingsView", fn: "lib/views/admin-bookings.ts", endpoint: "app/api/admin/bookings/route.ts" },
  { id: "admin-health", spa: "web/src/pages/admin/Health.tsx", view: "HealthView", fn: "lib/views/admin-health.ts", endpoint: "app/api/admin/health/route.ts" },
  { id: "admin-audit", spa: "web/src/pages/admin/Audit.tsx", view: "AuditView", fn: "lib/views/admin-audit.ts", endpoint: "app/api/admin/audit/route.ts" },
];

test("every page: the SPA page renders its view, and the endpoint loads it through the view function behind the full admin gate", () => {
  for (const p of PAGES) {
    const viewImport = `@web/components/views/admin/${p.view}`;
    const fnImport = `@/${p.fn.replace(/\.ts$/, "")}`;
    const spa = read(p.spa);
    const endpoint = read(p.endpoint);
    assert.ok(spa.includes(`"${viewImport}"`), `${p.id}: the page renders ${p.view}`);
    assert.ok(endpoint.includes(`"${fnImport}"`), `${p.id}: the endpoint loads through ${p.fn}`);
    // The page body lives in the view: the page itself renders no table or chrome and reads no data directly.
    assert.ok(!/from "@web\/components\/(ui|app|admin)\//.test(spa) && !spa.includes("@/lib/db") && !spa.includes("@/lib/admin/data"), `${p.spa}: no page body or queries in it`);
    // The endpoint: the full gate (requireAdminMfa with no option: no enrolling admin, no password-only session of a 2FA admin), jsonView, GET only.
    assert.ok(/await requireAdminMfa\(\);/.test(endpoint), `${p.endpoint}: requireAdminMfa() without allowEnrollment`);
    assert.ok(!endpoint.includes("requireAdminApi") && !endpoint.includes("allowEnrollment: true"), `${p.endpoint}: never the weaker gate`);
    assert.ok(endpoint.includes("jsonView(") && /export async function GET\b/.test(endpoint) && !/export async function (POST|PUT|PATCH|DELETE)\b/.test(endpoint), `${p.endpoint}: a GET that answers with jsonView`);
    assert.ok(endpoint.includes('export const dynamic = "force-dynamic"'), `${p.endpoint}: never cached`);
    assert.equal(count(spa, "<PageTitle"), 1, `${p.spa}: exactly one PageTitle`);
  }
});

test("every SPA page sets its title with the same text and template as the route table (the admin pages end in \" · Admin\")", () => {
  for (const p of PAGES) {
    const route = spaRouteById(p.id);
    assert.ok("title" in route && route.title, `${p.id} has a title in the route table`);
    const m = /<PageTitle title="([^"]+)"(?: template="(\w+)")?/.exec(read(p.spa));
    assert.ok(m, `${p.spa} renders a <PageTitle> with literal props`);
    assert.equal(m[1], route.title, `${p.id}: title`);
    assert.equal(m[2] ?? "brand", route.template, `${p.id}: template`);
    assert.equal(route.template, "admin", `${p.id}: template`);
    assert.equal(formatTitle(route.title, route.template, BRAND_NAME), `${route.title} · Admin`);
  }
});

test("views and SPA pages import nothing server-side: only allowlisted lib modules, type-only imports from the view functions (what the Vite guard demands)", () => {
  const viewFiles = readdirSync(path.join(root, "web/src/components/views/admin")).filter((f) => f.endsWith(".tsx")).map((f) => `web/src/components/views/admin/${f}`);
  for (const view of PAGES.map((p) => `web/src/components/views/admin/${p.view}.tsx`)) assert.ok(viewFiles.includes(view), view);
  for (const file of [...viewFiles.filter((f) => PAGES.some((p) => f.endsWith(`${p.view}.tsx`))), ...PAGES.map((p) => p.spa)]) {
    const src = read(file);
    for (const m of src.matchAll(/^import (?!type )[^"']*from\s+["']([^"']+)["']/gm)) {
      const spec = m[1];
      assert.equal(specifierProblem(spec), null, `${file}: ${spec}`);
      // "@/..." is the repository root, "@web/..." is web/src.
      const base = spec.startsWith("@/") ? spec.slice(2) : spec.startsWith("@web/") ? `web/src/${spec.slice(5)}` : null;
      if (base) {
        const target = ["", ".ts", ".tsx", "/index.ts", "/index.tsx"].map((ext) => base + ext).find((rel) => existsSync(path.join(root, rel)) && statSync(path.join(root, rel)).isFile());
        assert.ok(target, `${file}: ${spec} resolves to a file`);
        assert.equal(repoPathProblem(target), null, `${file}: ${spec}`);
      }
    }
    assert.ok(!/^import (?!type )[^"']*from\s+["']@\/lib\/(views|admin|payouts|health|db|queue)/m.test(src), `${file}: no value import from server modules`);
  }
});
