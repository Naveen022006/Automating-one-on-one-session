// The admin finance report (WP-F): GET /api/admin/reports, lib/views/admin-reports.ts, lib/admin/reports.ts and the Reports page.
//
// The database part (needs DATABASE_URL, TOKEN_ENCRYPTION_KEY, APP_SECRET; skipped otherwise) builds two influencers whose money sits in
// two test-only currencies of this run (the report adds up the whole shared database, so only the rows of those currencies are asserted)
// and makes the payouts with the REAL payout code (createPayout, markPayoutPaid, cancelPayout), so the fee rule (an influencer's override,
// the platform default), the hold period and the "refunded since" rule come from lib/payouts.ts, not from this file. It then checks every
// number of the report, the reconciliation identity, and that the report agrees with what the payout screens use
// (postPayoutRefunds, influencerPayoutSummary). The rest needs no database: the range rules, the page wiring and the view rendered
// from fixtures.
//
// The reconciliation identity (per currency, over a range that holds every payment of the fixture):
//   gross - refunds - fees = held + owedToCustomers + notPayable + paidOutNet - toRecover
// With nothing flagged for refund, nothing not payable and nothing refunded after a payout, this is the plan's
//   gross - refunds - fees = held + paid out.
import "dotenv/config";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { after, before, mock, test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { hashPassword } from "../lib/auth/password";
import { hashToken, randomToken } from "../lib/auth/tokens";
import { prisma } from "../lib/db";
import { formatMoney } from "../lib/format";
import { jsonify } from "../lib/jsonify";
import { matchRouteRule } from "../lib/rate-limit/policies";
import { spaRouteById } from "../lib/spa/routes";
import { monthWindow, nextDay } from "../lib/admin/reports";
import { MAX_REPORT_DAYS, parseReportsRange, type AdminReportsView } from "../lib/views/admin-reports";
import { assertNoSecretKeys } from "./helpers/assert-no-secret-keys";
import { fakeNavigate } from "./helpers/fake-navigate";

const skip = process.env.DATABASE_URL && process.env.TOKEN_ENCRYPTION_KEY && process.env.APP_SECRET ? false : "DATABASE_URL / TOKEN_ENCRYPTION_KEY / APP_SECRET not set";
const run = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
const DAY = 86_400_000;
const PASSWORD = "correct-horse-battery-9";
const emailX = `rep-x-${run}@example.com`; // administrator with two-factor
const emailY = `rep-y-${run}@example.com`; // administrator without
const root = path.resolve(__dirname, "..");
const read = (rel: string) => readFileSync(path.join(root, rel), "utf8");
const keys = (o: unknown) => Object.keys(o as object).sort();

/** Two currency codes only this run uses (letters after "XT", which no real currency has but the reserved test code XTS). */
const letter = () => String.fromCharCode(65 + Math.floor(Math.random() * 26));
const C1 = `XT${letter()}`;
let C2 = `XT${letter()}`;
while (C2 === C1) C2 = `XT${letter()}`;

const at = (iso: string) => new Date(iso);

/* ---------- the range rules (no database) ---------- */

test("parseReportsRange: defaults, fall-back for odd input like the earnings page, and a bounded span", () => {
  const now = new Date("2026-10-11T15:00:00Z");
  assert.deepEqual(parseReportsRange({}, now), { ok: true, from: "2026-10-01", to: "2026-10-11" }, "default: the 1st of the month to today (UTC)");
  assert.deepEqual(parseReportsRange({ from: "2026-09-01", to: "2026-09-30" }, now), { ok: true, from: "2026-09-01", to: "2026-09-30" });
  assert.deepEqual(parseReportsRange({ from: "2026-10-05", to: "2026-10-05" }, now), { ok: true, from: "2026-10-05", to: "2026-10-05" }, "one day");
  // Not a real day, wrong shape, outside 2000-2100: ignored, never an error.
  for (const bad of ["2026-02-31", "2026-13-01", "yesterday", "", "2026-1-1", "0000-01-01", "9999-12-31", "1999-12-31", "2026-10-11T00:00:00Z", "<script>", "1e9", "-1"]) {
    assert.deepEqual(parseReportsRange({ from: bad, to: bad }, now), { ok: true, from: "2026-10-01", to: "2026-10-11" }, `from=to=${JSON.stringify(bad)} falls back`);
  }
  assert.deepEqual(parseReportsRange({ from: "nonsense", to: "2026-05-17" }, now), { ok: true, from: "2026-05-01", to: "2026-05-17" }, "a bad start with an earlier end: the 1st of the end's month, not an error");
  assert.deepEqual(parseReportsRange({ from: "2026-03-01", to: "nonsense" }, now), { ok: true, from: "2026-03-01", to: "2026-10-11" });
  assert.deepEqual(parseReportsRange({ from: null, to: undefined }, now), { ok: true, from: "2026-10-01", to: "2026-10-11" });
  // A real but impossible range is refused.
  const backwards = parseReportsRange({ from: "2026-10-10", to: "2026-10-09" }, now);
  assert.equal(backwards.ok, false);
  assert.match(backwards.ok ? "" : backwards.error, /after the end/);
  // 366 days (a leap year) is the longest; 367 is refused.
  assert.deepEqual(parseReportsRange({ from: "2024-01-01", to: "2024-12-31" }, now), { ok: true, from: "2024-01-01", to: "2024-12-31" });
  assert.deepEqual(parseReportsRange({ from: "2025-01-01", to: "2025-12-31" }, now), { ok: true, from: "2025-01-01", to: "2025-12-31" });
  const long = parseReportsRange({ from: "2025-01-01", to: "2026-01-02" }, now);
  assert.equal(long.ok, false);
  assert.match(long.ok ? "" : long.error, new RegExp(String(MAX_REPORT_DAYS)));
  assert.equal(parseReportsRange({ from: "2000-01-01", to: "2100-12-31" }, now).ok, false, "a century is far too long");
  assert.equal(MAX_REPORT_DAYS, 366);
});

test("monthWindow and nextDay: twelve UTC months across a year end, and the day after", () => {
  assert.deepEqual(monthWindow("2024-05"), { start: "2023-06-01", endExclusive: "2024-06-01" });
  assert.deepEqual(monthWindow("2026-01"), { start: "2025-02-01", endExclusive: "2026-02-01" });
  assert.deepEqual(monthWindow("2026-12"), { start: "2026-01-01", endExclusive: "2027-01-01" });
  assert.equal(nextDay("2024-02-28"), "2024-02-29");
  assert.equal(nextDay("2024-02-29"), "2024-03-01");
  assert.equal(nextDay("2026-12-31"), "2027-01-01");
});

/* ---------- fixtures (database) ---------- */

type Handler = (req: Request) => Promise<Response>;
const jar = new Map<string, string>();
let route: Handler;
let sessionLib: typeof import("../lib/admin/session");
let payoutsLib: typeof import("../lib/payouts");
let X = "";
let Y = "";
let infA = ""; // fee override 10%
let infB = ""; // platform default fee (700 bps during this test)
const ids: Record<string, string> = {}; // payment ids by key
const payoutIds: Record<string, string> = {};
const savedEnv: Record<string, string | undefined> = {};
const ENV_NAMES = ["RATE_LIMIT_STORE", "PAYOUT_FOUR_EYES", "PAYOUT_FOUR_EYES_MIN_MINOR", "PLATFORM_FEE_BPS", "PAYOUT_HOLD_DAYS", "ADMIN_REQUIRE_2FA"];

type ReportBody = Record<string, unknown> & {
  from: string;
  to: string;
  generatedAt: string;
  range: { currency: string; [k: string]: unknown }[];
  monthly: { month: string; currency: string; [k: string]: unknown }[];
  balances: { currency: string; [k: string]: unknown }[];
};

async function ask(query = "", cookie?: string): Promise<{ status: number; body: Record<string, unknown>; headers: Headers }> {
  jar.clear();
  if (cookie !== undefined) jar.set(sessionLib.adminCookieName(), cookie);
  const res = await route(new Request(`http://localhost/api/admin/reports${query}`));
  return { status: res.status, body: (await res.json()) as Record<string, unknown>, headers: res.headers };
}

async function passwordOnlySession(adminId: string): Promise<string> {
  const token = randomToken();
  await prisma.adminSession.create({ data: { tokenHash: hashToken(token), adminId, expiresAt: new Date(Date.now() + 3_600_000) } });
  return token;
}

let serial = 0;
async function addPayment(o: {
  influencerId: string;
  serviceId: string;
  key: string;
  amount: number;
  currency: string;
  createdAt: Date;
  booking?: "SCHEDULED" | "COMPLETED" | "CANCELLED" | "PENDING_PAYMENT";
  status?: "CAPTURED" | "REFUNDED" | "CREATED" | "FAILED";
  needsRefund?: boolean;
  refunded?: number;
  refundStatus?: string;
}) {
  // Every session is in 2023: long finished, so the hold period of the payout code never blocks a payment.
  const start = new Date(Date.UTC(2023, 0, 1) + serial++ * DAY);
  const session = await prisma.session.create({ data: { serviceId: o.serviceId, startTime: start, endTime: new Date(start.getTime() + 30 * 60_000) } });
  const booking = await prisma.booking.create({
    data: { sessionId: session.id, status: o.booking ?? "SCHEDULED", customerName: `Rep ${o.key} ${run}`, customerEmail: `rep-${o.key}-${run}@example.com`, whatsappE164: "+919876543210" },
  });
  const payment = await prisma.payment.create({
    data: {
      bookingId: booking.id,
      providerOrderId: `order_${run}_${o.key}`,
      providerPaymentId: o.status === "CREATED" ? null : `pay_${run}_${o.key}`,
      amountMinor: o.amount,
      currency: o.currency,
      status: o.status ?? "CAPTURED",
      needsRefund: o.needsRefund ?? false,
      refundAmountMinor: o.refunded ?? null,
      refundStatus: o.refunded ? (o.refundStatus ?? "processed") : null,
      createdAt: o.createdAt,
    },
  });
  ids[o.key] = payment.id;
  return payment;
}

const refundRow = (key: string, amountMinor: number, status: string, createdAt: Date) =>
  prisma.refund.create({ data: { paymentId: ids[key], providerRefundId: `rfnd_${run}_${key}_${status}`, amountMinor, status, createdAt } });
const reconcile = (...keys: string[]) => prisma.payment.updateMany({ where: { id: { in: keys.map((k) => ids[k]) } }, data: { reconciledAt: new Date() } });

/** Creates a payout with the real code, marks it paid with the real code, then moves its paid time into the fixture's calendar. */
async function paidPayout(name: string, influencerId: string, currency: string, paidAt: Date) {
  const created = await payoutsLib.createPayout(influencerId, currency, "rep-admin@example.com");
  await payoutsLib.markPayoutPaid(created.id, `UTR${run}${name}`, "rep-admin@example.com");
  await prisma.payout.update({ where: { id: created.id }, data: { paidAt } });
  payoutIds[name] = created.id;
  return created;
}

async function seed() {
  const verified = (influencerId: string) =>
    prisma.payoutAccount.create({
      data: { influencerId, accountHolderName: "Rep", bankName: "Test Bank", ifsc: "TEST0000001", accountNumberEnc: "x", accountNumberMasked: "XXXX0001", status: "VERIFIED" },
    });
  infA = (await prisma.influencer.create({ data: { slug: `rep-a-${run}`, name: `Rep A ${run}`, email: `rep-a-${run}@example.com`, platformFeeBps: 1000 } })).id;
  infB = (await prisma.influencer.create({ data: { slug: `rep-b-${run}`, name: `Rep B ${run}`, email: `rep-b-${run}@example.com` } })).id;
  await verified(infA);
  await verified(infB);
  const sA = (await prisma.service.create({ data: { influencerId: infA, title: "A", durationMin: 30, priceMinor: 1000, currency: C1 } })).id;
  const sB = (await prisma.service.create({ data: { influencerId: infB, title: "B", durationMin: 30, priceMinor: 1000, currency: C2 } })).id;
  const a = (key: string, amount: number, createdAt: string, extra: Partial<Parameters<typeof addPayment>[0]> = {}) =>
    addPayment({ influencerId: infA, serviceId: sA, key, amount, currency: C1, createdAt: at(createdAt), ...extra });
  const b = (key: string, amount: number, createdAt: string, extra: Partial<Parameters<typeof addPayment>[0]> = {}) =>
    addPayment({ influencerId: infB, serviceId: sB, key, amount, currency: C2, createdAt: at(createdAt), ...extra });

  // Influencer A, currency C1. Comments give where each ends up.
  await a("p12", 5000, "2024-02-20T10:00:00Z", { booking: "COMPLETED" }); //  payout PO4, paid on the last millisecond of February
  await a("p1", 10000, "2024-03-10T10:00:00Z", { booking: "COMPLETED" }); //  payout PO1
  await a("p6", 3000, "2024-03-15T10:00:00Z", { booking: "COMPLETED" }); //   payout PO1, refunded 1000 AFTER it was paid: to recover
  await a("p13", 1500, "2024-04-25T10:00:00Z", { booking: "COMPLETED" }); //  in a payout that was cancelled: held again
  await a("p5", 8000, "2024-04-15T10:00:00Z", { booking: "COMPLETED" }); //   payout PO2, still pending
  await a("p2", 5000, "2024-03-12T10:00:00Z", { refunded: 2000 }); //          partly refunded, held 3000
  await a("p3", 4000, "2024-04-01T10:00:00Z", { booking: "CANCELLED", status: "REFUNDED", refunded: 4000 }); // fully refunded
  await a("p4", 6000, "2024-04-10T10:00:00Z", { booking: "CANCELLED", needsRefund: true }); // owed to the customer
  await a("p8", 2500, "2024-05-10T10:00:00Z", { booking: "CANCELLED" }); //   cancelled, no refund flagged: not payable
  await a("p9", 7000, "2024-02-29T23:59:59.999Z"); //                           the last millisecond before the range: held
  await a("p10", 1100, "2024-06-01T00:00:00.000Z"); //                         the first millisecond after the range: held
  await a("p14", 1234, "2023-05-31T23:59:59.000Z", { booking: "CANCELLED", status: "REFUNDED", refunded: 1234 }); // before the 12 months
  await a("unpaid", 9999, "2024-04-05T10:00:00Z", { status: "CREATED", booking: "PENDING_PAYMENT" }); // never paid: counted nowhere
  await a("failed", 8888, "2024-04-06T10:00:00Z", { status: "FAILED", booking: "PENDING_PAYMENT" });

  // Influencer B, currency C2 (the platform default fee).
  await b("q1", 1000, "2024-03-05T10:00:00Z"); //                               held
  await b("q2", 2000, "2024-03-06T10:00:00Z", { booking: "COMPLETED" }); //     payout PO5

  // Refund rows (pending and processed count, failed does not).
  await refundRow("p2", 2000, "processed", at("2024-03-20T09:00:00Z"));
  await refundRow("p2", 500, "failed", at("2024-03-21T09:00:00Z"));
  await refundRow("p3", 4000, "processed", at("2024-04-02T09:00:00Z"));
  await refundRow("p14", 1234, "processed", at("2023-05-31T23:59:59.000Z"));

  // Payouts, made by the payout code. Reconciling decides which payments each one takes.
  await reconcile("p12");
  await paidPayout("po4", infA, C1, at("2024-02-29T23:59:59.999Z"));
  await reconcile("p1", "p6");
  await paidPayout("po1", infA, C1, at("2024-04-20T10:00:00Z"));
  await prisma.payment.update({ where: { id: ids.p6 }, data: { refundAmountMinor: 1000, refundStatus: "pending" } });
  await refundRow("p6", 1000, "pending", at("2024-05-02T09:00:00Z"));
  await reconcile("p13");
  const cancelled = await payoutsLib.createPayout(infA, C1, "rep-admin@example.com");
  await payoutsLib.cancelPayout(cancelled.id, "test");
  payoutIds.po3 = cancelled.id;
  await payoutsLib.unreconcilePayment(ids.p13);
  await reconcile("p5");
  payoutIds.po2 = (await payoutsLib.createPayout(infA, C1, "rep-admin@example.com")).id;
  await reconcile("q2");
  await paidPayout("po5", infB, C2, at("2024-05-05T09:00:00Z"));
}

before(async () => {
  for (const name of ENV_NAMES) savedEnv[name] = process.env[name];
  if (skip) return;
  process.env.RATE_LIMIT_STORE = "memory";
  process.env.ADMIN_REQUIRE_2FA = "false";
  process.env.PAYOUT_FOUR_EYES = "false"; // one scripted administrator marks the payouts as paid
  delete process.env.PAYOUT_FOUR_EYES_MIN_MINOR;
  process.env.PLATFORM_FEE_BPS = "700"; // influencer B has no override and pays this
  process.env.PAYOUT_HOLD_DAYS = "2";
  mock.module("next/headers", {
    namedExports: {
      cookies: async () => ({ get: (name: string) => (jar.has(name) ? { name, value: jar.get(name) } : undefined) }),
      headers: async () => new Headers(),
    },
  });
  sessionLib = await import("../lib/admin/session");
  payoutsLib = await import("../lib/payouts");
  route = (await import("../app/api/admin/reports/route")).GET;
  const mfa = await import("../lib/admin/mfa");
  const totp = await import("../lib/admin/totp");
  const hash = await hashPassword(PASSWORD);
  X = (await prisma.adminUser.create({ data: { email: emailX, name: "Rep Admin X", passwordHash: hash } })).id;
  Y = (await prisma.adminUser.create({ data: { email: emailY, name: "Rep Admin Y", passwordHash: hash } })).id;
  const past = Date.now() - 60_000;
  const secret = (await mfa.startTotpEnrollment(X)).secret;
  assert.ok((await mfa.confirmTotpEnrollment(X, totp.totpAt(secret, past), null, past)).ok);
  await seed();
});

after(async () => {
  try {
    if (!skip) {
      // Each step on its own (and tried twice), so a pool timeout in one never leaves the rows of the others behind.
      const slugs = [`rep-a-${run}`, `rep-b-${run}`];
      const steps: [string, () => Promise<unknown>][] = [
        // Payouts restrict the influencer's deletion (their payments let go of them: SET NULL).
        ["payouts", () => prisma.payout.deleteMany({ where: { influencer: { slug: { in: slugs } } } })],
        ["influencers", () => prisma.influencer.deleteMany({ where: { slug: { in: slugs } } })],
        ["admins", () => prisma.adminUser.deleteMany({ where: { email: { in: [emailX, emailY] } } })],
      ];
      for (const [name, step] of steps) {
        for (let attempt = 1; attempt <= 2; attempt++) {
          try {
            await step();
            break;
          } catch (e) {
            if (attempt === 2) console.error(`[admin-reports cleanup] ${name} failed:`, e instanceof Error ? e.message : e);
          }
        }
      }
    }
  } finally {
    for (const [name, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await prisma.$disconnect().catch(() => {});
  }
});

const RANGE = "?from=2024-03-01&to=2024-05-31";
const WIDE = "?from=2024-01-01&to=2024-12-31"; // 366 days: holds every payment of the fixture except the one before the 12 months
async function report(query: string, admin?: string): Promise<ReportBody> {
  const token = admin ?? (await sessionLib.createAdminSession(Y));
  const out = await ask(query, token);
  assert.equal(out.status, 200, query);
  assertNoSecretKeys(out.body);
  return out.body as ReportBody;
}
const forCurrency = <T extends { currency: string }>(rows: T[], currency: string) => rows.filter((r) => r.currency === currency);
const one = <T extends { currency: string }>(rows: T[], currency: string): T => {
  const found = forCurrency(rows, currency);
  assert.equal(found.length, 1, `exactly one row for ${currency}`);
  return found[0];
};

/* ---------- the gate ---------- */

test("401 without an administrator session, 403 enroll / verify, 200 for a signed-in admin; no-store, no CORS, nothing but the report", { skip }, async () => {
  for (const cookie of [undefined, "", "not-a-real-admin-session-token"]) {
    const out = await ask("", cookie);
    assert.equal(out.status, 401, `cookie ${JSON.stringify(cookie)}`);
    assert.deepEqual(keys(out.body), ["error"]);
  }
  const plain = await sessionLib.createAdminSession(Y);
  const stale = await passwordOnlySession(X);
  const verified = await sessionLib.createAdminSession(X, {}, { mfaVerified: true });
  const denied = (out: { status: number; body: Record<string, unknown> }, action: "enroll" | "verify", where: string) => {
    assert.equal(out.status, 403, where);
    assert.equal(out.body.mfaRequired, true, where);
    assert.equal(out.body.mfaAction, action, where);
    assert.deepEqual(keys(out.body), ["error", "mfaAction", "mfaRequired"], `${where}: no figures leak to a denied session`);
  };
  const ok = await ask("", plain);
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get("cache-control"), "private, no-store");
  assert.equal(ok.headers.get("access-control-allow-origin"), null);
  denied(await ask("", stale), "verify", "password-only session of an admin with 2FA");
  process.env.ADMIN_REQUIRE_2FA = "true";
  try {
    denied(await ask("", plain), "enroll", "2FA required, not set up");
    denied(await ask("", stale), "verify", "2FA required, password-only");
    const done = await ask("", verified);
    assert.equal(done.status, 200, "a session that passed the second factor");
    assertNoSecretKeys(done.body);
  } finally {
    process.env.ADMIN_REQUIRE_2FA = "false";
  }
});

test("the endpoint is rate limited by the admin-reports rule", () => {
  assert.equal(matchRouteRule("GET", "/api/admin/reports")?.name, "admin-reports");
});

/* ---------- the numbers ---------- */

test("the range: gross, refunds, net, payouts and fees per currency, with both edges of the range exact and currencies kept apart", { skip }, async () => {
  const body = await report(RANGE);
  assert.deepEqual(keys(body), ["balances", "from", "generatedAt", "monthly", "range", "to"]);
  assert.equal(body.from, "2024-03-01");
  assert.equal(body.to, "2024-05-31");
  assert.ok(!Number.isNaN(Date.parse(body.generatedAt)));
  const KEYS = ["currency", "feesEarnedMinor", "grossMinor", "netMinor", "paymentCount", "payoutsPaidCount", "payoutsPaidNetMinor", "refundCount", "refundsMinor"];

  // C1: p1 10000 + p2 5000 + p6 3000 + p3 4000 + p4 6000 + p5 8000 + p13 1500 + p8 2500. NOT p9 (last ms of Feb), p10 (first ms of June),
  // p12 (February), p14 (2023), the unpaid and the failed one. Refunds: p2 2000 + p3 4000 + p6 1000 (pending counts); the failed 500 does not.
  // Payouts paid in the range: PO1 only (PO4 was paid in February, PO2 is pending, PO3 was cancelled).
  const c1 = one(body.range, C1);
  assert.deepEqual(keys(c1), KEYS);
  assert.deepEqual(c1, { currency: C1, grossMinor: 40000, paymentCount: 8, refundsMinor: 7000, refundCount: 3, netMinor: 33000, payoutsPaidCount: 1, payoutsPaidNetMinor: 11700, feesEarnedMinor: 1300 });
  // C2: q1 1000 + q2 2000; payout PO5: 2000 less the default fee floor(2000 x 700 / 10000) = 140 -> 1860.
  const c2 = one(body.range, C2);
  assert.deepEqual(c2, { currency: C2, grossMinor: 3000, paymentCount: 2, refundsMinor: 0, refundCount: 0, netMinor: 3000, payoutsPaidCount: 1, payoutsPaidNetMinor: 1860, feesEarnedMinor: 140 });
  assert.equal(body.range.filter((r) => r.currency === C1 || r.currency === C2).length, 2, "no row mixes the two");

  // The same fee as the payout code: the stored payout rows are what createPayout() computed with the override / the default.
  const po1 = await prisma.payout.findUniqueOrThrow({ where: { id: payoutIds.po1 } });
  assert.equal(po1.feeBps, 1000);
  assert.equal(po1.feeMinor, payoutsLib.computeFee(13000, 1000));
  const po5 = await prisma.payout.findUniqueOrThrow({ where: { id: payoutIds.po5 } });
  assert.equal(po5.feeBps, payoutsLib.defaultFeeBps());
  assert.equal(po5.feeMinor, payoutsLib.computeFee(2000, 700));

  // The edges, one day at a time: the end day is included, and a day before the first payment shows none of it.
  const feb = one((await report("?from=2024-02-29&to=2024-02-29")).range, C1);
  assert.deepEqual([feb.grossMinor, feb.paymentCount, feb.payoutsPaidCount, feb.feesEarnedMinor, feb.payoutsPaidNetMinor], [7000, 1, 1, 500, 4500], "29 February: p9 (23:59:59.999) and the payout PO4 paid at the same instant");
  const june = one((await report("?from=2024-06-01&to=2024-06-01")).range, C1);
  assert.deepEqual([june.grossMinor, june.paymentCount, june.refundsMinor], [1100, 1, 0], "1 June 00:00:00.000: p10");
  const lastDay = (await report("?from=2024-05-31&to=2024-05-31")).range.filter((r) => r.currency === C1);
  assert.deepEqual(lastDay.map((r) => r.grossMinor), [], "31 May holds nothing of this fixture");
  const empty = await report("?from=2001-01-01&to=2001-01-02");
  assert.deepEqual(forCurrency(empty.range, C1), [], "a range with nothing in it lists no row for the currency");
});

test("the 12 months: per month and currency, newest first, the month before the window left out, months without activity not listed", { skip }, async () => {
  const body = await report(RANGE);
  const months = (cur: string) => forCurrency(body.monthly, cur);
  assert.deepEqual(keys(body.monthly[0]), ["currency", "feesEarnedMinor", "grossMinor", "month", "paymentCount", "refundsMinor"]);
  // Window: June 2023 to May 2024 (the month of `to`). p14 (31 May 2023) is outside; p10 (1 June 2024) is after the last month.
  assert.deepEqual(
    months(C1).map((m) => [m.month, m.grossMinor, m.paymentCount, m.refundsMinor, m.feesEarnedMinor]),
    [
      ["2024-05", 2500, 1, 1000, 0],
      ["2024-04", 19500, 4, 4000, 1300], // p3 4000 + p4 6000 + p5 8000 + p13 1500; PO1 paid on 20 April
      ["2024-03", 18000, 3, 2000, 0],
      ["2024-02", 12000, 2, 0, 500], // p9 7000 (23:59:59.999 on the 29th) + p12 5000; PO4 paid then
    ],
  );
  assert.deepEqual(months(C2).map((m) => [m.month, m.grossMinor, m.paymentCount, m.refundsMinor, m.feesEarnedMinor]), [
    ["2024-05", 0, 0, 0, 140], // only the payout PO5 is dated in May
    ["2024-03", 3000, 2, 0, 0],
  ]);
  assert.ok(new Set(body.monthly.map((m) => m.month)).size <= 12, "never more than twelve months");
  const sorted = [...body.monthly].sort((x, y) => y.month.localeCompare(x.month) || x.currency.localeCompare(y.currency));
  assert.deepEqual(body.monthly, sorted, "newest month first, then currency");
  // The table follows the end of the range: ending in March 2024 it shows April 2023 to March 2024, which now holds p14's month.
  const earlier = await report("?from=2024-03-01&to=2024-03-31");
  assert.deepEqual(forCurrency(earlier.monthly, C1).map((m) => m.month), ["2024-03", "2024-02", "2023-05"], "ending at the month of `to`: April 2023 to March 2024");
  const may2023 = await report("?from=2023-05-01&to=2023-05-31");
  assert.deepEqual(
    forCurrency(may2023.monthly, C1).map((m) => [m.month, m.grossMinor, m.refundsMinor]),
    [["2023-05", 1234, 1234]],
    "a range in May 2023 shows that month (p14 and its refund)",
  );
});

test("the balances right now: held, in pending payouts, owed to customers, to recover, not payable", { skip }, async () => {
  const body = await report(RANGE);
  const b1 = one(body.balances, C1);
  assert.deepEqual(keys(b1), ["currency", "heldForInfluencersMinor", "inPendingPayoutsMinor", "owedToCustomersMinor", "toRecoverMinor", "unallocatedMinor"]);
  // Held (before the fee): p2 3000 (5000 less the 2000 refund) + p5 8000 (its payout is still pending) + p13 1500 (its payout was cancelled)
  // + p9 7000 + p10 1100 = 20600. Not p12, p1, p6 (paid out), p4 (flagged), p8 and p3, p14 (booking cancelled).
  // Pending payouts: PO2 = 8000 less 10% = 7200 (the cancelled PO3 is nothing). Owed: p4 6000. Recover: p6 refunded 1000 after PO1 was paid.
  // Not payable: p8 2500 (cancelled, no refund flagged); p3 and p14 are fully refunded and add 0.
  assert.deepEqual(b1, { currency: C1, heldForInfluencersMinor: 20600, inPendingPayoutsMinor: 7200, owedToCustomersMinor: 6000, toRecoverMinor: 1000, unallocatedMinor: 2500 });
  assert.deepEqual(one(body.balances, C2), { currency: C2, heldForInfluencersMinor: 1000, inPendingPayoutsMinor: 0, owedToCustomersMinor: 0, toRecoverMinor: 0, unallocatedMinor: 0 });
  // The balances do not depend on the range.
  const other = await report("?from=2001-01-01&to=2001-01-02");
  assert.deepEqual(other.balances.filter((r) => r.currency === C1 || r.currency === C2), body.balances.filter((r) => r.currency === C1 || r.currency === C2));
});

test("the report agrees with the payout code: toRecover is the sum of postPayoutRefunds, pending and paid-out amounts are the payout screens'", { skip }, async () => {
  const body = await report(WIDE);
  const paid = await prisma.payout.findMany({ where: { influencerId: { in: [infA, infB] }, status: "PAID" } });
  for (const [currency, expected] of [[C1, 1000], [C2, 0]] as const) {
    let sum = 0;
    for (const p of paid.filter((x) => x.currency === currency)) sum += await payoutsLib.postPayoutRefunds(p.id);
    assert.equal(sum, expected, `${currency}: postPayoutRefunds over the fixture's paid payouts`);
    assert.equal(one(body.balances, currency).toRecoverMinor, sum, `${currency}: the report's To recover equals it`);
  }
  // What the influencer's own payout summary shows for A: the money paid out and the money pending.
  const summary = await payoutsLib.influencerPayoutSummary(infA);
  const inr = summary.currencies.find((c) => c.currency === C1);
  assert.ok(inr);
  assert.equal(inr.pendingMinor, one(body.balances, C1).inPendingPayoutsMinor, "pending payouts");
  assert.equal(inr.paidOutMinor, one(body.range, C1).payoutsPaidNetMinor, "paid out");
  assert.equal(summary.history.filter((h) => h.status === "PAID").reduce((n, h) => n + h.feeMinor, 0), one(body.range, C1).feesEarnedMinor, "fees kept");
  const summaryB = await payoutsLib.influencerPayoutSummary(infB);
  assert.equal(summaryB.currencies.find((c) => c.currency === C2)?.paidOutMinor, one(body.range, C2).payoutsPaidNetMinor);
  // And the payout list's own rows (lib/views/admin-payouts) carry the same net and fee for the same payouts.
  const po1 = await prisma.payout.findUniqueOrThrow({ where: { id: payoutIds.po1 } });
  assert.equal(po1.netMinor + po1.feeMinor, po1.grossMinor - po1.refundsMinor);
});

test("the reconciliation identity: gross - refunds - fees = held + owed + not payable + paid out - to recover (and held + paid out when nothing else is open)", { skip }, async () => {
  const body = await report(WIDE);
  for (const currency of [C1, C2]) {
    const r = one(body.range, currency) as unknown as { grossMinor: number; refundsMinor: number; feesEarnedMinor: number; payoutsPaidNetMinor: number };
    const b = one(body.balances, currency) as unknown as { heldForInfluencersMinor: number; owedToCustomersMinor: number; unallocatedMinor: number; toRecoverMinor: number };
    const left = r.grossMinor - r.refundsMinor - r.feesEarnedMinor;
    const right = b.heldForInfluencersMinor + b.owedToCustomersMinor + b.unallocatedMinor + r.payoutsPaidNetMinor - b.toRecoverMinor;
    assert.equal(left, right, `${currency}: ${left} = ${right}`);
  }
  // C1 in numbers: gross 53100 (the range's 40000 + p9 7000 + p10 1100 + p12 5000), refunds 7000, fees 1800 -> 44300
  //                = held 20600 + owed 6000 + not payable 2500 + paid out 16200 - recover 1000.
  assert.equal(one(body.range, C1).grossMinor, 53100);
  assert.equal(one(body.range, C1).refundsMinor, 7000);
  assert.equal(one(body.range, C1).feesEarnedMinor, 1800);
  assert.equal(one(body.range, C1).payoutsPaidNetMinor, 16200);
  // C2 has nothing flagged, not payable or refunded since: the plan's plain form. 3000 - 0 - 140 = 1000 + 1860.
  const r2 = one(body.range, C2) as unknown as { grossMinor: number; refundsMinor: number; feesEarnedMinor: number; payoutsPaidNetMinor: number };
  const b2 = one(body.balances, C2) as unknown as { heldForInfluencersMinor: number };
  assert.equal(r2.grossMinor - r2.refundsMinor - r2.feesEarnedMinor, b2.heldForInfluencersMinor + r2.payoutsPaidNetMinor);
});

test("a refund moves money from 'owed to customers' to 'refunds' and leaves the balance (the acceptance path of the plan)", { skip }, async () => {
  const first = await report(WIDE);
  const owedBefore = (one(first.balances, C1) as unknown as { owedToCustomersMinor: number }).owedToCustomersMinor;
  assert.equal(owedBefore, 6000);
  // What WP-B's refund does to the rows: a processed refund row, the summary on the payment, status REFUNDED, the flag cleared.
  await refundRow("p4", 6000, "processed", at("2024-05-15T09:00:00Z"));
  await prisma.payment.update({ where: { id: ids.p4 }, data: { status: "REFUNDED", needsRefund: false, refundAmountMinor: 6000, refundStatus: "processed" } });
  const afterRefund = await report(WIDE);
  assert.equal((one(afterRefund.balances, C1) as unknown as { owedToCustomersMinor: number }).owedToCustomersMinor, 0);
  assert.equal(one(afterRefund.range, C1).refundsMinor, 13000, "7000 + 6000");
  const left = (one(afterRefund.range, C1).grossMinor as number) - (one(afterRefund.range, C1).refundsMinor as number) - (one(afterRefund.range, C1).feesEarnedMinor as number);
  const b = one(afterRefund.balances, C1) as unknown as { heldForInfluencersMinor: number; owedToCustomersMinor: number; unallocatedMinor: number; toRecoverMinor: number };
  assert.equal(left, b.heldForInfluencersMinor + b.owedToCustomersMinor + b.unallocatedMinor + (one(afterRefund.range, C1).payoutsPaidNetMinor as number) - b.toRecoverMinor, "the identity still holds");
});

/* ---------- the endpoint ---------- */

test("input: odd dates fall back (200), an impossible range is a 400 with a sentence, and nothing odd is a 500", { skip }, async () => {
  const token = await sessionLib.createAdminSession(Y);
  const today = new Date().toISOString().slice(0, 10);
  for (const q of ["?from=garbage&to=nonsense", "?from=2026-02-31", "?to=%00", "?from=%3Cscript%3E&to=9999-99-99", "?from=1&from=2&to=3", `?from=${"9".repeat(500)}`, "?from=0000-01-01"]) {
    const out = await ask(q, token);
    assert.equal(out.status, 200, q);
    assert.equal(out.body.to, today, `${q}: the end falls back to today`);
    assert.equal(out.body.from, `${today.slice(0, 8)}01`, `${q}: the start falls back to the 1st of the month`);
  }
  assert.equal((await ask("?from=2024-05-01&to=2024-05-31", token)).body.from, "2024-05-01");
  for (const [q, text] of [
    ["?from=2024-05-31&to=2024-05-01", /after the end/],
    ["?from=2020-01-01&to=2024-05-01", /366/],
    ["?from=2024-01-01&to=2025-01-01", /366/],
  ] as const) {
    const out = await ask(q, token);
    assert.equal(out.status, 400, q);
    assert.deepEqual(keys(out.body), ["error"]);
    assert.match(out.body.error as string, text);
    assert.equal(out.headers.get("cache-control"), "private, no-store");
  }
  assert.equal((await ask("?from=2024-01-01&to=2024-12-31", token)).status, 200, "366 days is allowed");
});

test("no response carries anything but aggregates: no ids, e-mail addresses, names or payout details of the fixture", { skip }, async () => {
  const sent = JSON.stringify(await report(WIDE));
  const ids2 = [...Object.values(ids), ...Object.values(payoutIds), infA, infB, X, Y];
  for (const id of ids2) assert.ok(!sent.includes(id), `an id is in the body: ${id}`);
  for (const needle of [`rep-a-${run}`, `rep-b-${run}`, `Rep A ${run}`, `Rep ${"p1"} ${run}`, `UTR${run}`, "rep-admin@example.com", emailX, emailY, "XXXX0001", "Test Bank", `pay_${run}`, `order_${run}`]) {
    assert.ok(!sent.includes(needle), `the body contains ${needle}`);
  }
});

test("the report does not run more than ten queries, one after the other", { skip }, async () => {
  let running = 0;
  let peak = 0;
  let total = 0;
  const original = prisma.$queryRaw;
  // $queryRaw is a tagged template; wrap it to count calls and overlapping calls.
  (prisma as unknown as { $queryRaw: unknown }).$queryRaw = (...args: unknown[]) => {
    running++;
    total++;
    peak = Math.max(peak, running);
    return (original as unknown as (...a: unknown[]) => Promise<unknown>).apply(prisma, args).finally(() => {
      running--;
    });
  };
  try {
    await report(RANGE);
  } finally {
    (prisma as unknown as { $queryRaw: unknown }).$queryRaw = original;
  }
  assert.ok(total >= 1 && total <= 12, `${total} queries`);
  assert.equal(peak, 1, "never two at once");
});

/* ---------- the page (no database) ---------- */

test("the page and the route: the title equals the route table, the endpoint and the view are used, the placeholder is gone", () => {
  const route2 = spaRouteById("admin-reports");
  assert.equal(route2.path, "/admin/reports");
  assert.equal(route2.title, "Reports");
  assert.equal(route2.template, "admin");
  const page = read("web/src/pages/admin/Reports.tsx");
  assert.equal(page.match(/<PageTitle /g)?.length, 1);
  assert.ok(page.includes('<PageTitle title="Reports" template="admin" />'));
  assert.ok(page.includes("/api/admin/reports?"), "reads the endpoint");
  assert.ok(page.includes("ReportsView") && page.includes("QueryGate") && page.includes("keepPreviousData"));
  assert.ok(page.includes("isPlaceholderData"), "busy while the next range loads");
  assert.ok(!page.includes("Coming soon"));
  assert.ok(/export function Component\(\)/.test(page));
  const view = read("web/src/components/views/admin/ReportsView.tsx");
  assert.ok(view.includes("GetForm") && view.includes('role="status"') && view.includes("aria-busy"));
  for (const imp of view.split("\n").filter((l) => /^import /.test(l) && l.includes("@/lib/"))) {
    assert.ok(/^import type /.test(imp) || imp.includes("@/lib/format"), `only type imports (and the pure formatter) from server modules: ${imp}`);
  }
});

type Views = { ReportsView: typeof import("../web/src/components/views/admin/ReportsView").ReportsView; ReportsRangeProblem: typeof import("../web/src/components/views/admin/ReportsView").ReportsRangeProblem };
let viewsLoaded: Promise<Views> | undefined;
function loadViews(): Promise<Views> {
  viewsLoaded ??= (async () => {
    mock.module("@web/lib/navigate", { namedExports: fakeNavigate("/admin/reports") });
    const m = await import("../web/src/components/views/admin/ReportsView");
    return { ReportsView: m.ReportsView, ReportsRangeProblem: m.ReportsRangeProblem };
  })();
  return viewsLoaded;
}
const unHtml = (s: string) => s.replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
const text = (html: string) => unHtml(html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " "));

const fixtureView: AdminReportsView = {
  from: "2026-03-01",
  to: "2026-03-31",
  generatedAt: new Date("2026-04-01T10:00:00Z"),
  range: [
    { currency: "INR", grossMinor: 1_250_000, paymentCount: 5, refundsMinor: 200_000, refundCount: 2, netMinor: 1_050_000, payoutsPaidCount: 1, payoutsPaidNetMinor: 900_000, feesEarnedMinor: 100_000 },
    { currency: "USD", grossMinor: 5000, paymentCount: 1, refundsMinor: 0, refundCount: 0, netMinor: 5000, payoutsPaidCount: 0, payoutsPaidNetMinor: 0, feesEarnedMinor: 0 },
  ],
  monthly: [
    { month: "2026-03", currency: "INR", grossMinor: 1_250_000, refundsMinor: 200_000, feesEarnedMinor: 100_000, paymentCount: 5 },
    { month: "2026-03", currency: "USD", grossMinor: 5000, refundsMinor: 0, feesEarnedMinor: 0, paymentCount: 1 },
    { month: "2026-02", currency: "INR", grossMinor: 40000, refundsMinor: 0, feesEarnedMinor: 0, paymentCount: 1 },
  ],
  balances: [{ currency: "INR", heldForInfluencersMinor: 700_000, inPendingPayoutsMinor: 180_000, owedToCustomersMinor: 50_000, toRecoverMinor: 30_000, unallocatedMinor: 0 }],
};

test("ReportsView: a section per currency, the definitions, a hidden status line, aria-busy only while loading, and the figures as the server gave them", async () => {
  const { ReportsView } = await loadViews();
  const data = jsonify(fixtureView);
  const html = renderToStaticMarkup(createElement(ReportsView, { data }));
  const t = text(html);
  for (const money of [formatMoney(1_250_000, "INR"), formatMoney(200_000, "INR"), formatMoney(1_050_000, "INR"), formatMoney(900_000, "INR"), formatMoney(100_000, "INR"), formatMoney(5000, "USD"), formatMoney(700_000, "INR"), formatMoney(180_000, "INR"), formatMoney(50_000, "INR"), formatMoney(30_000, "INR")]) {
    assert.ok(t.includes(money), `shows ${money}`);
  }
  for (const label of ["Held for influencers", "In pending payouts", "Owed to customers", "To recover", "Gross", "Refunds", "Net of refunds", "Platform fees", "Paid out"]) assert.ok(t.includes(label), label);
  assert.ok(!/<div class="stat"><span class="stat__label">Not payable/.test(html), "no 'Not payable' stat at 0");
  assert.ok(t.includes("Mar 2026") && t.includes("Feb 2026"), "month labels");
  assert.ok(t.includes("before the platform fee") || t.includes("Before the platform fee"));
  assert.ok(t.includes("Flagged payments not yet refunded"));
  assert.equal((html.match(/<form /g) ?? []).length, 1);
  assert.ok(html.includes('name="from"') && html.includes('name="to"') && html.includes('value="2026-03-01"') && html.includes('value="2026-03-31"'));
  const status = /<p role="status" class="sr-only">([^<]*)<\/p>/.exec(html);
  assert.ok(status, "a hidden status line");
  assert.match(unHtml(status[1]), /^From 2026-03-01 to 2026-03-31: INR gross .*; USD gross /);
  assert.ok(!/aria-busy="true"/.test(html));
  const busy = renderToStaticMarkup(createElement(ReportsView, { data, busy: true }));
  assert.ok(/aria-busy="true"/.test(busy));
  assert.match(unHtml(/<p role="status" class="sr-only">([^<]*)<\/p>/.exec(busy)![1]), /^Loading/);
  // A currency's "Not payable" shows when it has money, and a negative net is shown, not hidden.
  const odd = jsonify({ ...fixtureView, balances: [{ ...fixtureView.balances[0], unallocatedMinor: 2500 }], range: [{ ...fixtureView.range[0], netMinor: -1000 }] });
  const oddText = text(renderToStaticMarkup(createElement(ReportsView, { data: odd })));
  assert.ok(oddText.includes(formatMoney(2500, "INR")) && oddText.includes(formatMoney(-1000, "INR")));
});

test("ReportsView: empty range, nothing at all, and the refused-range message keep the form", async () => {
  const { ReportsView, ReportsRangeProblem } = await loadViews();
  const none = renderToStaticMarkup(createElement(ReportsView, { data: jsonify({ ...fixtureView, range: [], monthly: [], balances: [] }) }));
  assert.ok(text(none).includes("Nothing to report"));
  assert.match(unHtml(/<p role="status" class="sr-only">([^<]*)<\/p>/.exec(none)![1]), /^No payments, refunds or payouts from 2026-03-01 to 2026-03-31\.$/);
  assert.equal((none.match(/<form /g) ?? []).length, 1, "the form stays");
  const quiet = text(renderToStaticMarkup(createElement(ReportsView, { data: jsonify({ ...fixtureView, range: [], monthly: [] }) })));
  assert.ok(quiet.includes("No payments, refunds or payouts in this range.") && quiet.includes(formatMoney(700_000, "INR")), "balances still show");
  const problem = renderToStaticMarkup(createElement(ReportsRangeProblem, { from: "2024-05-31", to: "2024-05-01", message: "The start date is after the end date." }));
  assert.ok(text(problem).includes("The start date is after the end date.") && problem.includes('role="alert"') && problem.includes('value="2024-05-31"'));
  const hostile = renderToStaticMarkup(createElement(ReportsView, { data: jsonify({ ...fixtureView, range: [{ ...fixtureView.range[0], currency: '"><script>alert(1)</script>' }] }) }));
  assert.ok(!hostile.includes("<script>alert(1)"), "a currency code is escaped");
});
