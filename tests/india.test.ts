import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { daysWithSlots } from "../lib/availability";
import { formatDuration, formatMoney, formatSessionTime, formatTime } from "../lib/format";
import {
  APP_COUNTRY,
  AVAILABILITY_ZONE_ERROR,
  APP_CURRENCY,
  APP_LOCALE_DEFAULT,
  APP_TIME_ZONE,
  addDays,
  formatClock,
  formatCount,
  formatDate,
  formatDateTime,
  formatDay,
  formatIndianMobile,
  formatInr,
  formatMonth,
  indianMobileDigits,
  isAppCurrency,
  isIstEquivalentZone,
  isKnownTimeZone,
  istDate,
  istDayBounds,
  istDayStart,
  istIso,
  istMonth,
  istMonthStart,
  istMonthsBack,
  istParts,
  normaliseTimeZoneInput,
  parseIndianMobile,
} from "../lib/india";
import { toE164 } from "../lib/phone";

/* ---------- constants ---------- */

test("only zones whose offset is always +05:30 count as IST for availability", () => {
  assert.equal(isIstEquivalentZone("Asia/Kolkata"), true);
  assert.equal(isIstEquivalentZone("Asia/Calcutta"), true);
  for (const z of ["Europe/London", "America/New_York", "UTC", "Asia/Kathmandu", "Asia/Dubai", "", null, undefined, 5]) assert.equal(isIstEquivalentZone(z), false, String(z));
  assert.equal(AVAILABILITY_ZONE_ERROR, "Availability is in Indian Standard Time (IST). Reload the page.");
});

test("the constants say India", () => {
  assert.equal(APP_TIME_ZONE, "Asia/Kolkata");
  assert.equal(APP_LOCALE_DEFAULT, "en-IN");
  assert.equal(APP_CURRENCY, "INR");
  assert.equal(APP_COUNTRY, "IN");
});

/* ---------- date and time ---------- */

test("date and time carry the IST label and are read in IST whatever the machine's zone", () => {
  const d = new Date("2025-10-25T13:00:00Z"); // 18:30 IST on Saturday 25 October
  assert.equal(formatDateTime(d), "Sat, 25 Oct 2025, 6:30 PM IST");
  assert.equal(formatDateTime(d, { weekday: false, year: false }), "25 Oct, 6:30 PM IST");
  assert.equal(formatDateTime(d, { label: false }), "Sat, 25 Oct 2025, 6:30 PM");
  assert.equal(formatDate(d), "Sat, 25 Oct 2025");
  assert.equal(formatDate(d, { weekday: false }), "25 Oct 2025");
  assert.equal(formatTime(d), "6:30 PM");
  const s = new Date("2025-10-25T13:00:07Z");
  assert.equal(formatTime(s, { seconds: true }), "6:30:07 PM");
  assert.equal(formatDateTime(s, { weekday: false, seconds: true }), "25 Oct 2025, 6:30:07 PM IST", "the admin audit and health tables keep their seconds");
  assert.equal(formatDateTime(s), "Sat, 25 Oct 2025, 6:30 PM IST", "no seconds by default");
  assert.equal(formatSessionTime(d), "Sat, 25 Oct 2025, 6:30 PM IST");
  assert.equal(formatSessionTime(new Date("2026-10-12T05:30:00Z")), "Mon, 12 Oct 2026, 11:00 AM IST");
});

test("noon and midnight read 12:00 PM and 12:00 AM, and September is spelled the same everywhere", () => {
  assert.equal(formatTime(new Date("2026-01-01T06:30:00Z")), "12:00 PM");
  assert.equal(formatTime(new Date("2026-01-01T18:30:00Z")), "12:00 AM");
  assert.equal(formatDate(new Date("2026-09-15T00:00:00Z"), { weekday: false }), "15 Sep 2026");
});

test("midnight IST is 18:30 UTC: an instant just before it is still yesterday in India, just after is today", () => {
  const before = new Date("2026-10-17T18:29:59.999Z");
  const at = new Date("2026-10-17T18:30:00.000Z");
  assert.equal(istDate(before), "2026-10-17");
  assert.equal(istDate(at), "2026-10-18");
  assert.equal(formatDateTime(before), "Sat, 17 Oct 2026, 11:59 PM IST");
  assert.equal(formatDateTime(at), "Sun, 18 Oct 2026, 12:00 AM IST");
  // In UTC both are on 17 October: the old reports put them on the same day.
  assert.equal(before.toISOString().slice(0, 10), at.toISOString().slice(0, 10));
  assert.equal(istParts(at).hour, 0);
  assert.equal(istParts(at).weekday, 0);
});

test("month boundaries are IST month boundaries", () => {
  assert.equal(istMonth(new Date("2026-09-30T18:29:00Z")), "2026-09");
  assert.equal(istMonth(new Date("2026-09-30T18:30:00Z")), "2026-10");
  assert.equal(istMonthStart(new Date("2026-09-30T18:30:00Z")), "2026-10-01");
  assert.equal(istMonthStart(new Date("2026-12-31T18:30:00Z")), "2027-01-01");
});

test("IST day arithmetic: day starts, bounds, adding days, 12 months back", () => {
  assert.equal(istDayStart("2026-10-18").toISOString(), "2026-10-17T18:30:00.000Z");
  const b = istDayBounds("2026-10-18");
  assert.equal(b.to.getTime() - b.from.getTime(), 86_400_000, "an IST day is always 24 hours (no daylight saving)");
  assert.equal(addDays("2026-02-28", 1), "2026-03-01");
  assert.equal(addDays("2028-02-28", 1), "2028-02-29");
  assert.equal(addDays("2026-12-31", 1), "2027-01-01");
  assert.equal(istMonthsBack("2026-10", 12), "2025-11-01");
  assert.equal(istMonthsBack("2026-01", 12), "2025-02-01");
});

test("istIso writes the +05:30 offset", () => {
  assert.equal(istIso(new Date("2026-10-17T18:30:00.000Z")), "2026-10-18T00:00:00.000+05:30");
  assert.equal(istIso(new Date("2026-10-18T05:30:00.123Z")), "2026-10-18T11:00:00.123+05:30");
});

test("calendar days and months format without a zone", () => {
  assert.equal(formatDay("2026-10-25"), "Sun, 25 Oct 2026");
  assert.equal(formatDay("2026-10-25", { weekday: false }), "25 Oct 2026");
  assert.equal(formatDay("nonsense"), "nonsense");
  assert.equal(formatDay("2026-02-31"), "2026-02-31", "not a real day: left as written, never rolled into March");
  assert.equal(formatMonth("2026-03"), "Mar 2026");
  assert.equal(formatMonth("2026-13"), "2026-13");
  assert.equal(formatClock("18:30"), "6:30 PM");
  assert.equal(formatClock("00:00"), "12:00 AM");
  assert.equal(formatClock("23:59"), "11:59 PM");
  assert.equal(formatClock("24:00"), "24:00");
});

test("durations", () => {
  assert.equal(formatDuration(30), "30 min");
  assert.equal(formatDuration(60), "1 h");
  assert.equal(formatDuration(90), "1 h 30 min");
});

/* ---------- money ---------- */

test("money is rupees with lakh grouping", () => {
  assert.equal(formatInr(12_500_000), "₹1,25,000.00");
  assert.equal(formatMoney(12_500_000, "INR", "en-IN"), "₹1,25,000.00");
  assert.equal(formatMoney(49_900), "₹499.00", "INR and en-IN are the defaults");
  assert.equal(formatMoney(0), "₹0.00");
  assert.equal(formatMoney(123_456_789_00), "₹12,34,56,789.00", "crore grouping");
  assert.equal(formatCount(1_250_000), "12,50,000");
});

test("an unknown currency code does not throw", () => {
  assert.equal(formatMoney(1050, "XYZ9"), "10.50 XYZ9");
});

test("only INR is accepted as a currency", () => {
  assert.equal(isAppCurrency("INR"), true);
  assert.equal(isAppCurrency(" inr "), true);
  for (const c of ["USD", "EUR", "GBP", "AED", "SGD", "", "IN"]) assert.equal(isAppCurrency(c), false, c);
});

/* ---------- time zone input ---------- */

test("a client-supplied time zone is accepted when it is a real zone and replaced by IST", () => {
  for (const tz of ["Asia/Kolkata", "Europe/London", "America/New_York", "UTC", "Australia/Sydney", "Asia/Dubai"]) {
    assert.deepEqual(normaliseTimeZoneInput(tz), { ok: true, timeZone: "Asia/Kolkata" }, tz);
  }
});

test("a string that is not a time zone is refused with a clear message", () => {
  for (const bad of ["Not/AZone", "", "x".repeat(65), 42, null, undefined, {}]) {
    const r = normaliseTimeZoneInput(bad);
    assert.equal(r.ok, false, String(bad));
    if (!r.ok) assert.match(r.error, /Invalid time zone/);
  }
  assert.equal(isKnownTimeZone("Asia/Kolkata"), true);
  assert.equal(isKnownTimeZone("Mars/Olympus"), false);
});

/* ---------- slot days ---------- */

test("the calendar day of a slot is its IST day (a slot at 00:00 IST belongs to that day, not the UTC one)", () => {
  assert.deepEqual(daysWithSlots([{ start: "2030-01-06T18:29:00.000Z" }]), ["2030-01-06"]);
  assert.deepEqual(daysWithSlots([{ start: "2030-01-06T18:30:00.000Z" }]), ["2030-01-07"]);
  assert.deepEqual(
    daysWithSlots([{ start: "2030-01-07T04:30:00.000Z" }, { start: "2030-01-07T12:30:00.000Z" }, { start: "2030-01-06T18:30:00.000Z" }, { start: "2030-01-08T04:30:00.000Z" }]),
    ["2030-01-07", "2030-01-08"],
  );
});

/* ---------- phone ---------- */

const VALID = [
  "9876543210",
  "98765 43210",
  "98765-43210",
  "(98765) 43210",
  "98765.43210",
  "09876543210",
  "0 98765 43210",
  "+919876543210",
  "+91 98765 43210",
  "+91-98765-43210",
  "91 98765 43210",
  "919876543210",
  "00919876543210",
  "0091 98765 43210",
  "  +91 9876543210  ",
  "6000000001",
  "+91 (0) 98765 43210",
  "+91 0 98765 43210",
  "091 98765 43210",
  "0919876543210",
  "+91 (0)9876543210",
  "7012345678",
  "8123456789",
];

test("every spelling of an Indian mobile number normalises to +91XXXXXXXXXX", () => {
  for (const input of VALID) {
    const digits = input.replace(/\D/g, "").slice(-10);
    assert.equal(parseIndianMobile(input), `+91${digits}`, input);
    assert.equal(toE164(input), `+91${digits}`, `toE164 ${input}`);
  }
});

const INVALID = [
  "",
  "   ",
  "12345",
  "987654321", // 9 digits
  "98765432101", // 11 digits not starting 0
  "5876543210", // first digit 5
  "2212345678", // a landline-style number
  "0987654321", // 0 + 9 digits
  "+91 5876543210",
  "+911234567890",
  "+91 98765 4321", // too short
  "+91 98765 432101", // too long
  "+14155552671", // US
  "+442071838750", // UK
  "+971501234567", // UAE
  "+65 8123 4567", // Singapore
  "001 415 555 2671",
  "not a number",
  "98765abcde",
  "9876543210x",
  "+9198765+43210",
  "98765 43210 ext 5",
  "+91",
  "0091",
  "+91 (0) 5876543210", // trunk 0 and a landline-style number
  "091 5876543210",
  "0 0 98765 43210", // two zeros
  "+91 00 98765 43210",
  "0919876543", // 10 digits after 091
  "09198765432100", // 11 digits after 091
  "98765432100", // 11 digits not starting 0
  "0098765 43210",
  "9".repeat(40),
];

test("everything else is refused: other countries, landlines, wrong lengths, letters", () => {
  for (const input of INVALID) {
    assert.equal(parseIndianMobile(input), null, `parse ${JSON.stringify(input)}`);
    assert.equal(indianMobileDigits(input), null, `digits ${JSON.stringify(input)}`);
    assert.equal(toE164(input), null, `toE164 ${JSON.stringify(input)}`);
  }
});

test("the number is shown as +91 98765 43210", () => {
  assert.equal(formatIndianMobile("9876543210"), "+91 98765 43210");
  assert.equal(formatIndianMobile("+919876543210"), "+91 98765 43210");
  assert.equal(formatIndianMobile("+14155552671"), "+14155552671", "not an Indian number: unchanged");
});

/* ---------- head ---------- */

test("the HTML shell is lang en-IN", () => {
  const html = readFileSync(path.resolve(__dirname, "..", "web", "index.html"), "utf8");
  assert.match(html, /<html lang="en-IN">/);
});
