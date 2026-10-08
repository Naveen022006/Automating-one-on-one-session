import { signToken } from "@/lib/signing";

export const DASHBOARD_LINK_PURPOSE = "influencer-dashboard-link";

/**
 * Signed, expiring link that opens one influencer's dashboard. Like the Google connect link (buildConnectUrl in
 * lib/google-tokens.ts) there is no login yet, so possession of this link is what authorises viewing the
 * influencer's sessions and earnings. The purpose string is distinct from every other signed link so a token
 * minted for one use can never be replayed for another.
 */
export function buildDashboardUrl(influencerId: string, ttlSec = 7 * 86_400): string {
  const appUrl = process.env.APP_URL;
  if (!appUrl) throw new Error("APP_URL is not set");
  const t = signToken(DASHBOARD_LINK_PURPOSE, { i: influencerId }, ttlSec);
  return `${appUrl.replace(/\/$/, "")}/dashboard?t=${encodeURIComponent(t)}`;
}

/** A captured payment, as fed to the earnings aggregation. Kept minimal so the pure function is DB-free. */
export interface EarningsPaymentInput {
  amountMinor: number;
  currency: string;
  serviceId: string;
  serviceTitle: string;
}

export interface ServiceEarnings {
  serviceId: string;
  serviceTitle: string;
  currency: string;
  amountMinor: number;
  count: number;
}

export interface CurrencyEarnings {
  currency: string;
  amountMinor: number;
}

export interface EarningsSummary {
  /** Grand total per currency (a dashboard may mix currencies, so totals cannot be collapsed into one number). */
  totalsByCurrency: CurrencyEarnings[];
  /** One row per (service, currency), ordered by amount desc then title for a stable display. */
  byService: ServiceEarnings[];
}

/**
 * Pure earnings aggregation over a list of CAPTURED payments. Sums per currency and per (service, currency).
 * No DB access and no Prisma types so it is trivially unit-testable; the dashboard page builds the input array
 * from a Prisma query and passes it in.
 */
export function aggregateEarnings(payments: EarningsPaymentInput[]): EarningsSummary {
  const currencyTotals = new Map<string, number>();
  const serviceTotals = new Map<string, ServiceEarnings>();

  for (const p of payments) {
    currencyTotals.set(p.currency, (currencyTotals.get(p.currency) ?? 0) + p.amountMinor);

    const key = `${p.serviceId}:${p.currency}`;
    const existing = serviceTotals.get(key);
    if (existing) {
      existing.amountMinor += p.amountMinor;
      existing.count += 1;
    } else {
      serviceTotals.set(key, {
        serviceId: p.serviceId,
        serviceTitle: p.serviceTitle,
        currency: p.currency,
        amountMinor: p.amountMinor,
        count: 1,
      });
    }
  }

  const totalsByCurrency = [...currencyTotals.entries()]
    .map(([currency, amountMinor]) => ({ currency, amountMinor }))
    .sort((a, b) => (b.amountMinor - a.amountMinor) || a.currency.localeCompare(b.currency));

  const byService = [...serviceTotals.values()].sort(
    (a, b) => (b.amountMinor - a.amountMinor) || a.serviceTitle.localeCompare(b.serviceTitle),
  );

  return { totalsByCurrency, byService };
}
