/**
 * Human-readable formatting shared by emails, WhatsApp/SMS and the UI. Customer-facing times are always shown in
 * the customer's own timezone with the zone name visible, never as a raw ISO timestamp.
 */

export const DEFAULT_LOCALE = process.env.APP_LOCALE || "en-IN";

export function formatMoney(minor: number, currency: string, locale = DEFAULT_LOCALE): string {
  try {
    return new Intl.NumberFormat(locale, { style: "currency", currency }).format(minor / 100);
  } catch {
    return `${(minor / 100).toFixed(2)} ${currency}`;
  }
}

function safeZone(tz: string | null | undefined, fallback = "UTC"): string {
  if (!tz) return fallback;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return tz;
  } catch {
    return fallback;
  }
}

/** "Mon, 12 Oct 2026, 11:00 am IST" in the given timezone. */
export function formatSessionTime(date: Date, tz: string | null | undefined, locale = DEFAULT_LOCALE): string {
  return new Intl.DateTimeFormat(locale, {
    timeZone: safeZone(tz),
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(date);
}

/** "11:00 am" in the given timezone. */
export function formatTime(date: Date, tz: string | null | undefined, locale = DEFAULT_LOCALE): string {
  return new Intl.DateTimeFormat(locale, { timeZone: safeZone(tz), hour: "numeric", minute: "2-digit" }).format(date);
}

/** The timezone a customer-facing message should use: the customer's, else the influencer's. */
export function customerZone(customerTz: string | null | undefined, influencerTz: string | null | undefined): string {
  return safeZone(customerTz, safeZone(influencerTz, "UTC"));
}

export function formatDuration(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? `${h} h ${m} min` : `${h} h`;
}
