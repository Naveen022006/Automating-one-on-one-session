# India-only localisation: inventory, policy and decisions

Branch `feat/india-only`, started from `origin/main` on 2026-10-18. The owner decided the product is for India only. This file is the
inventory of every place that handles a time zone, a date or time format, a locale, a currency or a phone number or country, what it does
today, and the decision. It is written BEFORE the code changes (first commit) and the last section is filled in as the work lands.

## 1. Policy (decided)

| Topic | Decision |
| --- | --- |
| One source of truth | `lib/india.ts`: pure, browser-safe (added to the Vite guard allowlist and the pin test). `APP_TIME_ZONE = "Asia/Kolkata"`, `APP_LOCALE_DEFAULT = "en-IN"`, `APP_CURRENCY = "INR"`, `APP_COUNTRY = "IN"`, formatters, IST day/month arithmetic, the Indian mobile parser. |
| Storage | UTC everywhere, unchanged. No stored instant changes. |
| Time zone | Every display and every interpretation is IST (UTC+05:30, no DST). No time-zone picker, no "your time zone", no browser-zone detection. The UI says "All times are in Indian Standard Time (IST)." |
| Client-supplied `timezone` / `tz` | Accepted for backwards compatibility, never stored as another zone: a valid IANA name is forced to `Asia/Kolkata`; a string that is not an IANA zone is a 400. |
| Existing rows in another zone | See section 4. |
| Day and month boundaries | Reports, earnings, exports and "this month" use IST calendar days and months (`AT TIME ZONE 'Asia/Kolkata'`). Payout maths is unchanged. |
| Locale | Default `en-IN` (already the default of `APP_LOCALE`); every `undefined`-locale or `en-US` / `en-GB` formatter goes through the shared helpers. `APP_LOCALE` stays as an override for number and money formatting. |
| Currency | INR only for new and updated services; paise stay the minor unit. |
| Phone | Only Indian mobile numbers (10 digits, first digit 6-9), stored as `+91XXXXXXXXXX`. |

## 2. Inventory

"Today" is the behaviour on `origin/main`. "Decision" is what this branch does.

### 2.1 Core libraries

| Where | Today | Decision |
| --- | --- | --- |
| `lib/format.ts` | `DEFAULT_LOCALE = APP_LOCALE or en-IN`. `formatSessionTime(date, tz, locale)` and `formatTime(date, tz)` take any zone (`safeZone` falls back to UTC); `customerZone(customerTz, influencerTz)` picks the customer's zone; `formatMoney(minor, currency)`; `formatDuration`. | Keep the file (on the allowlist) as the thin layer the app already imports. `formatSessionTime(date)` / `formatTime(date)` become IST-only (no zone argument), `customerZone` and `safeZone` are removed, `formatMoney` keeps the currency argument (stored legacy rows) and defaults the locale to en-IN, `formatDuration` is re-exported from `lib/india.ts`. |
| `lib/slots.ts` | `Rule.timezone` honoured per rule (luxon). `isValidTimezone`, `blockedDaySet`, `dayBoundsUtc(date, tz)`. | Still honours a rule's STORED zone (so rows in another zone keep producing exactly the same instants). New: `dayBoundsUtc(date)` defaults to IST; callers stop passing a customer zone. `isValidTimezone` stays (used by the normaliser and the script). |
| `lib/availability.ts` | `BookableService.timezone` = the influencer's zone; `daysWithSlots(slots, tz)`. | `daysWithSlots` always buckets by IST day. `timezone` field removed from the service shape; slot generation uses the rules. |
| `lib/holds.ts` | `customerTz` stored on the booking; slot start re-validated through `generateSlots`. | `customerTz` is written as `Asia/Kolkata` for new bookings. Slot validation unchanged. |
| `lib/booking-window.ts`, `lib/reminders.ts` | Pure instants and millisecond offsets (24 h, 15 min). | No zone logic; nothing to change. Reminder TEXT comes from `lib/message-templates.ts` (below). |
| `lib/message-templates.ts` | SMS bodies and WhatsApp variables take a pre-formatted `when` ("in the customer's timezone"). It is on the browser allowlist. | Comments say IST. Text unchanged. |
| `lib/messaging.ts` | `when = formatSessionTime(start, customerZone(customerTz, influencer.timezone))`. | `when = formatSessionTime(start)` (IST, label `IST`). Also used by reminders and reschedule/cancel notices. |
| `lib/email.ts`, `lib/email/templates.ts` | `tz` in every template's data; `formatSessionTime(d.startTime, d.tz)`; `d.at.toUTCString()` in two admin security mails. | `tz` removed from the data; times are IST; the two `toUTCString()` mails use `formatDateTime` (IST). |
| `lib/email/customer-portal.ts`, `lib/privacy.ts`, `lib/customer-portal.ts` | Erasure wording lists "time zone"; the portal DTO exposes `timeZone: b.customerTz`. | `timeZone` stays in the DTO (a pinned key) but is always `Asia/Kolkata`; erasure still blanks `customerTz` on old rows. Wording drops "time zone" from the user-facing lists. |
| `lib/receipts.ts` | `sessionStart` / `paidAt` ISO strings; the SPA formats them with `Intl` in the viewer's zone. | Strings unchanged; the SPA formats them in IST (`ReceiptCard`). |
| `lib/ics.ts`, `app/api/bookings/[id]/ics` | `DTSTART:...Z` (UTC). | Keep UTC (correct for every calendar); add the IST time to the description and `X-WR-TIMEZONE:Asia/Kolkata`. |
| `lib/google.ts`, `lib/meeting.ts` | `start/end { dateTime: ISO, timeZone: "UTC" }`; event description has no time. | `timeZone: "Asia/Kolkata"` (same instants); the description gains the IST time. |
| `lib/phone.ts` | `toE164(input, defaultCountry IN/US/GB)`: any valid number of any country. | IN only; see section 3. |
| `lib/sms.ts`, `lib/whatsapp.ts` | `toE164(input.to) ?? input.to` before sending. | Keep the `?? input.to` fall-through so an already-paid booking with a legacy foreign number is still messaged; new numbers are always +91. |
| `lib/dashboard-data.ts` | Overview: `monthStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)`; `earningsPayments(from, to)`. | `monthStart` = start of the IST month. |
| `lib/views/dashboard-earnings.ts`, `app/api/dashboard/earnings/export` | `from` / `to` are UTC days; `new Date(`${from}T00:00:00.000Z`)`; CSV `paid_at` and `session_start_utc` are UTC ISO. | Days are IST days (`istDayStart`); CSV columns `paid_at_ist` / `session_start_ist` as ISO with `+05:30`. |
| `lib/views/dashboard-params.ts` | `parseReportDay` validates `YYYY-MM-DD` via UTC. | Unchanged (a calendar-day check). Comment says IST. |
| `lib/admin/reports.ts`, `lib/views/admin-reports.ts`, `app/api/admin/reports` | `monthWindow` UTC; `created_at >= ${start}::date` (naive UTC); `to_char(created_at, 'YYYY-MM')`; `nextDay` UTC; default range from `toISOString()`. | All buckets and bounds are IST: `(created_at AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Kolkata')`. Same nine queries, same identity. |
| `lib/admin/exports.ts` | UTC range (`T00:00:00.000Z`), UTC "today", ISO UTC cells, `toLocaleString("en-US")`. | IST range and today, IST ISO cells (`+05:30`) with `_ist` header names, `en-IN` count. |
| `lib/admin/cancel.ts`, `lib/booking-approval.ts` | Notice text uses `formatSessionTime(start, influencer.timezone)`. | IST. |
| `lib/activity-actions.ts` | `Intl.NumberFormat("en-IN")` for money; a `timezone` profile field label. | Money already en-IN; the `timezone` label stays so old log rows still read (new rows never record it). |
| `lib/views/booking-pay.ts` | `whenText` / `payByText` in the customer's zone; `amountText` via `formatMoney`. | IST; INR. |
| `lib/views/dashboard-availability.ts`, `dashboard-settings.ts`, `dashboard-types.ts`, `admin-influencer.ts`, `lib/public-profile.ts` | Expose the influencer `timezone` (editor default, settings, admin header, public profile). | The field stays in the DTOs (pinned key sets) but is always sent as `Asia/Kolkata`; the SPA stops showing a picker. |
| `lib/auth/accounts.ts`, `app/api/auth/register` | `timezone` from the browser when valid, else `Asia/Kolkata`. | Always `Asia/Kolkata`. |
| `lib/spa/head.ts`, `web/index.html` | `<html lang="en">`; Organization JSON-LD without area; no `og:locale`. | `<html lang="en-IN">`, `og:locale = en_IN`, `areaServed: IN`, `inLanguage: en-IN`. There is no `Offer` markup anywhere, so `priceCurrency: INR` has nothing to attach to (not invented). |
| `lib/env.ts`, `.env.example`, `Dockerfile`, `docker-compose.yml`, vite config | `APP_LOCALE` default `en-IN` already. | Comments updated; default kept. |

### 2.2 API routes

| Route | Today | Decision |
| --- | --- | --- |
| `GET /api/slots`, `/api/slots/days` | `tz` query (default influencer zone), `400 Invalid timezone`. | `tz` accepted and ignored if valid, 400 if not an IANA zone; the day is always an IST day. |
| `POST /api/bookings/hold` | `tz` optional, validated, stored as `customerTz`; `toE164(body.whatsapp)` any country. | `tz` normalised to `Asia/Kolkata`; phone must be an Indian mobile (400 "Enter a 10-digit Indian mobile number"). |
| `POST/PATCH /api/dashboard/availability` | Any valid zone stored per rule. | Always stored as `Asia/Kolkata`; PATCH of a rule saved in another zone must send both times (they are re-saved as IST). |
| `PATCH /api/dashboard/profile` | Any valid zone stored on the influencer. | Forced to `Asia/Kolkata`. |
| `POST /api/auth/register` | Browser zone stored. | `Asia/Kolkata`. |
| `POST/PATCH /api/dashboard/services` | `currency: z.string().length(3)` any currency, default INR. | `currency` must be `INR` (400 otherwise); default INR. |
| `POST /api/admin/influencers/[id]/payouts` | `currency` any 3 letters (existing payable currency). | Unchanged: it selects an existing currency of stored payments (no new currency can be created). |
| `GET /api/dashboard/earnings/export`, admin exports | See 2.1. | See 2.1. |

### 2.3 Browser (`web/src`)

| File | Today | Decision |
| --- | --- | --- |
| `components/ui/scheduling.tsx` | `todayIn(tz)`, `TimeSlotPicker tz`, `partOfDay(en-GB)`, `timezoneOptions()` (browser list or Dubai/Singapore/London/Berlin/New York/Los Angeles/Sydney/UTC). | Zone argument dropped; IST everywhere; `timezoneOptions` deleted. |
| `pages/booking/BookingFlow.tsx` | Browser zone detected, time-zone `<select>`, `tz` sent, `Intl` money and dates in `undefined` locale, WhatsApp help "Include the country code", validation `>= 8` digits. | No zone UI; IST note; INR via shared helper; +91 prefix and 10-digit mobile input (`inputMode="tel"`, `autocomplete="tel-national"`, `pattern`). |
| `pages/booking/ManageBooking.tsx`, `components/app/SessionsBoard.tsx` (reschedule picker) | Browser zone; `Intl` with `undefined` locale. | IST. |
| `components/app/AvailabilityEditor.tsx`, `SettingsForms.tsx`, `OnboardingWizard.tsx`, `views/dashboard/AvailabilityView.tsx` | Time-zone `<select>`, "mixed zones" alert, `todayIn(timezone)`. | Select removed; IST note; an alert lists hours still saved in another zone. |
| `components/auth/AuthForms.tsx` | Sends the browser zone on register. | Sends nothing (server forces IST). |
| `components/app/ServicesManager.tsx` | Currency `<select>` INR/USD/EUR/GBP/AED/SGD, `Intl` money in `undefined` locale. | No picker (INR shown as a fixed prefix); shared money helper. |
| `components/app/SessionsBoard.tsx`, `views/dashboard/*View.tsx`, `views/booking/*`, admin views | Mixed `toLocaleString("en-IN")`, `Intl.DateTimeFormat(undefined, ...)`, `toLocaleDateString`, `timeZone: "UTC"` for month names, `toLocaleString()` for counts. | Shared formatters (`@/lib/format` re-exports). Month/day labels derived from calendar strings keep their UTC arithmetic (a date without a time has no zone). |
| `components/admin/ExportControls.tsx` | Default range from `new Date().toISOString()` (UTC). | IST today / month start. |
| `components/views/public/LandingView.tsx`, `PrivacyView.tsx`, `TermsView.tsx`, `site/ProductFragments.tsx` | Copy about "respects time zones", "customer's own time zone", "Times shown in Asia/Kolkata". | Rewritten for IST and India. |
| `pages/public/DesignShowcase.tsx` | `tz="Asia/Kolkata"` and `tz="UTC"` demo pickers. | Prop removed. |
| `index.html` | `lang="en"`. | `lang="en-IN"`. |
| `vite.config.ts` | Defines `process.env.APP_LOCALE` for the bundle. | Unchanged. |

### 2.4 Schema, seeds, scripts, tooling

| Where | Today | Decision |
| --- | --- | --- |
| `prisma/schema.prisma` | `Influencer.timezone @default("Asia/Kolkata")`, `AvailabilityRule.timezone String`, `Booking.customerTz String?`, `Service.currency @default("INR")`, `Payment/Payout currency String`. | No migration. Columns stay (no destructive change); comments say IST. |
| `prisma/seed.ts`, `seed-features.ts` | Already `Asia/Kolkata`; phone `+910000000000` (not dialable). | Unchanged (the seeded phone is written straight to the table, not through the parser). |
| `scripts/mock-providers/*` | `toLocaleString("en-GB")`, default `timeZone: "UTC"` for events. | UI text switches to `en-IN`/IST; event time zone default is what the app sent. |
| `scripts/normalise-timezones.ts` | does not exist | New, dry-run by default (section 4). |
| Docs: `README.md`, `CLAUDE.md`, `doc/08-deployment.md`, `.env.example` | "display uses the viewer's time zone". | Updated. |

### 2.5 Tests that encode the old behaviour

`tests/messages-format.test.ts` (`customerZone`, foreign zone), `tests/spa-booking.test.ts` (`America/New_York`, `Europe/London` customer zones), `tests/slots.test.ts` (`dayBoundsUtc` in New York), `tests/booking-approval.test.ts` and email tests (`tz`), `tests/earnings.test.ts` / `tests/admin-reports.test.ts` / `tests/admin-exports.test.ts` (UTC day boundaries, CSV headers), `tests/spa-guard.test.ts` (allowlist pin), `tests/customer-portal*.test.ts` (wording), spa page tests that render the zone picker or the currency select. Rules created straight in the database with `timezone: "UTC"` in many DB tests are fixtures for the stored-zone path and are kept (they exercise that slot generation still honours a stored zone).

## 3. Phone

* The product collects ONE phone number: the customer's WhatsApp/SMS number in the booking flow. Influencers have no phone field (the WhatsApp connection stores Meta's phone-number id and the `display_phone_number` Meta returns). So "registration" and "profile" have nothing to restrict.
* Accepted input: `9876543210`, `09876543210`, `+919876543210`, `919876543210`, `00919876543210`, with spaces, hyphens, dots or brackets. The number must be 10 digits starting 6-9. Stored as `+91XXXXXXXXXX`.
* Rejected: other countries, landlines (leading 2-5), too short or too long, letters. Message: "Enter a 10-digit Indian mobile number".
* Server: `toE164(input)` = our own normalisation first (`parseIndianMobile` in `lib/india.ts`, shared with the form), then `libphonenumber-js` must still say the E.164 value is valid AND its country is `IN`.
* Legacy rows with a foreign number are left alone; the senders keep sending to a stored E.164 value they cannot parse as Indian.
* GST, state, PIN code and similar India-specific fields are OUT of scope and not invented; deferred.

## 4. Existing rows in another time zone

Facts: a rule says "weekday W, HH:mm to HH:mm, in zone Z". Bookings are stored as UTC instants and never reference a rule, so no rule edit can change a booked session.

* **Zone without DST (Asia/Dubai, Asia/Singapore, UTC, ...)** the conversion to IST is exact: shift both times by the fixed offset difference. It is meaning-preserving only when the shifted start and end stay on the same weekday (no midnight crossing).
* **Zone with DST (Europe/London, America/New_York, Australia/Sydney, ...)** "10:00 New York" is a different IST time in summer and winter. A fixed IST rule cannot represent it, so it is NOT converted automatically.

Decision: no SQL migration. `lib/slots.ts` keeps honouring the stored zone, so nothing changes for anyone until the owner runs the script. `scripts/normalise-timezones.ts` (dry run by default; `--apply --confirm=NORMALISE-TIMEZONES` to write) reports for every rule whose zone is not `Asia/Kolkata`: `convert` (fixed-offset zone, same weekday), `refuse: dst-zone`, `refuse: crosses-midnight`, `refuse: unknown-zone`; on apply it converts only the `convert` rows, and sets an influencer's `timezone` to `Asia/Kolkata` once all of that influencer's rules are IST. A dashboard notice on Availability tells the influencer which hours are still saved in another zone and how to re-enter them.

## 5. Out of scope / deferred

GST, state, PIN code, TDS, Hindi or regional-language UI, UPI-specific flows, Razorpay settings (the order currency already comes from the service row), a data migration of old payment currencies.
