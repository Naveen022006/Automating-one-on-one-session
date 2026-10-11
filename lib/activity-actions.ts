/**
 * What the influencer account activity log can contain (doc/13-product-build-plan.md, WP-C). Pure: no imports, so the wording and the
 * allowlist can be unit tested without a database and the browser could import the types.
 *
 * The log is a security and dispute trail, not a copy of the data. Every action has an explicit allowlist of `detail` keys
 * (`ACTIVITY_DETAIL_KEYS`); `recordActivity` drops everything else, so a customer's name, e-mail or phone, a token, a password or a
 * full account number cannot reach the table even by mistake in a call site. Values are numbers, booleans or short strings.
 */

/** action -> the label shown in the "What" column when there is nothing more to say. */
export const ACTIVITY_ACTIONS = {
  "auth.registered": "Account created",
  "auth.login": "Signed in",
  "auth.login_failed": "Failed sign-in",
  "auth.email_verified": "E-mail address verified",
  "auth.password_changed": "Password changed",
  "auth.password_reset": "Password reset",
  "auth.logout_all": "Signed out everywhere",
  "auth.session_revoked": "Device signed out",
  "auth.reauthenticated": "Password confirmed",
  "profile.updated": "Profile updated",
  "service.created": "Service created",
  "service.updated": "Service updated",
  "availability.changed": "Availability changed",
  "booking.cancelled": "Booking cancelled",
  "booking.rescheduled": "Booking rescheduled",
  "booking.request_approved": "Booking request approved",
  "booking.request_declined": "Booking request declined",
  "booking.refunded": "Refund issued",
  "customers.erased": "Customer data erased",
  "payout_account.updated": "Payout details changed",
  "google.connected": "Google connected",
  "google.disconnected": "Google disconnected",
  "whatsapp.connected": "WhatsApp connected",
  "whatsapp.disconnected": "WhatsApp disconnected",
  "onboarding.completed": "Onboarding completed",
  "earnings.exported": "Earnings exported",
} as const;

export type ActivityAction = keyof typeof ACTIVITY_ACTIONS;

export type ActivityDetail = Record<string, string | number | boolean | null>;

/** The only `detail` keys each action may store. Anything else is dropped before the insert. */
export const ACTIVITY_DETAIL_KEYS: Record<ActivityAction, readonly string[]> = {
  "auth.registered": [],
  "auth.login": [],
  "auth.login_failed": [],
  "auth.email_verified": [],
  "auth.password_changed": [],
  "auth.password_reset": [],
  "auth.logout_all": ["sessions"],
  "auth.session_revoked": [],
  "auth.reauthenticated": [],
  "profile.updated": ["fields", "slugFrom", "slugTo"],
  "service.created": ["serviceId", "title", "priceTo", "currency", "activeTo"],
  "service.updated": ["serviceId", "title", "priceFrom", "priceTo", "currency", "activeFrom", "activeTo"],
  "availability.changed": ["change"],
  "booking.cancelled": ["bookingId"],
  "booking.rescheduled": ["bookingId"],
  "booking.request_approved": ["bookingId"],
  "booking.request_declined": ["bookingId"],
  "booking.refunded": ["bookingId", "amountMinor", "currency", "status"],
  "customers.erased": ["erased", "blocked"],
  "payout_account.updated": ["method", "destination"],
  "google.connected": ["account"],
  "google.disconnected": ["account"],
  "whatsapp.connected": ["phone"],
  "whatsapp.disconnected": ["phone"],
  "onboarding.completed": [],
  "earnings.exported": ["from", "to", "rows"],
};

export function isActivityAction(value: unknown): value is ActivityAction {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(ACTIVITY_ACTIONS, value);
}

/** The longest string a detail value may hold (longer ones are cut). */
export const ACTIVITY_DETAIL_MAX_LENGTH = 120;

/**
 * The detail that may be stored for `action`: only the allowlisted keys, only strings (control characters removed, cut to
 * 120 characters), finite numbers, booleans and null. Returns undefined when nothing is left.
 */
export function sanitiseActivityDetail(action: ActivityAction, detail: unknown): ActivityDetail | undefined {
  if (detail === null || typeof detail !== "object" || Array.isArray(detail)) return undefined;
  const source = detail as Record<string, unknown>;
  const out: ActivityDetail = {};
  for (const key of ACTIVITY_DETAIL_KEYS[action]) {
    if (!Object.prototype.hasOwnProperty.call(source, key)) continue;
    const value = source[key];
    if (typeof value === "string") {
      // eslint-disable-next-line no-control-regex
      out[key] = value.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, ACTIVITY_DETAIL_MAX_LENGTH);
    } else if (typeof value === "number" && Number.isFinite(value)) out[key] = value;
    else if (typeof value === "boolean" || value === null) out[key] = value;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/* ---------- wording ---------- */

function str(detail: unknown, key: string): string | null {
  if (detail === null || typeof detail !== "object") return null;
  const v = (detail as Record<string, unknown>)[key];
  return typeof v === "string" && v.trim() !== "" ? v : null;
}

function num(detail: unknown, key: string): number | null {
  if (detail === null || typeof detail !== "object") return null;
  const v = (detail as Record<string, unknown>)[key];
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** 100000 -> "1,000"; 150050 -> "1,500.50" (amounts are stored in minor units, 1/100 of the currency). */
function money(minor: number): string {
  try {
    return new Intl.NumberFormat("en-IN", { maximumFractionDigits: 2 }).format(minor / 100);
  } catch {
    return (minor / 100).toFixed(2);
  }
}

const ARROW = " → ";

const AVAILABILITY_CHANGES: Record<string, string> = {
  "rule-added": "weekly time added",
  "rule-updated": "weekly time changed",
  "rule-removed": "weekly time removed",
  "day-blocked": "day blocked",
  "day-unblocked": "day unblocked",
};

function serviceSummary(action: "service.created" | "service.updated", detail: unknown): string {
  const title = str(detail, "title");
  const currency = str(detail, "currency");
  const parts: string[] = [];
  const priceFrom = num(detail, "priceFrom");
  const priceTo = num(detail, "priceTo");
  if (priceTo !== null) {
    parts.push(
      priceFrom !== null ? `price ${money(priceFrom)}${ARROW}${money(priceTo)}${currency ? ` ${currency}` : ""}` : `price ${money(priceTo)}${currency ? ` ${currency}` : ""}`,
    );
  }
  const activeTo = detail !== null && typeof detail === "object" ? (detail as Record<string, unknown>).activeTo : undefined;
  if (typeof activeTo === "boolean") parts.push(activeTo ? "now visible on your page" : "now hidden from your page");
  const head = `${ACTIVITY_ACTIONS[action]}${title ? ` (${title})` : ""}`;
  return parts.length > 0 ? `${head}: ${parts.join(", ")}` : head;
}

/**
 * The sentence the activity pages show for one entry. Built on the server from the stored action and its allowlisted detail, so the
 * browser never interprets raw detail and old rows keep their wording. Unknown actions (a row from a newer or older release) show
 * a neutral line rather than the raw action name. Free text from the stored detail is limited to the influencer's own service
 * title, their own connected Google account and WhatsApp number; nothing of a customer is ever stored (see ACTIVITY_DETAIL_KEYS).
 */
export function summariseActivity(action: string, detail?: unknown): string {
  if (!isActivityAction(action)) return "Account activity";
  const label = ACTIVITY_ACTIONS[action];
  switch (action) {
    case "auth.logout_all": {
      const n = num(detail, "sessions");
      return n === null ? label : `${label} (${n} ${n === 1 ? "device" : "devices"})`;
    }
    case "profile.updated": {
      const fields = str(detail, "fields");
      const from = str(detail, "slugFrom");
      const to = str(detail, "slugTo");
      const head = fields ? `${label}: ${fields.split(",").join(", ")}` : label;
      return from && to ? `${head} (page address /${from}${ARROW}/${to})` : head;
    }
    case "service.created":
    case "service.updated":
      return serviceSummary(action, detail);
    case "availability.changed": {
      const change = str(detail, "change");
      return change && AVAILABILITY_CHANGES[change] ? `${label}: ${AVAILABILITY_CHANGES[change]}` : label;
    }
    case "booking.refunded": {
      const amount = num(detail, "amountMinor");
      const currency = str(detail, "currency");
      const status = str(detail, "status");
      if (amount === null) return label;
      return `${label}: ${money(amount)}${currency ? ` ${currency}` : ""}${status ? ` (${status})` : ""}`;
    }
    case "customers.erased": {
      const erased = num(detail, "erased");
      const blocked = num(detail, "blocked");
      if (erased === null) return label;
      return `${label}: ${erased} ${erased === 1 ? "booking" : "bookings"} erased${blocked ? `, ${blocked} upcoming kept` : ""}`;
    }
    case "payout_account.updated": {
      const method = str(detail, "method");
      // Only the last four digits of a bank account are ever shown; a UPI ID is not shown at all (not even masked).
      const destination = str(detail, "destination");
      const last4 = destination ? /(\d{4})$/.exec(destination)?.[1] : undefined;
      if (method === "BANK") return `${label} (bank account${last4 ? ` ending ${last4}` : ""}), sent for review`;
      if (method === "UPI") return `${label} (UPI ID), sent for review`;
      return label;
    }
    case "google.connected":
    case "google.disconnected":
    case "whatsapp.connected":
    case "whatsapp.disconnected": {
      const who = str(detail, action.startsWith("google") ? "account" : "phone");
      return who ? `${label} (${who})` : label;
    }
    case "earnings.exported": {
      const rows = num(detail, "rows");
      const from = str(detail, "from");
      const to = str(detail, "to");
      const range = from || to ? `${from ?? "start"} to ${to ?? "today"}` : "all dates";
      return rows === null ? `${label} (${range})` : `${label}: ${rows} ${rows === 1 ? "payment" : "payments"}, ${range}`;
    }
    default:
      return label;
  }
}

/* ---------- device ---------- */

/**
 * "Chrome on Windows"-style summary of a User-Agent header (a small table, no dependency). The raw header is never sent to a page.
 * Null when there is no header; "Unknown device" when there is one that matches nothing in the table.
 */
export function describeDevice(userAgent: string | null | undefined): string | null {
  const ua = (userAgent ?? "").trim();
  if (!ua) return null;
  const browsers: [RegExp, string][] = [
    [/\bEdg(e|A|iOS)?\//, "Edge"],
    [/\bOPR\/|\bOpera\b/, "Opera"],
    [/\bSamsungBrowser\//, "Samsung Internet"],
    [/\b(Firefox|FxiOS)\//, "Firefox"],
    [/\b(Chrome|CriOS|Chromium)\//, "Chrome"],
    [/\bSafari\//, "Safari"],
  ];
  const systems: [RegExp, string][] = [
    [/\bWindows\b/, "Windows"],
    [/\bAndroid\b/, "Android"],
    [/\biPhone\b|\biPod\b/, "iOS"],
    [/\biPad\b/, "iPadOS"],
    [/\bMac OS X\b|\bMacintosh\b/, "macOS"],
    [/\bCrOS\b/, "ChromeOS"],
    [/\bLinux\b|\bX11\b/, "Linux"],
  ];
  const browser = browsers.find(([re]) => re.test(ua))?.[1];
  const system = systems.find(([re]) => re.test(ua))?.[1];
  if (browser && system) return `${browser} on ${system}`;
  return browser ?? system ?? "Unknown device";
}
