/**
 * Pure dashboard helpers. Access control moved to influencer login sessions in Phase 7 (lib/auth/session.ts);
 * the old signed dashboard link is gone.
 */

/** A captured payment, as fed to the earnings aggregation. Kept minimal so the pure function is DB-free. */
export interface EarningsPaymentInput {
  amountMinor: number;
  currency: string;
  serviceId: string;
  serviceTitle: string;
  /** Amount already refunded (Phase 7). Net earnings subtract it. */
  refundedMinor?: number;
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
 * Pure earnings aggregation over a list of CAPTURED (or partly refunded) payments. Sums per currency and per
 * (service, currency), net of refunds. No DB access and no Prisma types so it is trivially unit-testable.
 */
export function aggregateEarnings(payments: EarningsPaymentInput[]): EarningsSummary {
  const currencyTotals = new Map<string, number>();
  const serviceTotals = new Map<string, ServiceEarnings>();

  for (const p of payments) {
    const net = p.amountMinor - (p.refundedMinor ?? 0);
    currencyTotals.set(p.currency, (currencyTotals.get(p.currency) ?? 0) + net);

    const key = `${p.serviceId}:${p.currency}`;
    const existing = serviceTotals.get(key);
    if (existing) {
      existing.amountMinor += net;
      existing.count += 1;
    } else {
      serviceTotals.set(key, {
        serviceId: p.serviceId,
        serviceTitle: p.serviceTitle,
        currency: p.currency,
        amountMinor: net,
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

/** RFC 4180 CSV cell. Also neutralises spreadsheet formula injection (cells starting with = + - @). */
export function csvCell(value: string | number | null | undefined): string {
  let s = value === null || value === undefined ? "" : String(value);
  if (typeof value !== "number" && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(rows: (string | number | null | undefined)[][]): string {
  return rows.map((r) => r.map(csvCell).join(",")).join("\r\n") + "\r\n";
}
