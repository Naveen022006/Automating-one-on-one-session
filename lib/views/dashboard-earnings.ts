import { aggregateEarnings, type CurrencyEarnings } from "@/lib/dashboard";
import { earningsPayments } from "@/lib/dashboard-data";
import { addDays, istDayStart, istMonthStart, istToday } from "@/lib/india";
import { EARNINGS_ROW_CAP, parseReportDay } from "./dashboard-params";

/**
 * The Earnings page's data, for GET /api/dashboard/earnings. Scoped to the influencer id from the
 * login session. Days are Indian Standard Time calendar days ("by the date the payment was made (IST)"): a day runs from 00:00 IST
 * (18:30 UTC the evening before) for 24 hours.
 */

export interface DashboardEarningsView {
  /** The range actually used, YYYY-MM-DD (IST): the 1st of this month to today unless valid dates were given. */
  from: string;
  to: string;
  /** Captured (or refunded) payments counted in the range (at most the row cap, see `truncated`). */
  paymentCount: number;
  /** How many of them were refunded in whole or in part. */
  refundedCount: number;
  /** True when the range holds more payments than one request reads: the first `paymentCount` (oldest first) are summed, the rest are not. */
  truncated: boolean;
  summary: {
    totalsByCurrency: CurrencyEarnings[];
    byService: { serviceTitle: string; currency: string; amountMinor: number; count: number }[];
  };
}

export async function loadEarningsView(
  influencerId: string,
  params: { from?: string | null; to?: string | null },
  now = new Date(),
  opts: { rowCap?: number } = {},
): Promise<DashboardEarningsView> {
  const cap = opts.rowCap ?? EARNINGS_ROW_CAP;
  const from = parseReportDay(params.from) ?? istMonthStart(now);
  const to = parseReportDay(params.to) ?? istToday(now);
  // One more than the cap tells "exactly the cap" from "more than the cap" without a second query.
  const loaded = await earningsPayments(influencerId, istDayStart(from), istDayStart(addDays(to, 1)), { take: cap + 1 });
  const truncated = loaded.length > cap;
  const payments = truncated ? loaded.slice(0, cap) : loaded;
  const summary = aggregateEarnings(payments);
  return {
    from,
    to,
    paymentCount: payments.length,
    refundedCount: payments.reduce((n, p) => n + (p.refundedMinor ? 1 : 0), 0),
    truncated,
    summary: {
      totalsByCurrency: summary.totalsByCurrency,
      byService: summary.byService.map((s) => ({ serviceTitle: s.serviceTitle, currency: s.currency, amountMinor: s.amountMinor, count: s.count })),
    },
  };
}
