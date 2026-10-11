import { loadReportData, type Day } from "@/lib/admin/reports";
import { parseReportDay } from "./dashboard-params";

/**
 * The admin Reports page's data, for GET /api/admin/reports. The caller has already passed the admin gate (`requireAdminMfa()`).
 * Aggregates only: no personal data and no ids leave the server. Days are UTC calendar days and `to` is inclusive.
 */

/** The longest range one request may read, in days (both ends included). */
export const MAX_REPORT_DAYS = 366;

const DAY_MS = 86_400_000;

export interface AdminReportsView {
  /** The range actually used, YYYY-MM-DD (UTC). */
  from: string;
  to: string;
  generatedAt: Date;
  /** Per currency, for [from, to]. A currency with no activity in the range is not listed. */
  range: {
    currency: string;
    /** Payments CAPTURED or REFUNDED, by the day checkout began (the day the payment's order was created; the schema keeps no capture time). */
    grossMinor: number;
    paymentCount: number;
    /** Refunds pending or processed, by the day the refund was made (they may belong to earlier payments). */
    refundsMinor: number;
    refundCount: number;
    /** Gross less refunds of the period: not the same payments, so it can be negative. */
    netMinor: number;
    /** Payouts marked as paid in the range, by the day they were paid. */
    payoutsPaidCount: number;
    payoutsPaidNetMinor: number;
    /** The platform fee kept on those payouts. */
    feesEarnedMinor: number;
  }[];
  /** The 12 months ending with the month of `to` (never later than this month), newest first. A month with nothing in it is not listed. */
  monthly: { month: string; currency: string; grossMinor: number; refundsMinor: number; feesEarnedMinor: number; paymentCount: number }[];
  /** Right now, whatever the range, per currency. A currency with nothing in any of the figures is not listed. Definitions: lib/admin/reports.ts. */
  balances: {
    currency: string;
    heldForInfluencersMinor: number;
    inPendingPayoutsMinor: number;
    owedToCustomersMinor: number;
    toRecoverMinor: number;
    unallocatedMinor: number;
    /** Flagged for refund and already in a sent payout. */
    flaggedPaidOutMinor: number;
    /** Refunds counted in a sent payout that failed afterwards. */
    refundsNotCompletedMinor: number;
  }[];
}

export type ReportsRange = { ok: true; from: Day; to: Day } | { ok: false; error: string };

const isoDay = (d: Date) => d.toISOString().slice(0, 10);
const daysBetween = (from: Day, to: Day) => Math.round((new Date(`${to}T00:00:00.000Z`).getTime() - new Date(`${from}T00:00:00.000Z`).getTime()) / DAY_MS) + 1;

/**
 * `?from=` / `?to=`: a value that is not a real calendar day between 2000 and 2100 is ignored, like on the earnings page, and the
 * default is used instead (`to` = today, `from` = the 1st of the month of `to`). Only a range that is valid day by day but makes no
 * sense (the start after the end, or longer than MAX_REPORT_DAYS) is refused, with a sentence for the page to show.
 */
export function parseReportsRange(params: { from?: string | null; to?: string | null }, now = new Date()): ReportsRange {
  const to = parseReportDay(params.to) ?? isoDay(now);
  const from = parseReportDay(params.from) ?? `${to.slice(0, 8)}01`;
  if (from > to) return { ok: false, error: "The start date is after the end date." };
  if (daysBetween(from, to) > MAX_REPORT_DAYS) return { ok: false, error: `Choose a range of at most ${MAX_REPORT_DAYS} days.` };
  return { ok: true, from, to };
}

export async function loadAdminReportsView(from: Day, to: Day, now = new Date()): Promise<AdminReportsView> {
  // The monthly table ends with the month of `to`, but never shows months that have not happened yet.
  const thisMonth = isoDay(now).slice(0, 7);
  const endMonth = to.slice(0, 7) < thisMonth ? to.slice(0, 7) : thisMonth;
  const data = await loadReportData(from, to, endMonth);
  return {
    from,
    to,
    generatedAt: now,
    range: data.range.map((r) => ({
      currency: r.currency,
      grossMinor: r.grossMinor,
      paymentCount: r.paymentCount,
      refundsMinor: r.refundsMinor,
      refundCount: r.refundCount,
      netMinor: r.grossMinor - r.refundsMinor,
      payoutsPaidCount: r.payoutsPaidCount,
      payoutsPaidNetMinor: r.payoutsPaidNetMinor,
      feesEarnedMinor: r.feesEarnedMinor,
    })),
    monthly: data.monthly.map((m) => ({ month: m.month, currency: m.currency, grossMinor: m.grossMinor, refundsMinor: m.refundsMinor, feesEarnedMinor: m.feesEarnedMinor, paymentCount: m.paymentCount })),
    balances: data.balances.map((b) => ({
      currency: b.currency,
      heldForInfluencersMinor: b.heldForInfluencersMinor,
      inPendingPayoutsMinor: b.inPendingPayoutsMinor,
      owedToCustomersMinor: b.owedToCustomersMinor,
      toRecoverMinor: b.toRecoverMinor,
      unallocatedMinor: b.unallocatedMinor,
      flaggedPaidOutMinor: b.flaggedPaidOutMinor,
      refundsNotCompletedMinor: b.refundsNotCompletedMinor,
    })),
  };
}
