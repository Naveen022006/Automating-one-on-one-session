import { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";

/**
 * The queries behind the admin finance report (GET /api/admin/reports). Every figure is an aggregate computed in SQL (one row per
 * currency, or per month and currency), so the work done is the same whatever the size of the tables, and the queries are run one
 * after the other, never together, to stay inside the database's connection cap. A report is NINE queries: three for the range,
 * three for the months and three for the balances (REPORT_QUERY_COUNT).
 *
 * The figures follow the rules of the payout ledger (lib/payouts.ts) and must never disagree with the payout screens:
 *   - fees and payouts are the stored amounts of the PAID payouts, which createPayout() computed with buildPayoutTotals() (the
 *     influencer's fee override or the platform default, floor(net x bps / 10000), per currency). Nothing here recomputes a fee.
 *   - "refunded since" is postPayoutRefunds() in SQL: for each PAID payout, the refunds now on its payments minus the refunds
 *     already counted when it was created. The positive part of that difference is `toRecoverMinor` (what postPayoutRefunds returns,
 *     which clips at zero for each payout); the negative part (a refund that was counted in the payout and later failed) is reported
 *     as `refundsNotCompletedMinor` instead of being lost. tests/admin-reports.test.ts asserts the first equals postPayoutRefunds().
 *   - a payment counts as money paid by the customer when it is CAPTURED or REFUNDED (the same test as payoutBlocker's "not-paid"),
 *     and what is left of it is amount - refund_amount_minor (netOf in lib/payouts.ts).
 *   - a booking "holds" a payment when it is PAID, SCHEDULED or COMPLETED.
 * Money is an integer in minor units; a currency is never added to another.
 *
 * DAYS AND MONTHS ARE INDIAN STANDARD TIME (doc/14-india-localisation.md). The timestamp columns are `timestamp(3)` holding UTC wall-clock
 * time, so a report day D covers [D 00:00 IST, D+1 00:00 IST) = [D-1 18:30 UTC, D 18:30 UTC), and a month bucket is the IST month of the
 * stored instant (`istStart` and `istMonthOf` below). Only the grouping and the bounds depend on the zone: which payments, refunds and
 * payouts exist, and every amount, are exactly what they were, so the reconciliation identity and the payout maths are untouched.
 *
 * Every paid payment is in exactly one place (this is what makes the reconciliation identity hold; payoutBlocker and the approve / mark-paid check
 * refuse a flagged payment, but a payment can be flagged AFTER its payout was created or paid (a refund that failed by webhook, a duplicate found
 * later), and the report has to cope):
 *   1. in a PAID payout                                      -> paid out (and `flaggedPaidOutMinor` when it is also flagged)
 *   2. otherwise flagged `needs_refund`                      -> owed to customers (also when it sits in a PENDING payout)
 *   3. otherwise in a PENDING payout                         -> held (whatever its booking says now)
 *   4. otherwise, booking PAID / SCHEDULED / COMPLETED       -> held
 *   5. otherwise (booking REQUESTED, HELD, PENDING_PAYMENT, EXPIRED, CANCELLED or FAILED) -> not payable
 */

/** The number of SQL statements one report runs (asserted in the test). */
export const REPORT_QUERY_COUNT = 9;

/** A day written YYYY-MM-DD (an IST calendar day), already validated by the caller. */
export type Day = string;

const num = (v: bigint | number | null | undefined): number => (v == null ? 0 : Number(v));

/** The UTC wall-clock instant at which the IST calendar day `day` begins, as a SQL value comparable with a `timestamp(3)` column. Shared with the Money page (lib/admin/money.ts) so the two never cut a day differently. */
export const istStart = (day: Day) => Prisma.sql`(${day}::date::timestamp AT TIME ZONE 'Asia/Kolkata' AT TIME ZONE 'UTC')`;

/**
 * Narrows the money-in-a-range and balance figures to ONE influencer (the influencer filter of the Money page, lib/admin/money.ts). Without a
 * scope every query below is exactly the SQL it always was, so the Reports page is unchanged. An influencer's payments are the ones on bookings of
 * their services; their refunds are the refunds of those payments; their payouts carry their id.
 */
export interface ReportScope {
  influencerId?: string | null;
}

/** `AND <bookingColumn> IN (the bookings of this influencer's services)`, or nothing without a scope. */
const bookingsOfScope = (bookingColumn: Prisma.Sql, scope?: ReportScope) =>
  scope?.influencerId
    ? Prisma.sql`AND ${bookingColumn} IN (SELECT sb.id FROM bookings sb JOIN sessions ss ON ss.id = sb.session_id JOIN services sv ON sv.id = ss.service_id WHERE sv.influencer_id = ${scope.influencerId})`
    : Prisma.empty;
/** `AND <influencerColumn> = this influencer`, or nothing without a scope. */
const payoutsOfScope = (influencerColumn: Prisma.Sql, scope?: ReportScope) =>
  scope?.influencerId ? Prisma.sql`AND ${influencerColumn} = ${scope.influencerId}` : Prisma.empty;
/** The IST month (`YYYY-MM`) of a `timestamp(3)` column that holds UTC wall-clock time. */
const istMonthOf = (column: Prisma.Sql) => Prisma.sql`to_char(${column} AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM')`;

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
  /** YYYY-MM, IST. */
  month: string;
  currency: string;
  grossMinor: number;
  paymentCount: number;
  refundsMinor: number;
  feesEarnedMinor: number;
}

export interface BalanceFigures {
  currency: string;
  /** Not flagged, not in a PAID payout, and in a PENDING payout or on a booking PAID/SCHEDULED/COMPLETED: amount - refunded (before the fee). */
  heldForInfluencersMinor: number;
  /** PENDING payouts: the net amount still to be sent (after the fee). Their payments are in Held, or in Owed when flagged. */
  inPendingPayoutsMinor: number;
  /** Flagged `needs_refund` and not in a PAID payout: amount - refunded, the most a customer can still be given back. */
  owedToCustomersMinor: number;
  /** PAID payouts: refunds made on their payments since they were paid (the positive part of postPayoutRefunds). */
  toRecoverMinor: number;
  /** Not flagged, in no payout, booking not PAID/SCHEDULED/COMPLETED: no payout can ever include it. */
  unallocatedMinor: number;
  /** Flagged and already in a PAID payout: amount - refunded of money the influencer has received and a customer may still be owed. */
  flaggedPaidOutMinor: number;
  /** PAID payouts: refunds counted when the payout was created that are no longer counted (the refund failed), summed per payout. */
  refundsNotCompletedMinor: number;
}

export interface ReportData {
  range: RangeFigures[];
  monthly: MonthFigures[];
  balances: BalanceFigures[];
}

/** The 12 calendar months (IST) ending with `endMonth` (YYYY-MM): the first day of the first one, and the first day AFTER the last one. */
export function monthWindow(endMonth: string, months = 12): { start: Day; endExclusive: Day } {
  const [y, m] = endMonth.split("-").map(Number);
  const first = new Date(Date.UTC(y, m - 1 - (months - 1), 1));
  const after = new Date(Date.UTC(y, m, 1));
  return { start: first.toISOString().slice(0, 10), endExclusive: after.toISOString().slice(0, 10) };
}

/* ---------- Money in a window [start, endExclusive) ---------- */

type Bucket = { bucket: string | null; currency: string };

/**
 * Customer payments in the window, one row per currency, or per month and currency. Dated by `payments.created_at`: the moment
 * checkout began (the Razorpay order was created). The schema has no capture time, and a capture the recovery job applies later does not
 * move the date.
 */
async function paymentRows(start: Day, endExclusive: Day, byMonth: boolean, scope?: ReportScope) {
  const bucket = byMonth ? istMonthOf(Prisma.sql`created_at`) : Prisma.sql`NULL::text`;
  return prisma.$queryRaw<(Bucket & { gross: bigint; payments: bigint })[]>`
    SELECT ${bucket} AS bucket, currency, COALESCE(SUM(amount_minor), 0) AS gross, COUNT(*) AS payments
    FROM payments
    WHERE status IN ('CAPTURED', 'REFUNDED') AND created_at >= ${istStart(start)} AND created_at < ${istStart(endExclusive)} ${bookingsOfScope(Prisma.sql`booking_id`, scope)}
    GROUP BY 1, currency`;
}

/** Refunds recorded in the window (by `refunds.created_at`) that are pending or processed, in the currency of their payment. */
async function refundRows(start: Day, endExclusive: Day, byMonth: boolean, scope?: ReportScope) {
  const bucket = byMonth ? istMonthOf(Prisma.sql`r.created_at`) : Prisma.sql`NULL::text`;
  return prisma.$queryRaw<(Bucket & { refunds: bigint; refund_count: bigint })[]>`
    SELECT ${bucket} AS bucket, p.currency, COALESCE(SUM(r.amount_minor), 0) AS refunds, COUNT(*) AS refund_count
    FROM refunds r JOIN payments p ON p.id = r.payment_id
    WHERE r.status IN ('pending', 'processed') AND r.created_at >= ${istStart(start)} AND r.created_at < ${istStart(endExclusive)} ${bookingsOfScope(Prisma.sql`p.booking_id`, scope)}
    GROUP BY 1, p.currency`;
}

/** Payouts marked as paid in the range (by `payouts.paid_at`): the number, the amount sent and the fee kept, as stored when they were created. */
async function payoutRows(start: Day, endExclusive: Day, scope?: ReportScope) {
  return prisma.$queryRaw<{ currency: string; payouts: bigint; net: bigint; fees: bigint }[]>`
    SELECT currency, COUNT(*) AS payouts, COALESCE(SUM(net_minor), 0) AS net, COALESCE(SUM(fee_minor), 0) AS fees
    FROM payouts
    WHERE status = 'PAID' AND paid_at >= ${istStart(start)} AND paid_at < ${istStart(endExclusive)} ${payoutsOfScope(Prisma.sql`influencer_id`, scope)}
    GROUP BY currency`;
}

/** The fee kept on payouts marked as paid, per month of `paid_at` (the monthly table needs nothing else of a payout). */
async function payoutFeeRows(start: Day, endExclusive: Day) {
  return prisma.$queryRaw<{ bucket: string; currency: string; fees: bigint }[]>`
    SELECT ${istMonthOf(Prisma.sql`paid_at`)} AS bucket, currency, COALESCE(SUM(fee_minor), 0) AS fees
    FROM payouts
    WHERE status = 'PAID' AND paid_at >= ${istStart(start)} AND paid_at < ${istStart(endExclusive)}
    GROUP BY 1, currency`;
}

/** The figures of the chosen range, one entry per currency that had any activity in it, sorted by currency. Three queries. `scope` narrows them to one influencer (the Money page). */
export async function rangeFigures(from: Day, to: Day, scope?: ReportScope): Promise<RangeFigures[]> {
  const endExclusive = nextDay(to);
  // Sequential on purpose: one connection at a time.
  const payments = await paymentRows(from, endExclusive, false, scope);
  const refunds = await refundRows(from, endExclusive, false, scope);
  const payouts = await payoutRows(from, endExclusive, scope);
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

/** The 12 months ending with `endMonth` (YYYY-MM): one row per month and currency that had any activity, newest month first. Three queries. */
export async function monthlyFigures(endMonth: string): Promise<MonthFigures[]> {
  const { start, endExclusive } = monthWindow(endMonth);
  const payments = await paymentRows(start, endExclusive, true);
  const refunds = await refundRows(start, endExclusive, true);
  const fees = await payoutFeeRows(start, endExclusive);
  const by = new Map<string, MonthFigures>();
  const get = (month: string, currency: string) => {
    const key = `${month}|${currency}`;
    let f = by.get(key);
    if (!f) by.set(key, (f = { month, currency, grossMinor: 0, paymentCount: 0, refundsMinor: 0, feesEarnedMinor: 0 }));
    return f;
  };
  for (const r of payments) Object.assign(get(r.bucket!, r.currency), { grossMinor: num(r.gross), paymentCount: num(r.payments) });
  for (const r of refunds) get(r.bucket!, r.currency).refundsMinor = num(r.refunds);
  for (const r of fees) get(r.bucket, r.currency).feesEarnedMinor = num(r.fees);
  return [...by.values()].sort((a, b) => b.month.localeCompare(a.month) || a.currency.localeCompare(b.currency));
}

/* ---------- Balances right now ---------- */

/**
 * The balances: one scan of the paid payments (every payment is in exactly one place, see the top of this file), the pending payouts,
 * and the refunds-since of the paid payouts. Three queries. `scope` narrows them to one influencer (the Money page).
 */
export async function balanceFigures(scope?: ReportScope): Promise<BalanceFigures[]> {
  // `free` = in no payout that matters (a cancelled payout lets its payments go, so none should be left pointing at one).
  const places = await prisma.$queryRaw<
    { currency: string; held: bigint; owed: bigint; unallocated: bigint; flagged_paid: bigint }[]
  >`
    SELECT p.currency,
      COALESCE(SUM(left_minor) FILTER (WHERE NOT p.needs_refund AND (po.status = 'PENDING' OR (free AND b.status IN ('PAID', 'SCHEDULED', 'COMPLETED')))), 0) AS held,
      COALESCE(SUM(left_minor) FILTER (WHERE p.needs_refund AND (po.status = 'PENDING' OR free)), 0) AS owed,
      COALESCE(SUM(left_minor) FILTER (WHERE NOT p.needs_refund AND free AND b.status NOT IN ('PAID', 'SCHEDULED', 'COMPLETED')), 0) AS unallocated,
      COALESCE(SUM(left_minor) FILTER (WHERE p.needs_refund AND po.status = 'PAID'), 0) AS flagged_paid
    FROM (
      SELECT p.*, (p.amount_minor - COALESCE(p.refund_amount_minor, 0)) AS left_minor FROM payments p WHERE p.status IN ('CAPTURED', 'REFUNDED') ${bookingsOfScope(Prisma.sql`p.booking_id`, scope)}
    ) p
    JOIN bookings b ON b.id = p.booking_id
    LEFT JOIN payouts po ON po.id = p.payout_id
    CROSS JOIN LATERAL (SELECT (po.id IS NULL OR po.status NOT IN ('PENDING', 'PAID')) AS free) f
    GROUP BY p.currency`;
  const pending = await prisma.$queryRaw<{ currency: string; amount: bigint }[]>`
    SELECT currency, COALESCE(SUM(net_minor), 0) AS amount FROM payouts WHERE status = 'PENDING' ${payoutsOfScope(Prisma.sql`influencer_id`, scope)} GROUP BY currency`;
  const recover = await refundsSinceByCurrency(scope);

  const by = new Map<string, BalanceFigures>();
  const get = (currency: string) => {
    let f = by.get(currency);
    if (!f) {
      by.set(
        currency,
        (f = { currency, heldForInfluencersMinor: 0, inPendingPayoutsMinor: 0, owedToCustomersMinor: 0, toRecoverMinor: 0, unallocatedMinor: 0, flaggedPaidOutMinor: 0, refundsNotCompletedMinor: 0 }),
      );
    }
    return f;
  };
  for (const r of places) {
    const f = get(r.currency);
    f.heldForInfluencersMinor = num(r.held);
    f.owedToCustomersMinor = num(r.owed);
    f.unallocatedMinor = num(r.unallocated);
    f.flaggedPaidOutMinor = num(r.flagged_paid);
  }
  for (const r of pending) get(r.currency).inPendingPayoutsMinor = num(r.amount);
  for (const r of recover) {
    get(r.currency).toRecoverMinor = num(r.recover);
    get(r.currency).refundsNotCompletedMinor = num(r.not_completed);
  }
  return [...by.values()]
    .filter((f) => f.heldForInfluencersMinor || f.inPendingPayoutsMinor || f.owedToCustomersMinor || f.toRecoverMinor || f.unallocatedMinor || f.flaggedPaidOutMinor || f.refundsNotCompletedMinor)
    .sort((a, b) => a.currency.localeCompare(b.currency));
}

/**
 * postPayoutRefunds() (lib/payouts.ts) for every PAID payout at once, summed per currency. For each payout the difference is the
 * refunds now on its payments minus the refunds counted in the payout when it was created. postPayoutRefunds() returns the
 * positive part (`recover`); the negative part, which it clips away, is a refund that was counted at creation and failed since
 * (`not_completed`), and is kept apart so the identity still adds up.
 */
export async function refundsSinceByCurrency(scope?: ReportScope): Promise<{ currency: string; recover: bigint; not_completed: bigint }[]> {
  return prisma.$queryRaw<{ currency: string; recover: bigint; not_completed: bigint }[]>`
    SELECT d.currency, COALESCE(SUM(GREATEST(d.diff, 0)), 0) AS recover, COALESCE(SUM(GREATEST(-d.diff, 0)), 0) AS not_completed
    FROM (
      SELECT po.currency, COALESCE(s.refunded, 0) - po.refunds_minor AS diff
      FROM payouts po
      LEFT JOIN (
        SELECT payout_id, SUM(refund_amount_minor) AS refunded FROM payments WHERE payout_id IS NOT NULL GROUP BY payout_id
      ) s ON s.payout_id = po.id
      WHERE po.status = 'PAID' ${payoutsOfScope(Prisma.sql`po.influencer_id`, scope)}
    ) d
    GROUP BY d.currency`;
}

/* ---------- Everything ---------- */

/** The day after `day` (YYYY-MM-DD; a calendar day has no zone, so this is plain calendar arithmetic). */
export function nextDay(day: Day): Day {
  return new Date(new Date(`${day}T00:00:00.000Z`).getTime() + 86_400_000).toISOString().slice(0, 10);
}

/** Nine small aggregate queries, one after the other. `endMonth` is the last month of the monthly table (YYYY-MM). */
export async function loadReportData(from: Day, to: Day, endMonth: string): Promise<ReportData> {
  const range = await rangeFigures(from, to);
  const monthly = await monthlyFigures(endMonth);
  const balances = await balanceFigures();
  return { range, monthly, balances };
}
