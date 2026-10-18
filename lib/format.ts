import { APP_CURRENCY, APP_LOCALE_DEFAULT, formatDateTime, formatDuration, formatTime as formatIstTime } from "@/lib/india";

/**
 * Human-readable formatting shared by emails, WhatsApp/SMS and the UI. The product is for India only (doc/14-india-localisation.md):
 * every time is shown in Indian Standard Time with "IST" visible, never as a raw ISO timestamp, whoever is looking. The helpers live
 * in lib/india.ts; this file keeps the names the rest of the app imports and the one environment value, `APP_LOCALE`, which is the
 * locale of NUMBERS and MONEY (default en-IN: lakh grouping, "₹1,25,000.00").
 */

export const DEFAULT_LOCALE = process.env.APP_LOCALE || APP_LOCALE_DEFAULT;

/** Money from integer minor units. `currency` is the stored code of the row (INR for everything created now). */
export function formatMoney(minor: number, currency: string = APP_CURRENCY, locale = DEFAULT_LOCALE): string {
  try {
    return new Intl.NumberFormat(locale, { style: "currency", currency }).format(minor / 100);
  } catch {
    return `${(minor / 100).toFixed(2)} ${currency}`;
  }
}

/** "Mon, 12 Oct 2026, 11:00 AM IST". */
export function formatSessionTime(date: Date): string {
  return formatDateTime(date);
}

/** "11:00 AM" (IST). */
export function formatTime(date: Date, opts: { seconds?: boolean } = {}): string {
  return formatIstTime(date, opts);
}

export { formatDuration };
