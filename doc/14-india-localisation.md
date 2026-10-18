# India-only localisation: inventory, policy and decisions

Branch `feat/india-only`, started from `origin/main` on 2026-10-18. The owner decided the product is for India only. This file is the
inventory of every place that handles a time zone, a date or time format, a locale, a currency or a phone number or country, what it does
today, and the decision. Sections 1 to 5 were written BEFORE the code changes (first commit); where the code ended up differently, section 6
("Deviations") says so, and that section wins.

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
| `lib/format.ts` | `DEFAULT_LOCALE = APP_LOCALE or en-IN`. `formatSessionTime(date, tz, locale)` and `formatTime(date, tz)` take any zone (`safeZone` falls back to UTC); `customerZone(customerTz, influencerTz)` picks the customer's zone; `formatMoney(minor, currency)`; `formatDuration`. | Keep the file (on the allowlist) as the thin layer the app already imports. `formatSessionTime(date)` / `formatTime(date)` are IST-only (no zone argument), `customerZone` and `safeZone` are removed, `formatMoney` keeps the currency argument (stored legacy rows) and defaults to INR / en-IN, `formatDuration` is re-exported from `lib/india.ts`. |
| `lib/slots.ts` | `Rule.timezone` honoured per rule (luxon). `isValidTimezone`, `blockedDaySet`, `dayBoundsUtc(date, tz)`. | Still honours a rule's STORED zone (so rows in another zone keep producing exactly the same instants). `dayBoundsUtc(date)` is IST only (the zone argument is gone, so no caller can pass a customer zone). `isValidTimezone` stays (used by the planner and the script). |
| `lib/availability.ts` | `BookableService.timezone` = the influencer's zone; `daysWithSlots(slots, tz)`. | `daysWithSlots` always buckets by IST day. `timezone` field removed from the service shape; slot generation uses the rules. |
| `lib/holds.ts` | `customerTz` stored on the booking; slot start re-validated through `generateSlots`. | `customerTz` is written as `Asia/Kolkata` for new bookings. Slot validation unchanged. |
| `lib/booking-window.ts`, `lib/reminders.ts` | Pure instants and millisecond offsets (24 h, 15 min). | No zone logic; nothing to change. Reminder TEXT comes from `lib/message-templates.ts` (below). |
| `lib/message-templates.ts` | SMS bodies and WhatsApp variables take a pre-formatted `when` ("in the customer's timezone"). It is on the browser allowlist. | Comments say IST. Text unchanged. |
| `lib/messaging.ts` | `when = formatSessionTime(start, customerZone(customerTz, influencer.timezone))`. | `when = formatSessionTime(start)` (IST, label `IST`). Also used by reminders and reschedule/cancel notices. |
| `lib/email.ts`, `lib/email/templates.ts` | `tz` in every template's data; `formatSessionTime(d.startTime, d.tz)`; `d.at.toUTCString()` in two admin security mails. | `tz` removed from the data; times are IST; the two `toUTCString()` mails use `formatDateTime` (IST). |
| `lib/email/customer-portal.ts`, `lib/privacy.ts`, `lib/customer-portal.ts` | Erasure wording lists "time zone"; the portal DTO exposes `timeZone: b.customerTz`. | Unchanged on purpose: the JSON data export shows what is stored (new bookings store `Asia/Kolkata`, older ones whatever they stored) and erasure still blanks `customerTz`, so the wording stays true. The Privacy page no longer lists "your time zone" among the data collected. |
| `lib/receipts.ts` | `sessionStart` / `paidAt` ISO strings; the SPA formats them with `Intl` in the viewer's zone. | Strings unchanged; the SPA formats them in IST (`ReceiptCard`). |
| `lib/ics.ts`, `app/api/bookings/[id]/ics` | `DTSTART:...Z` (UTC). | Keep UTC (correct for every calendar); add the IST time to the description and `X-WR-TIMEZONE:Asia/Kolkata`. |
| `lib/google.ts`, `lib/meeting.ts` | `start/end { dateTime: ISO, timeZone: "UTC" }`; event description has no time. | `timeZone: "Asia/Kolkata"` (same instants, so the event shows in IST by default). The Calendar description does NOT gain the time: it is written once, and a reschedule only patches start/end, so a time in the text would go stale. |
| `lib/phone.ts` | `toE164(input, defaultCountry IN/US/GB)`: any valid number of any country. | IN only; see section 3. |
| `lib/sms.ts`, `lib/whatsapp.ts` | `toE164(input.to) ?? input.to` before sending. | Keep the `?? input.to` fall-through so an already-paid booking with a legacy foreign number is still messaged; new numbers are always +91. |
| `lib/dashboard-data.ts` | Overview: `monthStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)`; `earningsPayments(from, to)`. | `monthStart` = 00:00 IST on the 1st (`istDayStart(istMonthStart(now))`). The session drawer's "Time zone" row (`customerTz`) is gone; the field stays in `BookingDetail`. |
| `lib/views/dashboard-earnings.ts`, `app/api/dashboard/earnings/export` | `from` / `to` are UTC days; `new Date(`${from}T00:00:00.000Z`)`; CSV `paid_at` and `session_start_utc` are UTC ISO. | Days are IST days (`istDayStart`); CSV columns `paid_at_ist` / `session_start_ist` as ISO with `+05:30`. |
| `lib/views/dashboard-params.ts` | `parseReportDay` validates `YYYY-MM-DD` via UTC. | Unchanged (a calendar-day check). Comment says IST. |
| `lib/admin/reports.ts`, `lib/views/admin-reports.ts`, `app/api/admin/reports` | `monthWindow` UTC; `created_at >= ${start}::date` (naive UTC); `to_char(created_at, 'YYYY-MM')`; `nextDay` UTC; default range from `toISOString()`. | All buckets and bounds are IST: `(created_at AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Kolkata')`. Same nine queries, same identity. |
| `lib/admin/exports.ts` | UTC range (`T00:00:00.000Z`), UTC "today", ISO UTC cells, `toLocaleString("en-US")`. | IST range and today, timestamps as ISO with `+05:30` (header names unchanged: the offset is in every cell), count formatted with `en-IN`. The influencer earnings CSV renames its two time columns `paid_at_ist` / `session_start_ist`. |
| `lib/admin/cancel.ts`, `lib/booking-approval.ts` | Notice text uses `formatSessionTime(start, influencer.timezone)`. | IST. |
| `lib/activity-actions.ts` | `Intl.NumberFormat("en-IN")` for money; a `timezone` profile field label. | Money already en-IN; the `timezone` label stays so old log rows still read (new rows never record it). |
| `lib/views/booking-pay.ts` | `whenText` / `payByText` in the customer's zone; `amountText` via `formatMoney`. | IST; INR. |
| `lib/views/dashboard-availability.ts`, `dashboard-settings.ts`, `dashboard-types.ts`, `admin-influencer.ts`, `lib/public-profile.ts` | Expose the influencer `timezone` (editor default, settings, admin header, public profile). | The `timezone` field is REMOVED from all five DTOs (nothing in the SPA reads it any more; the tests that listed it were updated). `RuleRow.timezone` stays: it is how the Availability page finds hours still saved in another zone. |
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
| `components/ui/scheduling.tsx` | `todayIn(tz)`, `TimeSlotPicker tz`, `partOfDay(en-GB)`, `timezoneOptions()` (browser list or Dubai/Singapore/London/Berlin/New York/Los Angeles/Sydney/UTC). | `todayIst()`; no zone argument anywhere; `timezoneOptions` deleted. |
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
`lib/whatsapp-connect.ts` (the "token expires on <UTC date>" note) was left alone on purpose: another branch is changing the WhatsApp connection code.

## 6. Deviations from the plan above, and tests that changed

1. **Dates and times are not formatted with `Intl`.** The product copy is English, and `Intl` in `en-IN` writes "Sept" and a lower-case "pm", differently across ICU versions, so the server's text and the browser's would not always match. `lib/india.ts` builds "Sat, 25 Oct 2026, 6:30 PM IST" from IST integer arithmetic (the offset is fixed). `APP_LOCALE` therefore governs numbers and money only (`formatMoney`, `formatCount`).
2. **`timezone` was removed from five DTOs** (public profile, profile settings, availability, admin influencer, onboarding's profile) instead of being kept and always sent as `Asia/Kolkata`: nothing reads it. `RuleRow.timezone` stays for the legacy-hours notice.
3. **`dayBoundsUtc(date)` lost its zone argument** so no caller can pass a customer zone; the legacy-rule path goes through `generateSlots`, which still reads `rule.timezone`.
4. **No `Offer` markup, so no `priceCurrency`.** JSON-LD is an `Organization` with `areaServed: IN` and `knowsLanguage: en-IN`, plus `og:locale = en_IN` and `<html lang="en-IN">`. Inventing product markup was out of scope.
5. **Google Calendar events** get `timeZone: Asia/Kolkata` (same instants); their description is not given a time, because a reschedule only patches start and end.
6. **CSV**: the influencer earnings export renames its two time columns (`paid_at_ist`, `session_start_ist`); the admin exports keep their column names and write ISO with `+05:30` (a script that parsed the old `Z` suffix must be told).
7. **Senders keep their fall-through** (`toE164(to) ?? to`): a paid booking whose stored number is a legacy foreign E.164 is still messaged. New numbers cannot be foreign.
8. **Services**: a `PATCH` naming no currency is untouched (an older non-INR service keeps working and is shown in its own currency); the form never sends a currency for an existing service.
9. **Existing non-IST rules**: no migration (section 4). `PATCH` of such a rule must carry both times and re-saves it in IST.
10. **Activity log wording** ("price 1,000 → 1,200 INR") was already en-IN grouped and was left alone.

Tests changed because their expectation was the old behaviour (rewritten to the IST expectation, none weakened):

* `tests/messages-format.test.ts`: the "customer's timezone" test (and `customerZone`) is now the exact IST string; the e-mail fixtures lose `tz`; the e-mail text is checked for IST and rupees; the calendar file for `X-WR-TIMEZONE`.
* `tests/slots.test.ts`: the New York day-bounds test is now the IST day (18:30 UTC to 18:30 UTC) with the same slot, plus tests for no daylight saving, a midnight-IST window and a stored legacy zone still producing its own instants; the phone test now refuses a US number.
* `tests/spa-booking.test.ts`: the two "customer's own time zone" expectations (`America/New_York`, `Europe/London`) are now IST, with the stored zone still on the row to prove it is ignored.
* `tests/admin-reports.test.ts`: the edge fixtures sat on UTC midnights (23:59:59.999Z, 00:00:00.000Z); they now sit on IST midnights (18:29:59.999Z, 18:30:00.000Z), with every expected number unchanged; the view-import rule also allows `@/lib/india`.
* `tests/spa-shell.test.ts` (JSON-LD, `og:locale`), `tests/spa-guard.test.ts` (allowlist pin), `tests/schedule-overlap.test.ts`, `tests/spa-admin-core-pages.test.ts`, `tests/spa-booking-pages.test.ts`, `tests/spa-dashboard-setup.test.ts` (removed `timezone` fields).

New: `tests/india.test.ts` (formatters, IST label, lakh grouping, midnight IST vs UTC, zone normaliser, phone matrix, currency, `lang`), `tests/india-api.test.ts` (routes), `tests/ist-reporting.test.ts` (18:30 UTC cases for the report, the earnings page, "this month" and the export range), `tests/normalise-timezones.test.ts` (planner and database), and an IST text test in `tests/messaging.test.ts`. Also changed for the same reason: `tests/admin-exports.test.ts` (the quiet day is now an IST day, ISO cells carry `+05:30`), `tests/admin-hardening.test.ts` (security e-mails say the time in IST, not GMT), `tests/admin-money-views.test.ts` (the pure-import rule allows `lib/india`), `tests/spa-dashboard-core.test.ts` (the 23:30 payment on 31 March is now 23:30 IST = 18:00 UTC; the CSV columns), `tests/spa-admin-core.test.ts` and `tests/spa-booking.test.ts` (key sets without `timezone`).

## 7. Verification (2026-10-18)

* `npm run typecheck` (root and `web/`) clean; `npm run build` clean (post-build bundle checks pass).
* Every `tests/*.test.ts` run one file at a time against the shared database (pool 2): all pass except `holds` and `schedule-overlap`, whose one concurrent-transaction test each ("Unable to start a transaction in the given time") fails on this remote database whatever the pool (2, 6, 10); `lib/holds.ts` and those two test files are untouched by this branch.
* `node scripts/spa-smoke.mjs http://localhost:3601` against `next start`: 244 passed, 0 failed.
* Browser walk-through (desktop, and 375 px for the booking flow, Availability and admin Reports): booking flow (no zone or currency picker, "All times are in Indian Standard Time (IST)", ₹1,25,000.00, +91 prefix, a typed "+91 98765 43210" becomes 10 digits, a US number is refused with "Enter a 10-digit Indian mobile number", the hold is created), the Availability page (IST note, warning for an older New York rule), Settings (no zone field), Services (₹ price; an older USD service keeps its own symbol), admin Reports (IST dates). Not walked in a browser: e-mail and receipt text (covered by `tests/messages-format.test.ts`, `tests/messaging.test.ts`, `tests/customer-portal-pages.test.ts`), because that needs a paid booking.
