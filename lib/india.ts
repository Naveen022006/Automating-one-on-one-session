/**
 * The one place that says "this product is for India" (doc/14-india-localisation.md). PURE and browser-safe: it imports nothing and
 * reads no environment, so the web bundle and the server share it (it is on the allowlist in web/vite-server-guard.ts).
 *
 * Everything customer-visible is in Indian Standard Time: UTC+05:30 all year, no daylight saving. Because the offset is fixed, the
 * day, month and clock arithmetic below is plain integer arithmetic on the UTC instant, with no time-zone database, so the
 * server, the browser and the tests always agree. Stored instants stay UTC; only the reading of them is IST.
 *
 * Dates and times are rendered in English with fixed month and weekday names ("Sat, 25 Oct 2026, 6:30 PM IST") so the text a customer
 * gets by e-mail or WhatsApp is the same as the one the page shows, whatever the ICU version of the machine. `APP_LOCALE` therefore
 * governs numbers and money only (see formatMoney / formatCount).
 */

export const APP_TIME_ZONE = "Asia/Kolkata";
export const APP_TIME_ZONE_LABEL = "IST";
export const APP_TIME_ZONE_NAME = "Indian Standard Time";
/** The plain sentence pages show where a time zone picker used to be. */
export const APP_TIME_ZONE_NOTE = `All times are in ${APP_TIME_ZONE_NAME} (${APP_TIME_ZONE_LABEL}).`;
export const APP_LOCALE_DEFAULT = "en-IN";
export const APP_CURRENCY = "INR";
export const APP_COUNTRY = "IN";
export const APP_CALLING_CODE = "+91";
/** IST is UTC+05:30 all year. */
export const IST_OFFSET_MINUTES = 330;

const IST_OFFSET_MS = IST_OFFSET_MINUTES * 60_000;
const DAY_MS = 86_400_000;

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

/* ---------- Time zone input ---------- */

/** True for a string the runtime knows as an IANA time zone ("Europe/London", "UTC", ...). */
export function isKnownTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

/**
 * What the server does with a time zone a client sends (old browsers, scripts, the previous version of the app): a real IANA zone is
 * accepted and replaced by IST (never stored as sent); anything else is an error the caller turns into a 400.
 */
export function normaliseTimeZoneInput(value: unknown): { ok: true; timeZone: typeof APP_TIME_ZONE } | { ok: false; error: string } {
  if (typeof value !== "string" || value.length === 0 || value.length > 64 || !isKnownTimeZone(value)) {
    return { ok: false, error: "Invalid time zone. This service uses Indian Standard Time (IST) only." };
  }
  return { ok: true, timeZone: APP_TIME_ZONE };
}

/* ---------- IST calendar arithmetic ---------- */

export interface IstParts {
  year: number;
  /** 1-12. */
  month: number;
  day: number;
  /** 0-23. */
  hour: number;
  minute: number;
  second: number;
  /** 0 = Sunday ... 6 = Saturday. */
  weekday: number;
}

/** The IST wall-clock fields of an instant. */
export function istParts(d: Date): IstParts {
  const s = new Date(d.getTime() + IST_OFFSET_MS);
  return {
    year: s.getUTCFullYear(),
    month: s.getUTCMonth() + 1,
    day: s.getUTCDate(),
    hour: s.getUTCHours(),
    minute: s.getUTCMinutes(),
    second: s.getUTCSeconds(),
    weekday: s.getUTCDay(),
  };
}

const p2 = (n: number) => String(n).padStart(2, "0");

/** The IST calendar day of an instant, "YYYY-MM-DD". */
export function istDate(d: Date): string {
  const p = istParts(d);
  return `${String(p.year).padStart(4, "0")}-${p2(p.month)}-${p2(p.day)}`;
}

/** The IST calendar month of an instant, "YYYY-MM". */
export function istMonth(d: Date): string {
  return istDate(d).slice(0, 7);
}

/** Today's IST calendar day. */
export function istToday(now: Date = new Date()): string {
  return istDate(now);
}

/** The first day of the IST month containing the instant, "YYYY-MM-01". */
export function istMonthStart(d: Date): string {
  return `${istMonth(d)}-01`;
}

/** The instant at which the IST calendar day `day` ("YYYY-MM-DD") begins: 00:00 IST = 18:30 UTC the evening before. */
export function istDayStart(day: string): Date {
  return new Date(Date.parse(`${day}T00:00:00.000Z`) - IST_OFFSET_MS);
}

/** The calendar day `n` days after `day` ("YYYY-MM-DD"); days carry no zone, so this is calendar arithmetic. */
export function addDays(day: string, n: number): string {
  return new Date(Date.parse(`${day}T00:00:00.000Z`) + n * DAY_MS).toISOString().slice(0, 10);
}

/** [start, end) of an IST calendar day, as instants. */
export function istDayBounds(day: string): { from: Date; to: Date } {
  const from = istDayStart(day);
  return { from, to: new Date(from.getTime() + DAY_MS) };
}

/** The first day ("YYYY-MM-01") of the first of the `months` calendar months that end with month `ym` ("YYYY-MM"). */
export function istMonthsBack(ym: string, months: number): string {
  const [y, m] = ym.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 - (months - 1), 1));
  return `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-01`;
}

/** An ISO 8601 string with the IST offset: "2026-10-18T05:30:00.000+05:30". For CSV cells that must read as IST. */
export function istIso(d: Date): string {
  const p = istParts(d);
  const ms = String(d.getUTCMilliseconds()).padStart(3, "0");
  return `${String(p.year).padStart(4, "0")}-${p2(p.month)}-${p2(p.day)}T${p2(p.hour)}:${p2(p.minute)}:${p2(p.second)}.${ms}+05:30`;
}

/* ---------- Dates and times ---------- */

/** "Sat, 25 Oct 2026" (or "Sat, 25 Oct" without the year, "25 Oct 2026" without the weekday) in IST. */
export function formatDate(d: Date, opts: { weekday?: boolean; year?: boolean } = {}): string {
  const { weekday = true, year = true } = opts;
  const p = istParts(d);
  const core = `${p.day} ${MONTHS[p.month - 1]}${year ? ` ${p.year}` : ""}`;
  return weekday ? `${WEEKDAYS[p.weekday]}, ${core}` : core;
}

/** "6:30 PM" in IST. */
export function formatTime(d: Date): string {
  const { hour, minute } = istParts(d);
  return `${hour % 12 === 0 ? 12 : hour % 12}:${p2(minute)} ${hour < 12 ? "AM" : "PM"}`;
}

/** "Sat, 25 Oct 2026, 6:30 PM IST". `label: false` drops the "IST" (a page that already says all times are IST). */
export function formatDateTime(d: Date, opts: { weekday?: boolean; year?: boolean; label?: boolean } = {}): string {
  const { label = true, ...date } = opts;
  return `${formatDate(d, date)}, ${formatTime(d)}${label ? ` ${APP_TIME_ZONE_LABEL}` : ""}`;
}

/** A wall-clock "HH:mm" (an availability rule's start or end, already IST) as "6:30 PM". Anything else comes back unchanged. */
export function formatClock(hhmm: string): string {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(hhmm);
  if (!m) return hhmm;
  const h = Number(m[1]);
  return `${h % 12 === 0 ? 12 : h % 12}:${m[2]} ${h < 12 ? "AM" : "PM"}`;
}

/** A calendar day written "YYYY-MM-DD" (no time, no zone), shown as "Sat, 25 Oct 2026". Anything else comes back unchanged. */
export function formatDay(day: string, opts: { weekday?: boolean; year?: boolean } = {}): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!m) return day;
  const noon = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12));
  if (Number.isNaN(noon.getTime())) return day;
  const { weekday = true, year = true } = opts;
  const core = `${noon.getUTCDate()} ${MONTHS[noon.getUTCMonth()]}${year ? ` ${noon.getUTCFullYear()}` : ""}`;
  return weekday ? `${WEEKDAYS[noon.getUTCDay()]}, ${core}` : core;
}

/** "Oct 2026" for "2026-10". Anything else comes back unchanged. */
export function formatMonth(ym: string): string {
  const m = /^(\d{4})-(\d{2})$/.exec(ym);
  if (!m || Number(m[2]) < 1 || Number(m[2]) > 12) return ym;
  return `${MONTHS[Number(m[2]) - 1]} ${m[1]}`;
}

/** "30 min", "1 h", "1 h 30 min". */
export function formatDuration(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? `${h} h ${m} min` : `${h} h`;
}

/* ---------- Numbers and money ---------- */

/** Money from integer minor units. Indian digit grouping: 12500000 paise -> "₹1,25,000.00". Another currency (an old row) keeps its own symbol. */
export function formatMoney(minor: number, currency: string = APP_CURRENCY, locale: string = APP_LOCALE_DEFAULT): string {
  try {
    return new Intl.NumberFormat(locale, { style: "currency", currency }).format(minor / 100);
  } catch {
    return `${(minor / 100).toFixed(2)} ${currency}`;
  }
}

export const CURRENCY_ERROR = "Prices are in Indian rupees (INR) only.";

/** True for the one currency the product sells in (case-insensitive, so "inr" from an old client passes). */
export function isAppCurrency(code: string): boolean {
  return code.trim().toUpperCase() === APP_CURRENCY;
}

/** Rupees from paise. */
export function formatInr(minor: number, locale: string = APP_LOCALE_DEFAULT): string {
  return formatMoney(minor, APP_CURRENCY, locale);
}

/** A whole number with Indian grouping: 1250000 -> "12,50,000". */
export function formatCount(n: number, locale: string = APP_LOCALE_DEFAULT): string {
  return new Intl.NumberFormat(locale).format(n);
}

/* ---------- Indian mobile numbers ---------- */

export const INDIAN_MOBILE_ERROR = "Enter a 10-digit Indian mobile number";
/** For `<input pattern>`: ten digits, the first 6-9. */
export const INDIAN_MOBILE_PATTERN = "[6-9][0-9]{9}";

const INDIAN_MOBILE = /^[6-9]\d{9}$/;

/**
 * The 10 national digits of an Indian mobile number, or null. Accepts `9876543210`, `09876543210`, `+91 98765 43210`, `919876543210`,
 * `0091-98765-43210`, with spaces, hyphens, dots and brackets. A landline (first digit 2-5), another country's number, a short or long
 * one, or anything with letters is null.
 */
export function indianMobileDigits(input: string): string | null {
  const s = input.trim();
  if (s.length === 0 || s.length > 32 || /[^\d\s().+-]/.test(s)) return null;
  const hasPlus = s.startsWith("+");
  if (s.indexOf("+") > 0 || s.lastIndexOf("+") > 0) return null;
  const digits = s.replace(/\D/g, "");
  let national: string;
  if (hasPlus) {
    if (!digits.startsWith("91")) return null;
    national = digits.slice(2);
  } else if (digits.startsWith("0091")) {
    national = digits.slice(4);
  } else if (digits.length === 12 && digits.startsWith("91")) {
    national = digits.slice(2);
  } else if (digits.length === 11 && digits.startsWith("0")) {
    national = digits.slice(1);
  } else {
    national = digits;
  }
  return INDIAN_MOBILE.test(national) ? national : null;
}

/** "+919876543210" for any accepted spelling of an Indian mobile number, else null. */
export function parseIndianMobile(input: string): string | null {
  const national = indianMobileDigits(input);
  return national ? `${APP_CALLING_CODE}${national}` : null;
}

/** "+91 98765 43210" for display. A value that is not an Indian mobile number comes back unchanged. */
export function formatIndianMobile(input: string): string {
  const national = indianMobileDigits(input);
  return national ? `${APP_CALLING_CODE} ${national.slice(0, 5)} ${national.slice(5)}` : input;
}
