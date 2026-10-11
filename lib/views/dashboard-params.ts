/**
 * Query-string rules shared by the dashboard list pages (Sessions, Messages, Earnings) and their JSON endpoints, so an odd URL
 * means the same thing on every screen that links to it. Pure.
 */

/** `?page=` as a whole number from 1 to 9999; anything else (missing, 0, negative, 2.5, "abc", 1e9) is page 1. */
export function parsePageParam(value: string | null | undefined): number {
  const n = Number.parseInt(value ?? "1", 10);
  return Number.isFinite(n) && n > 0 && n < 10_000 ? n : 1;
}

/** The days an earnings URL may name. Anything outside is treated like any other malformed date (see parseReportDay). */
export const MIN_REPORT_DAY = "2000-01-01";
export const MAX_REPORT_DAY = "2100-12-31";

/**
 * A `?from=` / `?to=` value: the same string back when it is a REAL calendar day written YYYY-MM-DD between 2000-01-01 and
 * 2100-12-31, else null. "2026-02-31" and "2024-13-01" are not days; "0000-01-01" (a valid JavaScript date that Postgres refuses)
 * and "9999-12-31" are outside the window, so no URL can reach the database with a year it cannot store or ask for a century of rows.
 */
export function parseReportDay(value: string | null | undefined): string | null {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value) || value < MIN_REPORT_DAY || value > MAX_REPORT_DAY) return null;
  const d = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value ? value : null;
}

/** The most payments one earnings summary or one CSV file reads, so a single request can never load an influencer's whole history. */
export const EARNINGS_ROW_CAP = 10_000;
