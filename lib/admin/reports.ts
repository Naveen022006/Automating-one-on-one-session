import { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";

/**
 * The queries behind the admin finance report (GET /api/admin/reports). Every figure is an aggregate computed in SQL (one row per
 * currency, or per month and currency), so the work done is the same whatever the size of the tables, and the queries are run one
 * after the other, never together, to stay inside the database's connection cap.
 *
 * The figures follow the rules of the payout ledger (lib/payouts.ts) and must never disagree with the payout screens:
 *   - fees and payouts are the stored amounts of the PAID payouts, which createPayout() computed with buildPayoutTotals() (the
 *     influencer's fee override or the platform default, floor(net x bps / 10000), per currency). Nothing here recomputes a fee.
 *   - "refunded since" is postPayoutRefunds() in SQL: for each PAID payout, the refunds now on its payments minus the refunds
 *     already counted when it was created, never below zero for that payout. tests/admin-reports.test.ts asserts it equals
 *     postPayoutRefunds() on the same fixtures.
 *   - a payment counts as money paid by the customer when it is CAPTURED or REFUNDED (the same test as payoutBlocker's "not-paid"),
 *     and what is left of it is amount - refund_amount_minor (netOf in lib/payouts.ts).
 *   - a booking "holds" a payment when it is PAID, SCHEDULED or COMPLETED.
 * Money is an integer in minor units; a currency is never added to another.
 */

/** A day written YYYY-MM-DD (UTC), already validated by the caller. */
export type Day = string;

const num = (v: bigint | number | null | undefined): number => (v == null ? 0 : Number(v));

export interface RangeFigures {
  currency: string;
  grossMinor: number;
  paymentCount: number;
  refundsMinor: number;
  refundCount: number;
  payoutsPaidCount: number;
  payoutsPaidNetMinor: number;
  feesEarnedMinor: number;
}

export interface MonthFigures {
  /** YYYY-MM, UTC. */
  month: string;
  currency: string;
  grossMinor: number;
  paymentCount: number;
  refundsMinor: number;
  feesEarnedMinor: number;
}

export interface BalanceFigures {
  currency: string;
  /** Captured, not flagged for refund, booking PAID/SCHEDULED/COMPLETED, not in a PAID payout: amount - refunded (before the fee). */
  heldForInfluencersMinor: number;
  /** PENDING payouts: the net amount still to be sent. Part of the held figure above, but after the platform fee. */
  inPendingPayoutsMinor: number;
  /** Captured and flagged `needs_refund`: amount - refunded. */
  owedToCustomersMinor: number;
  /** PAID payouts: refunds made on their payments since they were paid (postPayoutRefunds). */
  toRecoverMinor: number;
  /** Captured, not flagged, not in a PAID payout, but the booking is not PAID/SCHEDULED/COMPLETED: no payout can ever include it. */
  unallocatedMinor: number;
}

export interface ReportData {
  range: RangeFigures[];
  monthly: MonthFigures[];
  balances: BalanceFigures[];
}

/** The 12 calendar months (UTC) ending with `endMonth` (YYYY-MM): the first day of the first one, and the first day AFTER the last one. */
export function monthWindow(endMonth: string, months = 12): { start: Day; endExclusive: Day } {
  const [y, m] = endMonth.split("-").map(Number);
  const first = new Date(Date.UTC(y, m - 1 - (months - 1), 1));
  const after = new Date(Date.UTC(y, m, 1));
  return { start: first.toISOString().slice(0, 10), endExclusive: after.toISOString().slice(0, 10) };
}

/* ---------- Money in a window [start, endExclusive) ---------- */

type Bucket = { bucket: string | null; currency: string };

/** Customer payments made in the window (by `payments.created_at`), one row per currency, or per month and currency. */
async function paymentRows(start: Day, endExclusive: Day, byMonth: boolean) {
  const bucket = byMonth ? Prisma.sql`to_char(created_at, 'YYYY-MM')` : Prisma.sql`NULL::text`;
  return prisma.$queryRaw<(Bucket & { gross: bigint; payments: bigint })[]>`
    SELECT ${bucket} AS bucket, currency, COALESCE(SUM(amount_minor), 0) AS gross, COUNT(*) AS payments
    FROM payments
    WHERE status IN ('CAPTURED', 'REFUNDED') AND created_at >= ${start}::date AND created_at < ${endExclusive}::date
    GROUP BY 1, currency`;
}

/** Refunds recorded in the window (by `refunds.created_at`) that are pending or processed, in the currency of their payment. */
async function refundRows(start: Day, endExclusive: Day, byMonth: boolean) {
  const bucket = byMonth ? Prisma.sql`to_char(r.created_at, 'YYYY-MM')` : Prisma.sql`NULL::text`;
  return prisma.$queryRaw<(Bucket & { refunds: bigint; refund_count: bigint })[]>`
    SELECT ${bucket} AS bucket, p.currency, COALESCE(SUM(r.amount_minor), 0) AS refunds, COUNT(*) AS refund_count
    FROM refunds r JOIN payments p ON p.id = r.payment_id
    WHERE r.status IN ('pending', 'processed') AND r.created_at >= ${start}::date AND r.created_at < ${endExclusive}::date
    GROUP BY 1, p.currency`;
}

/** Payouts marked as paid in the window (by `payouts.paid_at`): the amount sent and the fee kept, as stored when they were created. */
async function payoutRows(start: Day, endExclusive: Day, byMonth: boolean) {
  const bucket = byMonth ? Prisma.sql`to_char(paid_at, 'YYYY-MM')` : Prisma.sql`NULL::text`;
  return prisma.$queryRaw<(Bucket & { payouts: bigint; net: bigint; fees: bigint })[]>`
    SELECT ${bucket} AS bucket, currency, COUNT(*) AS payouts, COALESCE(SUM(net_minor), 0) AS net, COALESCE(SUM(fee_minor), 0) AS fees
    FROM payouts
    WHERE status = 'PAID' AND paid_at >= ${start}::date AND paid_at < ${endExclusive}::date
    GROUP BY 1, currency`;
}

/** The figures of the chosen range, one entry per currency that had any activity in it, sorted by currency. */
export async function rangeFigures(from: Day, to: Day): Promise<RangeFigures[]> {
  const endExclusive = nextDay(to);
  // Sequential on purpose: one connection at a time.
  const payments = await paymentRows(from, endExclusive, false);
  const refunds = await refundRows(from, endExclusive, false);
  const payouts = await payoutRows(from, endExclusive, false);
  const by = new Map<string, RangeFigures>();
  const get = (currency: string) => {
    let f = by.get(currency);
    if (!f) by.set(currency, (f = { currency, grossMinor: 0, paymentCount: 0, refundsMinor: 0, refundCount: 0, payoutsPaidCount: 0, payoutsPaidNetMinor: 0, feesEarnedMinor: 0 }));
    return f;
  };
  for (const r of payments) Object.assign(get(r.currency), { grossMinor: num(r.gross), paymentCount: num(r.payments) });
  for (const r of refunds) Object.assign(get(r.currency), { refundsMinor: num(r.refunds), refundCount: num(r.refund_count) });
  for (const r of payouts) Object.assign(get(r.currency), { payoutsPaidCount: num(r.payouts), payoutsPaidNetMinor: num(r.net), feesEarnedMinor: num(r.fees) });
  return [...by.values()].sort((a, b) => a.currency.localeCompare(b.currency));
}

/** The 12 months ending with `endMonth` (YYYY-MM): one row per month and currency that had any activity, newest month first. */
export async function monthlyFigures(endMonth: string): Promise<MonthFigures[]> {
  const { start, endExclusive } = monthWindow(endMonth);
  const payments = await paymentRows(start, endExclusive, true);
  const refunds = await refundRows(start, endExclusive, true);
  const payouts = await payoutRows(start, endExclusive, true);
  const by = new Map<string, MonthFigures>();
  const get = (month: string, currency: string) => {
    const key = `${month}|${currency}`;
    let f = by.get(key);
    if (!f) by.set(key, (f = { month, currency, grossMinor: 0, paymentCount: 0, refundsMinor: 0, feesEarnedMinor: 0 }));
    return f;
  };
  for (const r of payments) Object.assign(get(r.bucket!, r.currency), { grossMinor: num(r.gross), paymentCount: num(r.payments) });
  for (const r of refunds) get(r.bucket!, r.currency).refundsMinor = num(r.refunds);
  for (const r of payouts) get(r.bucket!, r.currency).feesEarnedMinor = num(r.fees);
  return [...by.values()].sort((a, b) => b.month.localeCompare(a.month) || a.currency.localeCompare(b.currency));
}

/* ---------- Balances right now ---------- */

const PAID_STATES = Prisma.sql`('PAID', 'SCHEDULED', 'COMPLETED')`;

/** What is left of a payment after its refunds (netOf in lib/payouts.ts). */
const LEFT = Prisma.sql`(p.amount_minor - COALESCE(p.refund_amount_minor, 0))`;

export async function balanceFigures(): Promise<BalanceFigures[]> {
  // Payments not already paid out: no payout, or one that is still pending (a cancelled payout lets its payments go).
  const held = await prisma.$queryRaw<{ currency: string; amount: bigint }[]>`
    SELECT p.currency, COALESCE(SUM(${LEFT}), 0) AS amount
    FROM payments p
    JOIN bookings b ON b.id = p.booking_id
    LEFT JOIN payouts po ON po.id = p.payout_id
    WHERE p.status IN ('CAPTURED', 'REFUNDED') AND p.needs_refund = false AND b.status IN ${PAID_STATES}
      AND (p.payout_id IS NULL OR po.status <> 'PAID')
    GROUP BY p.currency`;
  const pending = await prisma.$queryRaw<{ currency: string; amount: bigint }[]>`
    SELECT currency, COALESCE(SUM(net_minor), 0) AS amount FROM payouts WHERE status = 'PENDING' GROUP BY currency`;
  const owed = await prisma.$queryRaw<{ currency: string; amount: bigint }[]>`
    SELECT p.currency, COALESCE(SUM(${LEFT}), 0) AS amount
    FROM payments p
    WHERE p.status IN ('CAPTURED', 'REFUNDED') AND p.needs_refund = true
    GROUP BY p.currency`;
  const unallocated = await prisma.$queryRaw<{ currency: string; amount: bigint }[]>`
    SELECT p.currency, COALESCE(SUM(${LEFT}), 0) AS amount
    FROM payments p
    JOIN bookings b ON b.id = p.booking_id
    LEFT JOIN payouts po ON po.id = p.payout_id
    WHERE p.status IN ('CAPTURED', 'REFUNDED') AND p.needs_refund = false AND b.status NOT IN ${PAID_STATES}
      AND (p.payout_id IS NULL OR po.status <> 'PAID')
    GROUP BY p.currency`;
  const recover = await toRecoverByCurrency();

  const by = new Map<string, BalanceFigures>();
  const get = (currency: string) => {
    let f = by.get(currency);
    if (!f) by.set(currency, (f = { currency, heldForInfluencersMinor: 0, inPendingPayoutsMinor: 0, owedToCustomersMinor: 0, toRecoverMinor: 0, unallocatedMinor: 0 }));
    return f;
  };
  for (const r of held) get(r.currency).heldForInfluencersMinor = num(r.amount);
  for (const r of pending) get(r.currency).inPendingPayoutsMinor = num(r.amount);
  for (const r of owed) get(r.currency).owedToCustomersMinor = num(r.amount);
  for (const r of unallocated) get(r.currency).unallocatedMinor = num(r.amount);
  for (const r of recover) get(r.currency).toRecoverMinor = num(r.amount);
  return [...by.values()].filter((f) => f.heldForInfluencersMinor || f.inPendingPayoutsMinor || f.owedToCustomersMinor || f.toRecoverMinor || f.unallocatedMinor).sort((a, b) => a.currency.localeCompare(b.currency));
}

/**
 * postPayoutRefunds() (lib/payouts.ts) for every PAID payout at once, summed per currency: for each payout the refunds now on its
 * payments, minus the refunds counted in the payout when it was created, never below zero for that payout.
 */
export async function toRecoverByCurrency(): Promise<{ currency: string; amount: bigint }[]> {
  return prisma.$queryRaw<{ currency: string; amount: bigint }[]>`
    SELECT po.currency, COALESCE(SUM(GREATEST(COALESCE(s.refunded, 0) - po.refunds_minor, 0)), 0) AS amount
    FROM payouts po
    LEFT JOIN (
      SELECT payout_id, SUM(refund_amount_minor) AS refunded FROM payments WHERE payout_id IS NOT NULL GROUP BY payout_id
    ) s ON s.payout_id = po.id
    WHERE po.status = 'PAID'
    GROUP BY po.currency`;
}

/* ---------- Everything ---------- */

/** The day after `day` (YYYY-MM-DD, UTC). */
export function nextDay(day: Day): Day {
  return new Date(new Date(`${day}T00:00:00.000Z`).getTime() + 86_400_000).toISOString().slice(0, 10);
}

/** Ten small aggregate queries, one after the other. `endMonth` is the last month of the monthly table (YYYY-MM). */
export async function loadReportData(from: Day, to: Day, endMonth: string): Promise<ReportData> {
  const range = await rangeFigures(from, to);
  const monthly = await monthlyFigures(endMonth);
  const balances = await balanceFigures();
  return { range, monthly, balances };
}
