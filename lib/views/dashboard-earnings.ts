import { aggregateEarnings, type CurrencyEarnings } from "@/lib/dashboard";
import { earningsPayments } from "@/lib/dashboard-data";

/**
 * The Earnings page's data, for the old Next page and GET /api/dashboard/earnings. Scoped to the influencer id from the
 * login session. Days are UTC calendar days ("by the date the payment was made (UTC)").
 */

const DAY_MS = 86_400_000;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** A real calendar day written YYYY-MM-DD ("2026-02-31" and "2026-13-01" are not). */
function isDay(value: string | null | undefined): value is string {
  if (!value || !DAY.test(value)) return false;
  const d = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

export interface DashboardEarningsView {
  /** The range actually used, YYYY-MM-DD (UTC): the 1st of this month to today unless valid dates were given. */
  from: string;
  to: string;
  /** Captured (or refunded) payments in the range. */
  paymentCount: number;
  /** How many of them were refunded in whole or in part. */
  refundedCount: number;
  summary: {
    totalsByCurrency: CurrencyEarnings[];
    byService: { serviceTitle: string; currency: string; amountMinor: number; count: number }[];
  };
}

export async function loadEarningsView(
  influencerId: string,
  params: { from?: string | null; to?: string | null },
  now = new Date(),
): Promise<DashboardEarningsView> {
  const defaultFrom = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString().slice(0, 10);
  const from = isDay(params.from) ? params.from : defaultFrom;
  const to = isDay(params.to) ? params.to : now.toISOString().slice(0, 10);
  const payments = await earningsPayments(influencerId, new Date(`${from}T00:00:00.000Z`), new Date(new Date(`${to}T00:00:00.000Z`).getTime() + DAY_MS));
  const summary = aggregateEarnings(payments);
  return {
    from,
    to,
    paymentCount: payments.length,
    refundedCount: payments.reduce((n, p) => n + (p.refundedMinor ? 1 : 0), 0),
    summary: {
      totalsByCurrency: summary.totalsByCurrency,
      byService: summary.byService.map((s) => ({ serviceTitle: s.serviceTitle, currency: s.currency, amountMinor: s.amountMinor, count: s.count })),
    },
  };
}
