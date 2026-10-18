// The admin Money ledger: GET /api/admin/money, lib/admin/money.ts, lib/views/admin-money.ts and the `money` CSV export.
//
// The pure part (the filter, the masking, the statuses, the query rules) needs no database. The database part (needs DATABASE_URL,
// TOKEN_ENCRYPTION_KEY, APP_SECRET; skipped otherwise) calls the real route handlers with only `next/headers` replaced and pins: the gate
// (401, 403 enroll, 403 verify, 200), the exact DTO keys and assertNoSecretKeys (no full Razorpay id, no UTR, no customer contact data),
// the range rules, the type and influencer filters, the order and the pages, the totals AGREEING with the Reports page for the same range,
// the IST day boundaries (18:30 UTC), the influencer summary, and the CSV (audited, neutralised, capped).
//
// Rows sit on quiet days far in the future (2060+) in currencies only this run uses, so other people's data never mixes into the rows or
// the figures: the Reports figures and the balances are per currency, and the database is shared.
//
// The fixture, in currency C1 on the IST day D0 (all times are offsets from 00:00 IST of D0; H = one hour, DAY = one day):
//   influencer A (formula-looking names): payments pA0 1 000 at 0 (the very first instant of D0), pA1 100 000 at 10H (in the PAID payout),
//     pA2 50 000 at 11H (flagged for a refund, customer erased), pA3 30 000 REFUNDED at 12H, pA4 9 000 CREATED at 9H (never a movement),
//     pA5a 7 000 at -1 ms (D-1) and pA5b 8 000 at DAY (D+1).
//     refunds r1 30 000 processed 13H, r2 5 000 pending 14H, r3 4 000 FAILED 15H, r5 2 000 processed at DAY-1 ms (the last ms of D0),
//     r4 1 000 at -1 ms (D-1) and r6 3 000 at DAY (D+1).
//     payouts payout1 PAID net 89 550 fee 10 500 at 16H, payout2 PENDING 5 000, payout3 PENDING 7 000 approved, payout4 CANCELLED,
//     payout5 PAID 3 000 at DAY (D+1), payout6 PAID 1 111 at -1 ms (D-1).
//   influencer B: payment pB1 20 000 at 10.5H, payout PAID net 10 000 fee 1 000 at 19H.
//   influencer C (currency C2): 52 payments on another day, to see two pages. Influencer D (C2): 52 PAID payouts (more than the 50 the
//   payout summary used to read). Influencer E: nothing at all.
// Expected for A on D0: money in 181 000 (4 payments), refunds out 37 000 (3: r1, r2, r5; the failed r3 and the other days' do not count),
// payouts out 89 550 (1) with fee 10 500, still held 16 000 (pA0, pA5a, pA5b: not flagged, not in a sent payout, booking scheduled).
import "dotenv/config";
import assert from "node:assert/strict";
import { after, before, mock, test } from "node:test";
import { hashPassword } from "../lib/auth/password";
import { hashToken, randomToken } from "../lib/auth/tokens";
import { prisma } from "../lib/db";
import { istDate, istIso } from "../lib/india";
import type { Jsonify } from "../lib/jsonify";
import { countMovements, KINDS_OF_TYPE, MONEY_PAGE_SIZE, MONEY_TYPES, maskTail, movementDirection, movementStatus, parseMoneyType, readMovements, type MovementRecord } from "../lib/admin/money";
import { ExportTooLargeError, parseMoneyExportOptions } from "../lib/admin/exports";
import { influencerPayoutSummary } from "../lib/payouts";
import { parseMoneyQuery, toMoneyRow, type AdminMoneyView } from "../lib/views/admin-money";
import { balanceFigures, rangeFigures } from "../lib/admin/reports";
import { loadAdminReportsView } from "../lib/views/admin-reports";
import { assertNoSecretKeys } from "./helpers/assert-no-secret-keys";

const skip = process.env.DATABASE_URL && process.env.TOKEN_ENCRYPTION_KEY && process.env.APP_SECRET ? false : "DATABASE_URL / TOKEN_ENCRYPTION_KEY / APP_SECRET not set";
const run = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
const PASSWORD = "correct-horse-battery-9";
const emailX = `ledger-x-${run}@example.com`; // administrator with two-factor
const emailY = `ledger-y-${run}@example.com`; // administrator without
const slugBase = `ledger-${run}`;
const DAY = 86_400_000;
const H = 3_600_000;

/**
 * Currencies only this run uses: three letters derived from the clock, so a leftover of a crashed run never shares one. `currency` is free
 * text in the schema. C1 holds the main fixture, C2 the paging and the many payouts.
 */
const code = (n: number) => [Math.floor(n / 676) % 26, Math.floor(n / 26) % 26, n % 26].map((d) => String.fromCharCode(65 + d)).join("");
const seconds = Math.floor(Date.now() / 1000);
const [C1, C2] = [code(seconds), code(seconds + 8843)];

// `quiet` is the instant at which the IST day D0 BEGINS (18:30 UTC the evening before), in 2060 or later.
const n0 = Number(run.slice(-6));
const quiet = new Date(Date.UTC(2060 + (n0 % 35), n0 % 12, 1 + (n0 % 27)) - 330 * 60_000);
const at = (offsetMs: number) => new Date(quiet.getTime() + offsetMs);
const FROM = istDate(quiet);
const PREV = istDate(at(-DAY));
const NEXT = istDate(at(DAY));
const PAGER_DAY = istDate(at(3 * DAY));
const MANY_DAY = istDate(at(6 * DAY));

const keys = (o: unknown) => Object.keys(o as object).sort();
type View = Jsonify<AdminMoneyView>;
type Handler = (req: Request) => Promise<Response>;
type ExportHandler = (req: Request, ctx: { params: Promise<{ kind: string }> }) => Promise<Response>;
const jar = new Map<string, string>();
let GET: Handler;
let EXPORT: ExportHandler;
let PAYOUTS: Handler;
let sessionLib: typeof import("../lib/admin/session");
let exportsLib: typeof import("../lib/admin/exports");
let X = "";
let Y = "";
const infIds: Record<"a" | "b" | "c" | "d" | "e", string> = { a: "", b: "", c: "", d: "", e: "" };
/** Ids of the fixture's payments, refunds and payouts by the short names of the header comment. */
const id: Record<string, string> = {};
const savedEnv: Record<string, string | undefined> = {};
const ENV_NAMES = ["RATE_LIMIT_STORE", "REDIS_URL", "ADMIN_REQUIRE_2FA"];
const hidden: string[] = [];
const secret = (label: string) => {
  const value = `hidden-${label}-${run}`;
  hidden.push(value);
  return value;
};
let capOverride: number | undefined;

/* ---------- pure rules (no database) ---------- */

test("the types, the kinds each shows, and the filter's defaults", () => {
  assert.deepEqual([...MONEY_TYPES], ["all", "in", "out", "refunds", "payouts"]);
  assert.deepEqual(KINDS_OF_TYPE.all, ["payment", "refund", "payout"]);
  assert.deepEqual(KINDS_OF_TYPE.in, ["payment"]);
  assert.deepEqual(KINDS_OF_TYPE.out, ["refund", "payout"]);
  assert.deepEqual(KINDS_OF_TYPE.refunds, ["refund"]);
  assert.deepEqual(KINDS_OF_TYPE.payouts, ["payout"]);
  for (const t of MONEY_TYPES) assert.equal(parseMoneyType(t), t);
  for (const odd of [null, undefined, "", "ALL", "money", "payments", "in ", "__proto__", "constructor"]) assert.equal(parseMoneyType(odd), "all", String(odd));
  assert.equal(MONEY_PAGE_SIZE, 50);
});

test("maskTail shows four characters of a long reference and nothing of a short one", () => {
  assert.equal(maskTail("pay_QWERTY12345678"), "****5678");
  assert.equal(maskTail("123456789012"), "****9012");
  assert.equal(maskTail("12345678"), "****5678", "eight characters is the shortest that shows a tail");
  assert.equal(maskTail("1234567"), "****", "seven characters: nothing of it");
  assert.equal(maskTail("abc"), "****");
  assert.equal(maskTail(""), null);
  assert.equal(maskTail(null), null);
  assert.equal(maskTail(undefined), null);
  assert.ok(!maskTail("pay_QWERTY12345678")!.includes("QWERTY"));
});

test("movementStatus and movementDirection: a payment is paid, refunded or flagged; a refund keeps its status; a payout is paid", () => {
  assert.equal(movementStatus({ kind: "payment", rawStatus: "CAPTURED", needsRefund: false }), "paid");
  assert.equal(movementStatus({ kind: "payment", rawStatus: "CAPTURED", needsRefund: true }), "flagged");
  assert.equal(movementStatus({ kind: "payment", rawStatus: "REFUNDED", needsRefund: false }), "refunded");
  assert.equal(movementStatus({ kind: "payment", rawStatus: "REFUNDED", needsRefund: true }), "refunded", "a refunded payment is no longer owed a refund");
  for (const s of ["pending", "processed", "failed"]) assert.equal(movementStatus({ kind: "refund", rawStatus: s, needsRefund: false }), s);
  assert.equal(movementStatus({ kind: "payout", rawStatus: "PAID", needsRefund: false }), "paid");
  assert.equal(movementDirection("payment"), "in");
  assert.equal(movementDirection("refund"), "out");
  assert.equal(movementDirection("payout"), "out");
});

test("parseMoneyQuery: the dates follow the Reports rules, an odd type is `all`, a malformed influencer id is refused, the page is bounded", () => {
  const now = new Date("2026-10-11T15:00:00Z");
  const ok = (p: Parameters<typeof parseMoneyQuery>[0]) => {
    const q = parseMoneyQuery(p, now);
    assert.ok(q.ok, JSON.stringify(p));
    return q;
  };
  const bad = (p: Parameters<typeof parseMoneyQuery>[0]) => {
    const q = parseMoneyQuery(p, now);
    assert.ok(!q.ok, JSON.stringify(p));
    return q.error;
  };
  assert.deepEqual(ok({}), { ok: true, filter: { from: "2026-10-01", to: "2026-10-11", type: "all", influencerId: null }, page: 1 });
  assert.deepEqual(ok({ from: "2026-09-01", to: "2026-09-30", type: "out", influencerId: "abc_DEF-123", page: "3" }), {
    ok: true,
    filter: { from: "2026-09-01", to: "2026-09-30", type: "out", influencerId: "abc_DEF-123" },
    page: 3,
  });
  // Dates: not a real day, wrong shape, outside 2000-2100: ignored (the default), exactly like the Reports page.
  for (const odd of ["2026-02-31", "2026-13-01", "yesterday", "", "0000-01-01", "9999-12-31", "<script>"]) {
    const q = ok({ from: odd, to: odd });
    assert.deepEqual(q.ok && [q.filter.from, q.filter.to], ["2026-10-01", "2026-10-11"], odd);
  }
  assert.match(bad({ from: "2026-10-12", to: "2026-10-11" }), /after the end/);
  assert.match(bad({ from: "2025-01-01", to: "2026-01-02" }), /366/);
  assert.equal(ok({ from: "2024-01-01", to: "2024-12-31" }).ok, true, "366 days");
  // Type.
  for (const odd of ["zzz", "ALL", "", "in;drop", "money"]) assert.equal(ok({ type: odd }).ok && ok({ type: odd }).filter.type, "all", odd);
  // Influencer: empty is everybody, trimmed, shape-checked.
  assert.equal(ok({ influencerId: "" }).ok && ok({ influencerId: "" }).filter.influencerId, null);
  assert.equal(ok({ influencerId: "  abc  " }).ok && ok({ influencerId: "  abc  " }).filter.influencerId, "abc");
  for (const odd of ["<script>", "a b", "a/b", "a;b", "'; DROP TABLE x;--", "a".repeat(65), "é", "%00", "a\u0000b"]) assert.match(bad({ influencerId: odd }), /influencer is not valid/, odd);
  assert.equal(ok({ influencerId: "a".repeat(64) }).ok, true, "64 characters is the longest id");
  // Page: a whole number from 1 to 9999, else 1.
  for (const [p, want] of [["1", 1], ["2", 2], ["9999", 9999], ["0", 1], ["-1", 1], ["2.5", 2], ["abc", 1], ["10000", 1], ["1e9", 1], ["", 1], [null, 1], [undefined, 1]] as const) {
    assert.equal(ok({ page: p }).ok && ok({ page: p }).page, want, String(p));
  }
});

test("parseMoneyExportOptions: the same type and influencer rules as the page", () => {
  const ok = (qs: string) => {
    const r = parseMoneyExportOptions(new URLSearchParams(qs));
    assert.ok(r.ok, qs);
    return r.options;
  };
  assert.deepEqual(ok(""), { type: "all", influencerId: null });
  assert.deepEqual(ok("type=refunds&influencerId=abc123"), { type: "refunds", influencerId: "abc123" });
  assert.deepEqual(ok("type=nonsense&influencerId="), { type: "all", influencerId: null });
  for (const odd of ["<x>", "a b", "a".repeat(65), "'--"]) {
    const r = parseMoneyExportOptions(new URLSearchParams({ influencerId: odd }));
    assert.ok(!r.ok, odd);
    assert.match(r.ok ? "" : r.error, /influencer is not valid/);
  }
});

test("toMoneyRow: field by field, references masked, the payment's payout id and the bank reference never travel in full", () => {
  const base: MovementRecord = {
    kind: "payment", id: "p1", at: new Date("2026-10-01T10:00:00Z"), amountMinor: 1000, feeMinor: null, currency: "INR", rawStatus: "CAPTURED", needsRefund: false,
    influencerId: "i1", influencerSlug: "slug", influencerName: "Ina", serviceTitle: "Call", customerName: "Cust", bookingId: "b1", paymentId: "p1", payoutId: "po1",
    providerPaymentId: "pay_SECRETSECRET12", providerRefundId: null, utr: null, destination: null, approvedBy: null, paidBy: null,
  };
  const payment = toMoneyRow(base);
  assert.deepEqual(keys(payment), ["amountMinor", "approvedBy", "at", "bookingId", "currency", "customerName", "destination", "direction", "feeMinor", "influencer", "key", "kind", "paidBy", "payoutId", "referenceTail", "serviceTitle", "status"]);
  assert.equal(payment.key, "payment:p1");
  assert.equal(payment.direction, "in");
  assert.equal(payment.referenceTail, "****ET12");
  assert.equal(payment.payoutId, null, "the payout a payment sits in is not a payout row's link");
  assert.ok(!JSON.stringify(payment).includes("SECRETSECRET"));
  const payout = toMoneyRow({ ...base, kind: "payout", id: "po9", feeMinor: 100, rawStatus: "PAID", providerPaymentId: null, utr: "UTR123456789012", destination: "UPI ****1234", approvedBy: "a@x.com", paidBy: "b@x.com", payoutId: "po9", bookingId: null, serviceTitle: null, customerName: null });
  assert.equal(payout.key, "payout:po9");
  assert.equal(payout.direction, "out");
  assert.equal(payout.referenceTail, "****9012");
  assert.equal(payout.payoutId, "po9");
  assert.ok(!JSON.stringify(payout).includes("UTR123456789012"));
});

/* ---------- fixtures (database) ---------- */

async function passwordOnlySession(adminId: string): Promise<string> {
  const token = randomToken();
  await prisma.adminSession.create({ data: { tokenHash: hashToken(token), adminId, expiresAt: new Date(Date.now() + 3_600_000) } });
  return token;
}

async function ask(query = "", cookie?: string) {
  jar.clear();
  if (cookie !== undefined) jar.set(sessionLib.adminCookieName(), cookie);
  const res = await GET(new Request(`http://localhost/api/admin/money${query}`));
  return { res, status: res.status, headers: res.headers, text: await res.text() };
}
/** GET /api/admin/money, which must answer 200, as the parsed DTO. */
async function view(query: string, token: string): Promise<View> {
  const out = await ask(query, token);
  assert.equal(out.status, 200, `${query}: ${out.text.slice(0, 200)}`);
  return JSON.parse(out.text) as View;
}
const day = (from = FROM, to = FROM) => `from=${from}&to=${to}`;

async function askExport(kind: string, query: string, cookie?: string) {
  jar.clear();
  if (cookie !== undefined) jar.set(sessionLib.adminCookieName(), cookie);
  return EXPORT(new Request(`http://localhost/api/admin/exports/${kind}${query}`), { params: Promise.resolve({ kind }) });
}

/** A minimal RFC 4180 reader: rows of cells. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") {
      row.push(cell);
      cell = "";
    } else if (c === "\r" && text[i + 1] === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
      i++;
    } else cell += c;
  }
  assert.equal(quoted, false, "no unterminated quote");
  return rows;
}

let sessionSeq = 0;
async function seed() {
  const mk = (suffix: keyof typeof infIds, name: string) => prisma.influencer.create({ data: { slug: `${slugBase}-${suffix}`, name, email: `${slugBase}-${suffix}@example.com` } });
  for (const [suffix, name] of [["a", `=Ledger Owner A ${run}`], ["b", `Ledger Owner B ${run}`], ["c", `Ledger Pager ${run}`], ["d", `Ledger Many ${run}`], ["e", `Ledger Empty ${run}`]] as const) {
    infIds[suffix] = (await mk(suffix, name)).id;
  }
  const svc = (influencerId: string, title: string, currency: string) => prisma.service.create({ data: { influencerId, title, durationMin: 30, priceMinor: 1000, currency } });
  const sA = await svc(infIds.a, `+Ledger call ${run}`, C1);
  const sB = await svc(infIds.b, `Ledger call B ${run}`, C1);

  const booking = async (serviceId: string, key: string, status: string, extra: Record<string, unknown> = {}) => {
    const start = new Date(quiet.getTime() + 40 * DAY + sessionSeq++ * 60_000);
    const session = await prisma.session.create({ data: { serviceId, startTime: start, endTime: new Date(start.getTime() + 30 * 60_000) } });
    return prisma.booking.create({
      data: {
        sessionId: session.id,
        status: status as never,
        customerName: `@Customer ${key} ${run}`,
        customerEmail: `${secret(`email-${key}`)}@example.com`,
        whatsappE164: `+91${secret(`phone-${key}`)}`,
        meetLink: `https://meet.google.com/${secret(`meet-${key}`)}`,
        eventId: secret(`event-${key}`),
        lastError: secret(`error-${key}`),
        declineReason: secret(`decline-${key}`),
        intakeAnswers: [{ id: "q1", label: "Question", answer: secret(`intake-${key}`) }],
        ...extra,
      },
    });
  };
  const pay = async (bookingId: string, key: string, amountMinor: number, createdAt: Date, extra: Record<string, unknown> = {}) => {
    const p = await prisma.payment.create({
      data: {
        bookingId,
        createdAt,
        providerOrderId: `order_${run}_${key}`,
        providerPaymentId: `pay_${run}_${key}`,
        amountMinor,
        currency: C1,
        status: "CAPTURED",
        failureReason: secret(`failure-${key}`),
        recoveryError: secret(`recovery-${key}`),
        ...extra,
      },
    });
    id[key] = p.id;
    return p;
  };
  const refund = async (key: string, paymentKey: string, amountMinor: number, status: string, createdAt: Date) => {
    const r = await prisma.refund.create({ data: { paymentId: id[paymentKey], providerRefundId: `rfnd_${run}_${key}`, amountMinor, status, createdAt } });
    id[key] = r.id;
  };
  const payout = async (key: string, influencerId: string, status: "PENDING" | "PAID" | "CANCELLED", netMinor: number, feeMinor: number, createdAt: Date, extra: Record<string, unknown> = {}) => {
    const p = await prisma.payout.create({
      data: { influencerId, currency: C1, status, grossMinor: netMinor + feeMinor, refundsMinor: 0, feeBps: 1000, feeMinor, netMinor, paymentCount: 1, destination: "UPI ****1234", createdByEmail: emailY, createdAt, note: secret(`payout-note-${key}`), ...extra },
    });
    id[key] = p.id;
  };
  const paid = (paidAt: Date, reference: string) => ({ paidAt, reference, paidByEmail: emailX, approvedAt: paidAt, approvedByEmail: emailX });

  // Payouts first, so the payment sitting in a sent payout can point at it.
  await payout("payout1", infIds.a, "PAID", 89_550, 10_500, at(15.5 * H), paid(at(16 * H), `UTR${run}0001`));
  await payout("payout2", infIds.a, "PENDING", 5_000, 500, at(17 * H));
  await payout("payout3", infIds.a, "PENDING", 7_000, 700, at(18 * H), { approvedAt: at(18.5 * H), approvedByEmail: emailX });
  await payout("payout4", infIds.a, "CANCELLED", 9_999, 999, at(19 * H));
  await payout("payout5", infIds.a, "PAID", 3_000, 300, at(DAY - H), paid(at(DAY), `UTR${run}0005`));
  await payout("payout6", infIds.a, "PAID", 1_111, 111, at(-2 * H), paid(at(-1), `UTR${run}0006`));
  await payout("payoutB", infIds.b, "PAID", 10_000, 1_000, at(18 * H), paid(at(19 * H), `UTR${run}00B1`));

  const bA0 = await booking(sA.id, "a0", "SCHEDULED");
  await pay(bA0.id, "pA0", 1_000, at(0));
  const bA1 = await booking(sA.id, "a1", "COMPLETED");
  await pay(bA1.id, "pA1", 100_000, at(10 * H), { payoutId: id.payout1, reconciledAt: at(10 * H), refundAmountMinor: 7_000, refundStatus: "processed" });
  const bA2 = await booking(sA.id, "a2", "SCHEDULED", { redactedAt: new Date(), customerName: "Erased customer", customerEmail: `erased-${run}@invalid.invalid`, whatsappE164: "", lastError: null, intakeAnswers: undefined });
  await pay(bA2.id, "pA2", 50_000, at(11 * H), { needsRefund: true });
  const bA3 = await booking(sA.id, "a3", "CANCELLED");
  await pay(bA3.id, "pA3", 30_000, at(12 * H), { status: "REFUNDED", refundAmountMinor: 30_000, refundStatus: "processed" });
  const bA4 = await booking(sA.id, "a4", "PENDING_PAYMENT");
  await pay(bA4.id, "pA4", 9_000, at(9 * H), { status: "CREATED" });
  const bA5a = await booking(sA.id, "a5a", "SCHEDULED");
  await pay(bA5a.id, "pA5a", 7_000, at(-1));
  const bA5b = await booking(sA.id, "a5b", "SCHEDULED");
  await pay(bA5b.id, "pA5b", 8_000, at(DAY));
  await refund("r1", "pA3", 30_000, "processed", at(13 * H));
  await refund("r2", "pA1", 5_000, "pending", at(14 * H));
  await refund("r3", "pA2", 4_000, "failed", at(15 * H));
  await refund("r4", "pA5a", 1_000, "processed", at(-1));
  await refund("r5", "pA1", 2_000, "processed", at(DAY - 1));
  await refund("r6", "pA5b", 3_000, "processed", at(DAY));

  const bB1 = await booking(sB.id, "b1", "SCHEDULED");
  await pay(bB1.id, "pB1", 20_000, at(10.5 * H));

  // Influencer C: 52 payments of the second currency in one day (two pages). Explicit ids so three createMany calls do it.
  const sC = await svc(infIds.c, `Ledger pager call ${run}`, C2);
  const pagerStart = at(3 * DAY);
  const rowsOf = <T>(f: (i: number) => T) => Array.from({ length: 52 }, (_, i) => f(i));
  await prisma.session.createMany({ data: rowsOf((i) => ({ id: `pgs_${run}_${i}`, serviceId: sC.id, startTime: new Date(quiet.getTime() + 50 * DAY + i * 60_000), endTime: new Date(quiet.getTime() + 50 * DAY + i * 60_000 + 30 * 60_000) })) });
  await prisma.booking.createMany({ data: rowsOf((i) => ({ id: `pgb_${run}_${i}`, sessionId: `pgs_${run}_${i}`, status: "SCHEDULED" as const, customerName: `Pager ${i} ${run}`, customerEmail: `pager-${i}-${run}@example.com`, whatsappE164: "+910000000000" })) });
  await prisma.payment.createMany({
    data: rowsOf((i) => ({ id: `pgp_${run}_${i}`, bookingId: `pgb_${run}_${i}`, providerOrderId: `order_${run}_pg${i}`, providerPaymentId: `pay_${run}_pg${i}`, amountMinor: 100 + i, currency: C2, status: "CAPTURED" as const, createdAt: new Date(pagerStart.getTime() + i * 60_000) })),
  });

  // Influencer D: 52 PAID payouts of 1 000 each.
  const manyStart = at(6 * DAY);
  await prisma.payout.createMany({
    data: rowsOf((i) => ({
      influencerId: infIds.d, currency: C2, status: "PAID" as const, grossMinor: 1_100, refundsMinor: 0, feeBps: 1000, feeMinor: 100, netMinor: 1_000, paymentCount: 1, destination: "UPI ****9999",
      createdByEmail: emailY, createdAt: new Date(manyStart.getTime() + i * 60_000), paidAt: new Date(manyStart.getTime() + i * 60_000), paidByEmail: emailX, reference: `UTR${run}M${String(i).padStart(2, "0")}`,
    })),
  });
}

before(async () => {
  for (const name of ENV_NAMES) savedEnv[name] = process.env[name];
  if (skip) return;
  process.env.RATE_LIMIT_STORE = "memory";
  delete process.env.REDIS_URL;
  process.env.ADMIN_REQUIRE_2FA = "false";
  mock.module("next/headers", {
    namedExports: {
      cookies: async () => ({ get: (name: string) => (jar.has(name) ? { name, value: jar.get(name) } : undefined) }),
      headers: async () => new Headers(),
    },
  });
  sessionLib = await import("../lib/admin/session");
  exportsLib = await import("../lib/admin/exports");
  // The export route gets the real exports module, except that the row cap can be lowered from the test (the money options are kept).
  mock.module("@/lib/admin/exports", {
    namedExports: { ...exportsLib, buildExport: (kind: never, r: never, o: object = {}) => exportsLib.buildExport(kind, r, capOverride === undefined ? o : { ...o, rowCap: capOverride }) },
  });
  GET = (await import("../app/api/admin/money/route")).GET as Handler;
  EXPORT = (await import("../app/api/admin/exports/[kind]/route")).GET as ExportHandler;
  PAYOUTS = (await import("../app/api/admin/payouts/route")).GET as Handler;

  const hash = await hashPassword(PASSWORD);
  X = (await prisma.adminUser.create({ data: { email: emailX, name: "Ledger Admin X", passwordHash: hash } })).id;
  Y = (await prisma.adminUser.create({ data: { email: emailY, name: "Ledger Admin Y", passwordHash: hash } })).id;
  const mfa = await import("../lib/admin/mfa");
  const totp = await import("../lib/admin/totp");
  const past = Date.now() - 60_000;
  const s = (await mfa.startTotpEnrollment(X)).secret;
  assert.ok((await mfa.confirmTotpEnrollment(X, totp.totpAt(s, past), null, past)).ok);
  await seed();
});

after(async () => {
  try {
    if (!skip) {
      const steps: [string, () => Promise<unknown>][] = [
        ["payouts", () => prisma.payout.deleteMany({ where: { influencer: { slug: { startsWith: slugBase } } } })],
        ["influencers", () => prisma.influencer.deleteMany({ where: { slug: { startsWith: slugBase } } })],
        ["audit", () => prisma.adminAuditLog.deleteMany({ where: { adminEmail: { in: [emailX, emailY] } } })],
        ["admins", () => prisma.adminUser.deleteMany({ where: { email: { in: [emailX, emailY] } } })],
      ];
      for (const [name, step] of steps) {
        for (let attempt = 1; attempt <= 2; attempt++) {
          try {
            await step();
            break;
          } catch (e) {
            if (attempt === 2) console.error(`[admin-money-ledger cleanup] ${name} failed:`, e instanceof Error ? e.message : e);
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

/* ---------- the gate ---------- */

test("GET /api/admin/money: 401 signed out, 403 enroll / verify, 200 for an admin who may; only an error sentence leaks to a denied caller", { skip }, async () => {
  const plain = await sessionLib.createAdminSession(Y);
  const stale = await passwordOnlySession(X);
  const verified = await sessionLib.createAdminSession(X, {}, { mfaVerified: true });
  const denied = async (out: Awaited<ReturnType<typeof ask>>, action: "enroll" | "verify", where: string) => {
    assert.equal(out.status, 403, where);
    const body = JSON.parse(out.text) as Record<string, unknown>;
    assert.equal(body.mfaRequired, true, where);
    assert.equal(body.mfaAction, action, where);
    assert.deepEqual(keys(body), ["error", "mfaAction", "mfaRequired"], `${where}: nothing of the ledger leaks to a denied session`);
  };
  for (const cookie of [undefined, "", "not-a-real-admin-session-token"]) {
    const out = await ask(`?${day()}`, cookie);
    assert.equal(out.status, 401, JSON.stringify(cookie));
    assert.deepEqual(keys(JSON.parse(out.text)), ["error"]);
  }
  await denied(await ask(`?${day()}`, stale), "verify", "password-only session of a 2FA admin");
  const good = await ask(`?${day()}`, plain);
  assert.equal(good.status, 200, "an admin without 2FA required");
  assert.equal(good.headers.get("cache-control"), "private, no-store");
  assert.equal(good.headers.get("access-control-allow-origin"), null, "no CORS header");
  process.env.ADMIN_REQUIRE_2FA = "true";
  try {
    await denied(await ask(`?${day()}`, plain), "enroll", "must enrol");
    await denied(await ask(`?${day()}`, stale), "verify", "password-only session, 2FA required");
    assert.equal((await ask(`?${day()}`, verified)).status, 200, "a session that passed the second factor");
  } finally {
    process.env.ADMIN_REQUIRE_2FA = "false";
  }
});

/* ---------- the DTO ---------- */

const TOP_KEYS = ["counts", "from", "generatedAt", "influencer", "influencerId", "influencerUnknown", "influencers", "page", "pageCount", "pageSize", "rows", "scheduled", "summary", "to", "total", "totals", "type"].sort();
const ROW_KEYS = ["amountMinor", "approvedBy", "at", "bookingId", "currency", "customerName", "destination", "direction", "feeMinor", "influencer", "key", "kind", "paidBy", "payoutId", "referenceTail", "serviceTitle", "status"].sort();
const TOTAL_KEYS = ["currency", "feesKeptMinor", "moneyInMinor", "payoutCount", "paymentCount", "payoutsOutMinor", "refundCount", "refundsOutMinor", "stillHeldMinor"].sort();

test("the DTO has exactly the hand-picked keys and passes assertNoSecretKeys; no Razorpay id, UTR, contact data, token or note leaves", { skip }, async () => {
  const token = await sessionLib.createAdminSession(Y);
  const out = await ask(`?${day()}&influencerId=${infIds.a}`, token);
  assert.equal(out.status, 200);
  const body = JSON.parse(out.text) as View;
  assert.deepEqual(keys(body), TOP_KEYS);
  assertNoSecretKeys(body);
  assert.equal(body.rows.length, 9);
  for (const r of body.rows) assert.deepEqual(keys(r), ROW_KEYS, r.key);
  assert.deepEqual(keys(body.influencer), ["id", "name"]);
  assert.deepEqual(keys(body.counts), ["payments", "refunds", "payouts"].sort());
  for (const t of body.totals) assert.deepEqual(keys(t), TOTAL_KEYS);
  assert.deepEqual(keys(body.summary), ["currencies", "feePercentText", "lastPayout"]);
  for (const c of body.summary!.currencies) {
    assert.deepEqual(keys(c), ["currency", "notPayable", "notPayableMinor", "paidOutMinor", "payableMinor", "pendingMinor"]);
    for (const w of c.notPayable) assert.deepEqual(keys(w), ["count", "label", "minor", "reason"]);
  }
  assert.deepEqual(keys(body.summary!.lastPayout), ["currency", "netMinor", "paidAt"]);
  assert.deepEqual(keys(body.scheduled), ["rows", "shown", "sums", "total"]);
  for (const r of body.scheduled.rows) assert.deepEqual(keys(r), ["approved", "approvedBy", "createdAt", "currency", "destination", "feeMinor", "id", "influencer", "netMinor"]);
  assert.deepEqual(keys(body.influencers), ["options", "truncated"]);
  for (const o of body.influencers.options) assert.deepEqual(keys(o), ["id", "name"]);

  // Nothing that is stored beside the movements may be in the answer: contact data, Meet link, intake, failure and recovery text, payout notes.
  for (const value of hidden) assert.ok(!out.text.includes(value), `the answer holds ${value}`);
  // The references are masked: not the Razorpay payment, order or refund id, and not the bank reference.
  for (const key of ["pA0", "pA1", "pA2", "pA3", "pA5a", "pA5b"]) {
    assert.ok(!out.text.includes(`pay_${run}_${key}`), `payment id of ${key}`);
    assert.ok(!out.text.includes(`order_${run}_${key}`), `order id of ${key}`);
  }
  for (const key of ["r1", "r2", "r3", "r5"]) assert.ok(!out.text.includes(`rfnd_${run}_${key}`), `refund id ${key}`);
  for (const ref of ["0001", "0005", "0006"]) assert.ok(!out.text.includes(`UTR${run}${ref}`), `UTR ${ref}`);
  assert.ok(!out.text.includes(`${run}0001`), "not even the middle of a UTR");
  const row = (key: string) => body.rows.find((r) => r.key === key)!;
  assert.equal(row(`payment:${id.pA1}`).referenceTail, maskTail(`pay_${run}_pA1`));
  assert.match(row(`payment:${id.pA1}`).referenceTail!, /^\*\*\*\*.{4}$/);
  assert.equal(row(`payout:${id.payout1}`).referenceTail, maskTail(`UTR${run}0001`));
  assert.match(row(`payout:${id.payout1}`).referenceTail!, /^\*\*\*\*0001$/);
  // The erased customer shows as such, never the stored placeholder.
  assert.equal(row(`payment:${id.pA2}`).customerName, "(erased)");
  assert.ok(!out.text.includes("Erased customer") && !out.text.includes("invalid.invalid"));
});

/* ---------- the rows ---------- */

const orderD0 = () => [
  `refund:${id.r5}`, // DAY - 1 ms, the last millisecond of D0
  `payout:${id.payout1}`, // 16H
  `refund:${id.r3}`, // 15H (failed: listed, not counted)
  `refund:${id.r2}`, // 14H
  `refund:${id.r1}`, // 13H
  `payment:${id.pA3}`, // 12H
  `payment:${id.pA2}`, // 11H
  `payment:${id.pA1}`, // 10H
  `payment:${id.pA0}`, // 0: the first instant of D0
];

test("the ledger of influencer A on D0: nine movements, newest first, with what each one shows", { skip }, async () => {
  const token = await sessionLib.createAdminSession(Y);
  const body = await view(`?${day()}&influencerId=${infIds.a}`, token);
  assert.deepEqual(body.rows.map((r) => r.key), orderD0());
  assert.equal(body.total, 9);
  assert.deepEqual(body.counts, { payments: 4, refunds: 4, payouts: 1 });
  assert.equal(body.page, 1);
  assert.equal(body.pageCount, 1);
  assert.equal(body.pageSize, 50);
  assert.equal(body.type, "all");
  assert.deepEqual([body.from, body.to], [FROM, FROM]);
  assert.deepEqual(body.influencer, { id: infIds.a, name: `=Ledger Owner A ${run}` });
  assert.equal(body.influencerUnknown, false);

  const row = (key: string) => body.rows.find((r) => r.key === key)!;
  const p1 = row(`payment:${id.pA1}`);
  assert.deepEqual([p1.kind, p1.direction, p1.amountMinor, p1.currency, p1.status, p1.feeMinor, p1.payoutId, p1.destination], ["payment", "in", 100_000, C1, "paid", null, null, null]);
  assert.equal(p1.at, at(10 * H).toISOString(), "a payment is dated by created_at");
  assert.equal(p1.serviceTitle, `+Ledger call ${run}`);
  assert.equal(p1.customerName, `@Customer a1 ${run}`);
  assert.equal(p1.influencer.id, infIds.a);
  assert.ok(p1.bookingId && p1.bookingId.length > 5);
  assert.equal(row(`payment:${id.pA2}`).status, "flagged", "flagged for a refund");
  assert.equal(row(`payment:${id.pA3}`).status, "refunded");
  assert.equal(row(`payment:${id.pA0}`).status, "paid");
  const refunds = ["r1", "r2", "r3", "r5"].map((k) => row(`refund:${id[k]}`));
  assert.deepEqual(refunds.map((r) => [r.kind, r.direction, r.amountMinor, r.status]), [["refund", "out", 30_000, "processed"], ["refund", "out", 5_000, "pending"], ["refund", "out", 4_000, "failed"], ["refund", "out", 2_000, "processed"]]);
  assert.equal(row(`refund:${id.r1}`).at, at(13 * H).toISOString(), "a refund is dated by created_at");
  assert.equal(row(`refund:${id.r1}`).referenceTail, maskTail(`pay_${run}_pA3`), "a refund shows the related payment's tail");
  assert.equal(row(`refund:${id.r1}`).customerName, `@Customer a3 ${run}`);
  const po = row(`payout:${id.payout1}`);
  assert.deepEqual([po.kind, po.direction, po.amountMinor, po.feeMinor, po.status, po.destination, po.approvedBy, po.paidBy, po.payoutId, po.bookingId, po.serviceTitle, po.customerName], ["payout", "out", 89_550, 10_500, "paid", "UPI ****1234", emailX, emailX, id.payout1, null, null, null]);
  assert.equal(po.at, at(16 * H).toISOString(), "a payout is dated by paid_at");
  // The CREATED payment, the CANCELLED payout, the PENDING payouts and the neighbouring days are not movements of D0.
  for (const key of ["pA4", "pA5a", "pA5b"]) assert.ok(!body.rows.some((r) => r.key === `payment:${id[key]}`), key);
  for (const key of ["payout2", "payout3", "payout4", "payout5", "payout6"]) assert.ok(!body.rows.some((r) => r.key === `payout:${id[key]}`), key);
  for (const key of ["r4", "r6"]) assert.ok(!body.rows.some((r) => r.key === `refund:${id[key]}`), key);
});

test("the days are IST days: 00:00 IST (18:30 UTC the evening before) is the first instant of a day, the last millisecond belongs to it, the next instant to the next day", { skip }, async () => {
  const token = await sessionLib.createAdminSession(Y);
  assert.equal(quiet.getUTCHours(), 18);
  assert.equal(quiet.getUTCMinutes(), 30);
  const rangeKeys = async (from: string, to: string) => (await view(`?from=${from}&to=${to}&influencerId=${infIds.a}`, token)).rows.map((r) => r.key).sort();
  const prev = [`payment:${id.pA5a}`, `refund:${id.r4}`, `payout:${id.payout6}`].sort();
  const next = [`payment:${id.pA5b}`, `refund:${id.r6}`, `payout:${id.payout5}`].sort();
  assert.deepEqual(await rangeKeys(PREV, PREV), prev, "D-1: one millisecond before 00:00 IST of D0");
  assert.deepEqual(await rangeKeys(NEXT, NEXT), next, "D+1: exactly 00:00 IST of the next day (the end of D0 is exclusive)");
  assert.deepEqual(await rangeKeys(PREV, FROM), [...prev, ...orderD0()].sort(), "two days");
  assert.deepEqual(await rangeKeys(FROM, NEXT), [...orderD0(), ...next].sort(), "`to` takes in the whole of its day");
  assert.ok((await rangeKeys(FROM, FROM)).includes(`payment:${id.pA0}`), "the payment at exactly 00:00 IST is in D0");
  assert.ok((await rangeKeys(FROM, FROM)).includes(`refund:${id.r5}`), "the refund at 23:59:59.999 IST is in D0");
  // The same cut is made by the library (the export reads through it).
  const lib = await readMovements({ from: PREV, to: PREV, type: "all", influencerId: infIds.a }, { limit: 50, offset: 0, order: "desc" });
  assert.deepEqual(lib.map((r) => `${r.kind}:${r.id}`).sort(), prev);
});

test("the type tabs and the influencer filter pick the right movements; the counts say how many of each", { skip }, async () => {
  const token = await sessionLib.createAdminSession(Y);
  const keysOf = async (type: string, influencerId = infIds.a) => (await view(`?${day()}&type=${type}&influencerId=${influencerId}`, token)).rows.map((r) => r.key);
  const all = orderD0();
  assert.deepEqual(await keysOf("in"), all.filter((k) => k.startsWith("payment:")));
  assert.deepEqual(await keysOf("out"), all.filter((k) => !k.startsWith("payment:")));
  assert.deepEqual(await keysOf("refunds"), all.filter((k) => k.startsWith("refund:")));
  assert.deepEqual(await keysOf("payouts"), [`payout:${id.payout1}`]);
  assert.deepEqual(await keysOf("zzz"), all, "an unknown type is all");
  const refunds = await view(`?${day()}&type=refunds&influencerId=${infIds.a}`, token);
  assert.equal(refunds.type, "refunds");
  assert.equal(refunds.total, 4);
  assert.deepEqual(refunds.counts, { payments: 0, refunds: 4, payouts: 0 });
  // Another influencer sees only their own money.
  assert.deepEqual(await keysOf("all", infIds.b), [`payout:${id.payoutB}`, `payment:${id.pB1}`]);
  assert.deepEqual(await keysOf("all", infIds.e), [], "an influencer without money has an empty ledger");
  // Without the filter the ledger holds everybody's movements of the quiet day: A's and B's, and only theirs (the other days are quiet).
  const everybody = (await view(`?${day()}`, token)).rows.map((r) => r.key).sort();
  assert.deepEqual(everybody, [...all, `payout:${id.payoutB}`, `payment:${id.pB1}`].sort());
});

test("an unknown influencer id is an empty page, not an error; a malformed one is a 400; an empty one means everybody", { skip }, async () => {
  const token = await sessionLib.createAdminSession(Y);
  const unknown = await view(`?${day()}&influencerId=nobody-${run}`, token);
  assert.deepEqual(keys(unknown), TOP_KEYS);
  assert.deepEqual([unknown.rows, unknown.totals, unknown.total, unknown.influencer, unknown.summary], [[], [], 0, null, null]);
  assert.equal(unknown.influencerUnknown, true);
  assert.equal(unknown.influencerId, `nobody-${run}`, "the requested id is echoed, so the page's links and export keep the filter");
  assert.equal((await view(`?${day()}&influencerId=${infIds.a}`, token)).influencerId, infIds.a);
  assert.equal((await view(`?${day()}`, token)).influencerId, null);
  assert.deepEqual(unknown.scheduled, { shown: true, total: 0, sums: [], rows: [] });
  assert.equal(unknown.page, 1);
  assertNoSecretKeys(unknown);
  for (const odd of ["<script>", "a b", "x".repeat(65), "'; DROP TABLE payments;--"]) {
    const out = await ask(`?${day()}&influencerId=${encodeURIComponent(odd)}`, token);
    assert.equal(out.status, 400, odd);
    assert.deepEqual(keys(JSON.parse(out.text)), ["error"]);
    assert.match(JSON.parse(out.text).error, /influencer is not valid/);
  }
  const blank = await view(`?${day()}&influencerId=`, token);
  assert.equal(blank.influencer, null);
  assert.equal(blank.influencerUnknown, false);
  assert.ok(blank.total >= 9, "everybody's, including A's nine");
});

test("the range rules are the Reports page's: an odd date is ignored, a start after the end or a span over 366 days is a 400 with a sentence", { skip }, async () => {
  const token = await sessionLib.createAdminSession(Y);
  const bad: [string, RegExp][] = [
    ["?from=2026-10-12&to=2026-10-11", /after the end/],
    ["?from=2025-01-01&to=2026-01-02", /at most 366 days/],
    ["?from=2000-01-01&to=2100-12-31", /at most 366 days/],
  ];
  for (const [query, message] of bad) {
    const out = await ask(query, token);
    assert.equal(out.status, 400, query);
    const body = JSON.parse(out.text) as { error: string };
    assert.deepEqual(keys(body), ["error"]);
    assert.match(body.error, message, query);
    assert.equal(out.headers.get("cache-control"), "private, no-store");
  }
  // Odd single dates fall back (the 1st of the month to today), like Reports; nothing is refused.
  for (const odd of ["2026-02-31", "yesterday", "0000-01-01", "9999-12-31", "<script>"]) {
    const body = await view(`?from=${encodeURIComponent(odd)}&to=${encodeURIComponent(odd)}`, token);
    assert.match(body.from, /^\d{4}-\d{2}-01$/, odd);
    assert.match(body.to, /^\d{4}-\d{2}-\d{2}$/, odd);
  }
  assert.equal((await view("?from=2024-01-01&to=2024-12-31", token)).from, "2024-01-01", "366 days is allowed");
  const none = await view("", token);
  assert.equal(none.from, none.to.slice(0, 8) + "01", "no dates: the 1st of this month to today");
});

test("pages: 52 movements are two pages of 50 and 2, in order, with no repeated or missing row; a page beyond the last is the last", { skip }, async () => {
  const token = await sessionLib.createAdminSession(Y);
  const q = (page: number) => `?from=${PAGER_DAY}&to=${PAGER_DAY}&influencerId=${infIds.c}&page=${page}`;
  const p1 = await view(q(1), token);
  const p2 = await view(q(2), token);
  assert.deepEqual([p1.total, p1.pageCount, p1.page, p1.rows.length, p2.page, p2.rows.length], [52, 2, 1, 50, 2, 2]);
  const amounts = [...p1.rows, ...p2.rows].map((r) => r.amountMinor);
  assert.deepEqual(amounts, Array.from({ length: 52 }, (_, i) => 151 - i), "newest first (the amounts rise with the minute), no gap or repeat across the page boundary");
  assert.equal(new Set([...p1.rows, ...p2.rows].map((r) => r.key)).size, 52);
  const beyond = await view(q(9999), token);
  assert.deepEqual([beyond.page, beyond.rows.length], [2, 2], "clamped to the last page");
  const odd = await view(q(1).replace("page=1", "page=-4"), token);
  assert.equal(odd.page, 1);
  // The library's pages agree with it (offset arithmetic, ties broken by kind and id).
  const f = { from: PAGER_DAY, to: PAGER_DAY, type: "all" as const, influencerId: infIds.c };
  const counted = await countMovements(f);
  assert.deepEqual(counted, { total: 52, payments: 52, refunds: 0, payouts: 0 });
  const stitched = [
    ...(await readMovements(f, { limit: 20, offset: 0, order: "desc" })),
    ...(await readMovements(f, { limit: 20, offset: 20, order: "desc" })),
    ...(await readMovements(f, { limit: 20, offset: 40, order: "desc" })),
  ];
  assert.deepEqual(stitched.map((r) => r.amountMinor), amounts);
  const oldest = await readMovements(f, { limit: 3, offset: 0, order: "asc" });
  assert.deepEqual(oldest.map((r) => r.amountMinor), [100, 101, 102], "the file reads oldest first");
});

/* ---------- the totals agree with Reports ---------- */

test("the cards are the Reports figures for the same range: gross, refunds, fees, paid out and held, per currency", { skip }, async () => {
  const token = await sessionLib.createAdminSession(Y);
  const money = await view(`?${day()}`, token);
  const report = await loadAdminReportsView(FROM, FROM);
  const card = money.totals.find((t) => t.currency === C1)!;
  const range = report.range.find((r) => r.currency === C1)!;
  const held = report.balances.find((b) => b.currency === C1)!;
  assert.ok(card && range && held, "both pages list the fixture's currency");
  assert.deepEqual(
    [card.moneyInMinor, card.paymentCount, card.refundsOutMinor, card.refundCount, card.payoutsOutMinor, card.payoutCount, card.feesKeptMinor, card.stillHeldMinor],
    [range.grossMinor, range.paymentCount, range.refundsMinor, range.refundCount, range.payoutsPaidNetMinor, range.payoutsPaidCount, range.feesEarnedMinor, held.heldForInfluencersMinor],
    "every card equals the Reports figure",
  );
  // And both equal the fixture worked out by hand: A 181 000 + B 20 000 in; refunds 37 000; payouts 89 550 + 10 000; fees 10 500 + 1 000; held 16 000 + 20 000.
  assert.deepEqual(
    [card.moneyInMinor, card.paymentCount, card.refundsOutMinor, card.refundCount, card.payoutsOutMinor, card.payoutCount, card.feesKeptMinor, card.stillHeldMinor],
    [201_000, 5, 37_000, 3, 99_550, 2, 11_500, 36_000],
  );
  // The other currency has its own card; currencies are never added together.
  assert.ok(money.totals.every((t, i, all) => i === 0 || all[i - 1].currency.localeCompare(t.currency) < 0), "sorted by currency, one card each");
  // The type tabs narrow the list, never the cards.
  const refundsOnly = await view(`?${day()}&type=refunds`, token);
  assert.deepEqual(refundsOnly.totals.find((t) => t.currency === C1), card);
  // The sums of the listed rows are the card figures (one page holds them all here): the failed refund is listed and not counted.
  const rows = money.rows.filter((r) => r.currency === C1);
  const sum = (kind: string, status?: string[]) => rows.filter((r) => r.kind === kind && (!status || status.includes(r.status))).reduce((n, r) => n + r.amountMinor, 0);
  assert.equal(sum("payment"), card.moneyInMinor);
  assert.equal(sum("refund", ["pending", "processed"]), card.refundsOutMinor);
  assert.equal(sum("payout"), card.payoutsOutMinor);
  assert.equal(rows.filter((r) => r.kind === "payout").reduce((n, r) => n + (r.feeMinor ?? 0), 0), card.feesKeptMinor);
  assert.equal(rows.filter((r) => r.kind === "refund" && r.status === "failed").length, 1, "the failed refund is listed");
});

test("with an influencer chosen the cards are that influencer's share, and the shares add up to the Reports figure", { skip }, async () => {
  const token = await sessionLib.createAdminSession(Y);
  const a = (await view(`?${day()}&influencerId=${infIds.a}`, token)).totals.find((t) => t.currency === C1)!;
  const b = (await view(`?${day()}&influencerId=${infIds.b}`, token)).totals.find((t) => t.currency === C1)!;
  const all = [a.moneyInMinor, a.paymentCount, a.refundsOutMinor, a.refundCount, a.payoutsOutMinor, a.payoutCount, a.feesKeptMinor, a.stillHeldMinor];
  assert.deepEqual(all, [181_000, 4, 37_000, 3, 89_550, 1, 10_500, 16_000]);
  assert.deepEqual([b.moneyInMinor, b.paymentCount, b.refundsOutMinor, b.refundCount, b.payoutsOutMinor, b.payoutCount, b.feesKeptMinor, b.stillHeldMinor], [20_000, 1, 0, 0, 10_000, 1, 1_000, 20_000]);
  const report = (await loadAdminReportsView(FROM, FROM)).range.find((r) => r.currency === C1)!;
  assert.equal(a.moneyInMinor + b.moneyInMinor, report.grossMinor);
  assert.equal(a.refundsOutMinor + b.refundsOutMinor, report.refundsMinor);
  assert.equal(a.payoutsOutMinor + b.payoutsOutMinor, report.payoutsPaidNetMinor);
  assert.equal(a.feesKeptMinor + b.feesKeptMinor, report.feesEarnedMinor);
  // Nothing in the range, nothing held: no card at all (the empty influencer E).
  const e = await view(`?${day()}&influencerId=${infIds.e}`, token);
  assert.deepEqual(e.totals, []);
  // A day with only the neighbours' money: D-1 holds payment pA5a only (+ refund r4, payout6).
  const prev = (await view(`?from=${PREV}&to=${PREV}&influencerId=${infIds.a}`, token)).totals.find((t) => t.currency === C1)!;
  assert.deepEqual([prev.moneyInMinor, prev.paymentCount, prev.refundsOutMinor, prev.payoutsOutMinor, prev.feesKeptMinor], [7_000, 1, 1_000, 1_111, 111]);
});

/* ---------- scheduled payouts and the influencer summary ---------- */

test("payouts created and not sent are listed apart whatever the dates, only for the types that show payouts", { skip }, async () => {
  const token = await sessionLib.createAdminSession(Y);
  const body = await view(`?from=${PREV}&to=${PREV}&influencerId=${infIds.a}`, token);
  assert.equal(body.scheduled.shown, true);
  assert.equal(body.scheduled.total, 2, "payout2 and payout3; the cancelled and the sent ones are not here");
  assert.deepEqual(body.scheduled.rows.map((r) => r.id), [id.payout3, id.payout2], "newest first");
  assert.deepEqual(body.scheduled.sums, [{ currency: C1, netMinor: 12_000, count: 2 }]);
  const [approved, plain] = body.scheduled.rows;
  assert.deepEqual([approved.approved, approved.approvedBy, approved.netMinor, approved.feeMinor, approved.destination, approved.influencer.id], [true, emailX, 7_000, 700, "UPI ****1234", infIds.a]);
  assert.deepEqual([plain.approved, plain.approvedBy, plain.netMinor], [false, null, 5_000]);
  assert.ok(!body.rows.some((r) => r.kind === "payout" && [id.payout2, id.payout3].includes(r.payoutId!)), "they are not movements");
  for (const type of ["in", "refunds"]) {
    const hiddenOne = await view(`?${day()}&type=${type}&influencerId=${infIds.a}`, token);
    assert.deepEqual(hiddenOne.scheduled, { shown: false, total: 0, sums: [], rows: [] }, type);
  }
  for (const type of ["all", "out", "payouts"]) assert.equal((await view(`?${day()}&type=${type}&influencerId=${infIds.a}`, token)).scheduled.total, 2, type);
  // Without the filter the newest of everybody's: the fixture's (created far in the future) lead.
  const everybody = await view(`?${day()}`, token);
  assert.deepEqual(everybody.scheduled.rows.slice(0, 2).map((r) => r.id), [id.payout3, id.payout2]);
});

test("the chosen influencer's summary: paid out to date over ALL their payouts (not the 50 newest), payable, held, pending, the last payout", { skip }, async () => {
  const token = await sessionLib.createAdminSession(Y);
  const a = await view(`?${day()}&influencerId=${infIds.a}`, token);
  const direct = await influencerPayoutSummary(infIds.a);
  const mine = a.summary!.currencies.find((c) => c.currency === C1)!;
  const theirs = direct.currencies.find((c) => c.currency === C1)!;
  assert.deepEqual([mine.payableMinor, mine.notPayableMinor, mine.pendingMinor, mine.paidOutMinor], [theirs.readyMinor, theirs.waitingMinor, theirs.pendingMinor, theirs.paidOutMinor], "the page shows what influencerPayoutSummary says");
  // Not payable yet is EVERY payment waiting for something, and the page says why: A's flagged pA2 (50 000) and the three payments nobody has
  // reconciled (pA0, pA5a, pA5b: 16 000). pA3 is refunded in full and pA1 is in a sent payout: neither waits.
  assert.equal(mine.notPayableMinor, 66_000);
  assert.deepEqual(mine.notPayable, [
    { reason: "flagged-for-refund", label: "Flagged for a refund", count: 1, minor: 50_000 },
    { reason: "not-reconciled", label: "Waiting for reconciliation", count: 3, minor: 16_000 },
  ]);
  assert.equal(mine.notPayable.reduce((n, w) => n + w.minor, 0), mine.notPayableMinor, "the reasons add up to the figure");
  assert.equal(mine.paidOutMinor, 89_550 + 3_000 + 1_111, "payout1, payout5 and payout6 were sent");
  assert.equal(mine.pendingMinor, 12_000, "payout2 and payout3 are waiting");
  assert.deepEqual(a.summary!.lastPayout, { paidAt: at(DAY).toISOString(), netMinor: 3_000, currency: C1 }, "the one most recently marked as sent, whatever the range");
  assert.match(a.summary!.feePercentText, /%$/);

  // 52 sent payouts: the old summary stopped at the 50 newest.
  const d = await view(`?from=${MANY_DAY}&to=${MANY_DAY}&influencerId=${infIds.d}`, token);
  assert.equal(d.summary!.currencies.find((c) => c.currency === C2)!.paidOutMinor, 52_000);
  assert.equal((await influencerPayoutSummary(infIds.d)).currencies.find((c) => c.currency === C2)!.paidOutMinor, 52_000);
  assert.deepEqual(d.summary!.lastPayout, { paidAt: new Date(at(6 * DAY).getTime() + 51 * 60_000).toISOString(), netMinor: 1_000, currency: C2 });
  assert.equal(d.total, 52);
  assert.equal(d.pageCount, 2);

  // An influencer with nothing: an empty summary, no last payout.
  const e = await view(`?${day()}&influencerId=${infIds.e}`, token);
  assert.deepEqual(e.summary!.currencies, []);
  assert.equal(e.summary!.lastPayout, null);
  assert.equal(e.influencer!.id, infIds.e);
  // Everybody: no summary.
  assert.equal((await view(`?${day()}`, token)).summary, null);
});

test("GET /api/admin/payouts?id=: the one payout the ledger links to, in any status and the usual shape, behind the same gate; an unknown or malformed id gives no rows", { skip }, async () => {
  const PAYOUT_ROW_KEYS = ["approval", "createdAt", "currency", "destination", "feeMinor", "feePercentText", "grossAfterRefundsMinor", "hasFlaggedPayment", "id", "influencer", "netMinor", "owedMinor", "reference", "status"];
  const askPayouts = async (query: string, cookie?: string) => {
    jar.clear();
    if (cookie !== undefined) jar.set(sessionLib.adminCookieName(), cookie);
    const res = await PAYOUTS(new Request(`http://localhost/api/admin/payouts${query}`));
    return { status: res.status, body: (await res.json()) as Record<string, unknown> & { rows: { id: string; status: string; reference: string | null }[]; single: boolean } };
  };
  const token = await sessionLib.createAdminSession(Y);
  // The gate is the page's: nothing without a session, and nothing for a password-only session of an admin who has 2FA.
  assert.equal((await askPayouts(`?id=${id.payout1}`)).status, 401);
  assert.equal((await askPayouts(`?id=${id.payout1}`, "not-a-real-admin-session-token")).status, 401);
  const stale = await passwordOnlySession(X);
  const denied = await askPayouts(`?id=${id.payout1}`, stale);
  assert.equal(denied.status, 403);
  assert.deepEqual(keys(denied.body), ["error", "mfaAction", "mfaRequired"]);

  // A PAID payout is shown although the default tab is "To send"; so is a PENDING one under ?status=PAID: the id wins.
  const paid = await askPayouts(`?id=${id.payout1}`, token);
  assert.equal(paid.status, 200);
  assert.deepEqual(keys(paid.body), ["counts", "onlyOneAdmin", "page", "pageCount", "rows", "single", "status"]);
  assertNoSecretKeys(paid.body);
  assert.equal(paid.body.single, true);
  assert.deepEqual([paid.body.rows.length, paid.body.page, paid.body.pageCount], [1, 1, 1]);
  assert.deepEqual(keys(paid.body.rows[0]), PAYOUT_ROW_KEYS.sort());
  assert.deepEqual([paid.body.rows[0].id, paid.body.rows[0].status, paid.body.rows[0].reference], [id.payout1, "PAID", `UTR${run}0001`]);
  const pending = await askPayouts(`?id=${id.payout2}&status=PAID&page=7`, token);
  assert.deepEqual(pending.body.rows.map((r) => [r.id, r.status]), [[id.payout2, "PENDING"]]);
  assert.equal(pending.body.single, true);
  // The cancelled one too, and an id that is not the first of anything.
  assert.deepEqual((await askPayouts(`?id=${id.payout4}`, token)).body.rows.map((r) => r.status), ["CANCELLED"]);

  // Nobody's id, or something that is not shaped like an id: no rows, never the list, never an error.
  for (const odd of [`nobody-${run}`, "x".repeat(65), "<script>", "a b", "'; DROP TABLE payouts;--"]) {
    const out = await askPayouts(`?id=${encodeURIComponent(odd)}`, token);
    assert.equal(out.status, 200, odd);
    assert.deepEqual([out.body.rows, out.body.single], [[], true], odd);
  }
  // Without an id (or an empty one) it is the usual list.
  for (const q of ["", "?id=", "?id=%20"]) {
    const out = await askPayouts(q, token);
    assert.equal(out.body.single, false, q);
  }
});

test("the influencer summary and the cards agree wherever they claim the same thing (the Reports definitions, scoped to the influencer)", { skip }, async () => {
  const token = await sessionLib.createAdminSession(Y);
  const a = await view(`?${day()}&influencerId=${infIds.a}`, token);
  const mine = a.summary!.currencies.find((c) => c.currency === C1)!;
  const card = a.totals.find((t) => t.currency === C1)!;
  const scope = { influencerId: infIds.a };
  const balances = (await balanceFigures(scope)).find((b) => b.currency === C1)!;
  const allTime = (await rangeFigures("2000-01-01", "2100-12-31", scope)).find((r) => r.currency === C1)!;
  // Paid out to date is every payout marked as sent: the Reports "paid out" over all time (payout1 + payout5 + payout6).
  assert.equal(mine.paidOutMinor, allTime.payoutsPaidNetMinor);
  assert.equal(mine.paidOutMinor, 93_661);
  // Pending payouts: the summary and the Reports balance are the same sum of net amounts.
  assert.equal(mine.pendingMinor, balances.inPendingPayoutsMinor);
  assert.equal(mine.pendingMinor, 12_000);
  // Payments flagged for a refund: the summary's reason and the Reports "owed to customers" count the same money.
  assert.equal(mine.notPayable.find((w) => w.reason === "flagged-for-refund")!.minor, balances.owedToCustomersMinor);
  assert.equal(balances.owedToCustomersMinor, 50_000);
  // The "Still held" card is NOT the summary's "Not payable yet": held leaves out the flagged payment, so card + owed = not payable here,
  // where nothing else waits (every other waiting payment is a booking that is scheduled and not reconciled, which both count).
  assert.equal(card.stillHeldMinor, balances.heldForInfluencersMinor);
  assert.equal(card.stillHeldMinor, 16_000);
  assert.equal(card.stillHeldMinor + balances.owedToCustomersMinor, mine.notPayableMinor);
  assert.ok(mine.notPayableMinor > card.stillHeldMinor, "the summary figure is the wider one, and the page says so");
});

test("the influencer list of the filter: names only, sorted, and the chosen one is always in it", { skip }, async () => {
  const token = await sessionLib.createAdminSession(Y);
  const body = await view(`?${day()}&influencerId=${infIds.a}`, token);
  assert.ok(body.influencers.options.some((o) => o.id === infIds.a && o.name === `=Ledger Owner A ${run}`), "the chosen influencer is offered");
  assert.equal(typeof body.influencers.truncated, "boolean");
  assert.ok(body.influencers.options.length <= 201, "at most 200 names, plus the chosen one when it was cut");
  assert.equal(new Set(body.influencers.options.map((o) => o.id)).size, body.influencers.options.length, "each influencer once");
});

/* ---------- the CSV export ---------- */

const MONEY_HEADER = ["date", "type", "direction", "amount", "fee", "currency", "status", "influencer_slug", "influencer_name", "service_title", "customer_name", "booking_id", "payment_id", "payout_id", "razorpay_payment_id", "razorpay_refund_id", "utr", "destination", "approved_by", "paid_by"];

async function csv(query: string, token?: string) {
  const t = token ?? (await sessionLib.createAdminSession(Y));
  const res = await askExport("money", query, t);
  // Read the bytes: `res.text()` would drop the byte order mark the test wants to see.
  const bytes = new Uint8Array(await res.arrayBuffer());
  const text = new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes);
  return { res, bytes, text, rows: res.status === 200 ? parseCsv(text) : [] };
}

test("money CSV: the header, the same rows as the page oldest first, decimals, ISO times with +05:30, neutralised cells, the audit row", { skip }, async () => {
  const startedAt = new Date();
  const { res, bytes, text, rows } = await csv(`?${day()}&influencerId=${infIds.a}`);
  assert.equal(res.status, 200);
  assert.deepEqual([...bytes.slice(0, 3)], [0xef, 0xbb, 0xbf], "a UTF-8 byte order mark (Excel on Windows)");
  assert.equal(res.headers.get("content-type"), "text/csv; charset=utf-8");
  assert.equal(res.headers.get("content-disposition"), `attachment; filename="money-${FROM}-to-${FROM}.csv"`);
  assert.equal(res.headers.get("cache-control"), "no-store");
  assert.ok(text.startsWith("﻿date,"), "a byte order mark, then the header");
  assert.deepEqual(rows[0].map((c) => c.replace("﻿", "")), MONEY_HEADER);
  for (const r of rows) assert.equal(r.length, MONEY_HEADER.length);
  const col = (name: string) => MONEY_HEADER.indexOf(name);
  assert.equal(rows.length - 1, 9);
  // Oldest first: the page's order reversed.
  const idCell = (r: string[]) => (r[col("type")] === "payment" ? r[col("payment_id")] : r[col("payout_id")]);
  assert.deepEqual(rows.slice(1).map((r) => r[col("date")]), [at(0), at(10 * H), at(11 * H), at(12 * H), at(13 * H), at(14 * H), at(15 * H), at(16 * H), at(DAY - 1)].map(istIso));
  assert.deepEqual(rows.slice(1).filter((r) => r[col("type")] !== "refund").map(idCell), [id.pA0, id.pA1, id.pA2, id.pA3, id.payout1]);
  assert.deepEqual(rows.slice(1).map((r) => r[col("type")]), ["payment", "payment", "payment", "payment", "refund", "refund", "refund", "payout", "refund"]);
  const by = (type: string, i: number) => rows.slice(1).filter((r) => r[col("type")] === type)[i];
  const p1 = by("payment", 1);
  assert.deepEqual([p1[col("direction")], p1[col("amount")], p1[col("fee")], p1[col("currency")], p1[col("status")], p1[col("razorpay_payment_id")], p1[col("payout_id")]], ["in", "1000.00", "", C1, "paid", `pay_${run}_pA1`, id.payout1]);
  assert.equal(by("payment", 2)[col("status")], "flagged");
  assert.equal(by("payment", 3)[col("status")], "refunded");
  assert.equal(by("payment", 2)[col("customer_name")], "(erased)");
  const failed = rows.slice(1).find((r) => r[col("razorpay_refund_id")] === `rfnd_${run}_r3`)!;
  assert.deepEqual([failed[col("type")], failed[col("direction")], failed[col("amount")], failed[col("status")], failed[col("razorpay_payment_id")]], ["refund", "out", "40.00", "failed", `pay_${run}_pA2`]);
  const payout = by("payout", 0);
  assert.deepEqual(
    [payout[col("direction")], payout[col("amount")], payout[col("fee")], payout[col("status")], payout[col("utr")], payout[col("destination")], payout[col("approved_by")], payout[col("paid_by")], payout[col("razorpay_payment_id")]],
    ["out", "895.50", "105.00", "paid", `UTR${run}0001`, "UPI ****1234", emailX, emailX, ""],
  );
  // Formula characters are neutralised: the influencer, the service and the customer names all start with = + or @.
  assert.equal(by("payment", 1)[col("influencer_name")], `'=Ledger Owner A ${run}`);
  assert.equal(by("payment", 1)[col("service_title")], `'+Ledger call ${run}`);
  assert.equal(by("payment", 1)[col("customer_name")], `'@Customer a1 ${run}`);
  for (const r of rows.slice(1)) for (const cell of r) assert.ok(!/^[=+\-@\t\r]/.test(cell), `a cell starts with a formula character: ${cell}`);
  // Nothing private: no phone, e-mail, Meet link, event id, intake answer, decline reason, error text, failure or recovery text, payout note.
  for (const value of hidden) assert.ok(!text.includes(value), `the file holds ${value}`);
  assert.ok(!text.includes("invalid.invalid") && !text.includes("Erased customer"));
  // The same movements as the page.
  const token = await sessionLib.createAdminSession(Y);
  const page = await view(`?${day()}&influencerId=${infIds.a}`, token);
  assert.equal(page.rows.length, rows.length - 1);
  // Audited, with what narrowed it.
  const entry = await prisma.adminAuditLog.findFirst({ where: { adminEmail: emailY, action: "admin.export", targetId: "money", createdAt: { gte: startedAt } }, orderBy: { createdAt: "desc" } });
  assert.ok(entry, "an audit entry");
  assert.equal(entry.targetType, "export");
  assert.deepEqual(entry.detail, { kind: "money", from: FROM, to: FROM, rows: 9, type: "all", influencerId: infIds.a });
});

test("money CSV: the type and influencer filters, a day range, and an unknown influencer is an empty file (header only)", { skip }, async () => {
  const token = await sessionLib.createAdminSession(Y);
  const typeOf = async (query: string) => (await csv(query, token)).rows.slice(1).map((r) => r[MONEY_HEADER.indexOf("type")]);
  assert.deepEqual(await typeOf(`?${day()}&influencerId=${infIds.a}&type=payouts`), ["payout"]);
  assert.deepEqual(await typeOf(`?${day()}&influencerId=${infIds.a}&type=refunds`), ["refund", "refund", "refund", "refund"]);
  assert.deepEqual(await typeOf(`?${day()}&influencerId=${infIds.a}&type=in`), ["payment", "payment", "payment", "payment"]);
  assert.equal((await typeOf(`?${day()}&influencerId=${infIds.a}&type=out`)).length, 5);
  assert.equal((await typeOf(`?${day(PREV, NEXT)}&influencerId=${infIds.a}`)).length, 9 + 3 + 3, "three days");
  assert.equal((await typeOf(`?${day()}&influencerId=${infIds.b}`)).length, 2);
  const startedAt = new Date();
  const none = await csv(`?${day()}&influencerId=nobody-${run}`, token);
  assert.equal(none.res.status, 200);
  assert.equal(none.rows.length, 1, "the header only");
  const entry = await prisma.adminAuditLog.findFirst({ where: { adminEmail: emailY, action: "admin.export", targetId: "money", createdAt: { gte: startedAt } }, orderBy: { createdAt: "desc" } });
  assert.deepEqual(entry?.detail, { kind: "money", from: FROM, to: FROM, rows: 0, type: "all", influencerId: `nobody-${run}` });
  // Refused: a malformed id and a bad range are 400s with only a sentence, and nothing is audited.
  const since = new Date();
  for (const [query, message] of [[`?${day()}&influencerId=${encodeURIComponent("<x>")}`, /influencer is not valid/], [`?from=2026-10-12&to=2026-10-11`, /after the end/]] as const) {
    const res = await askExport("money", query, token);
    assert.equal(res.status, 400, query);
    const body = (await res.json()) as { error: string };
    assert.deepEqual(keys(body), ["error"]);
    assert.match(body.error, message);
  }
  assert.equal(await prisma.adminAuditLog.count({ where: { adminEmail: emailY, action: "admin.export", createdAt: { gte: since } } }), 0);
});

test("money CSV: more rows than the cap is a 400 with the honest message, not audited and not sent; exactly the cap is fine", { skip }, async () => {
  const token = await sessionLib.createAdminSession(Y);
  capOverride = 8;
  try {
    const startedAt = new Date();
    const res = await askExport("money", `?${day()}&influencerId=${infIds.a}`, token);
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { error: "More than 8 rows. Choose a shorter range." });
    assert.equal(await prisma.adminAuditLog.count({ where: { adminEmail: emailY, action: "admin.export", targetId: "money", createdAt: { gte: startedAt } } }), 0);
    capOverride = 9;
    const exact = await askExport("money", `?${day()}&influencerId=${infIds.a}`, token);
    assert.equal(exact.status, 200, "9 rows, cap 9");
    assert.equal(parseCsv(await exact.text()).length - 1, 9);
  } finally {
    capOverride = undefined;
  }
  const r = exportsLib.parseExportRange(new URLSearchParams(`from=${FROM}&to=${FROM}`));
  assert.ok(r.ok);
  await assert.rejects(exportsLib.buildExport("money", r.range, { rowCap: 4, money: { type: "all", influencerId: infIds.a } }), ExportTooLargeError);
  assert.equal((await exportsLib.buildExport("money", r.range, { rowCap: 9, money: { type: "all", influencerId: infIds.a } })).length, 10);
});

test("money CSV: if the audit entry cannot be written, no data is returned", { skip }, async () => {
  const token = await sessionLib.createAdminSession(Y);
  const real = prisma.adminAuditLog.create;
  (prisma.adminAuditLog as { create: unknown }).create = async () => {
    throw new Error("audit store down");
  };
  try {
    jar.clear();
    jar.set(sessionLib.adminCookieName(), token);
    await assert.rejects(EXPORT(new Request(`http://localhost/api/admin/exports/money?${day()}`), { params: Promise.resolve({ kind: "money" }) }), /audit store down/);
  } finally {
    (prisma.adminAuditLog as { create: unknown }).create = real;
  }
});
