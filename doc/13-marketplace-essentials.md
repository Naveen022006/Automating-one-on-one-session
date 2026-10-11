# Marketplace essentials: what was built, and where it differs from the plan

The plan is `doc/13-product-build-plan.md` (read it first; it holds the reasoning, the rules every work package follows and the
acceptance walk-throughs). This file is the record of the build: one section per work package, written by the implementer of that
package, with their **deviations from the plan** (what, why, date) and anything the next person must know. The foundation branch
(`mk/00-foundation`) created this file; its own deviations are in `doc/13-deviations.md`.

In one paragraph: six features turn the app from "a booking tool" into something a platform owner can run as a marketplace that holds
other people's money. **A** lets an administrator suspend an influencer (and, opt-in, approve a page before it goes live). **B** gives
the admin CSV exports, refunds of captured payments, platform-side cancellation and booking search. **C** records an activity log of each
influencer account, visible to the influencer and to the admin. **D** is the customer portal ("find your bookings" by e-mail, data export,
erasure, receipts). **E** repairs reminders after a worker or Redis outage. **F** is the admin finance report (what is held, owed and
to recover). The foundation branch changed every shared file once (schema, routes, router, nav, rate limits, stubs) so the six branches
touch only their own files. Rules for a placeholder: a page that still says "Coming soon" at release time is a defect (grep for it).

Write your section as you go; keep it short and dated. Do not edit another package's section.

## WP-A Influencer moderation

_Not started._

## WP-B Admin money operations

_Not started._

## WP-C Influencer activity log

_Not started._

## WP-D Customer portal

_Not started._

## WP-E Reminder repair

_Not started._

## WP-F Admin finance report

Done 2026-10-11 on `mk/f-admin-reports`. Read-only: `GET /api/admin/reports` (`requireAdminMfa`, rate rule `admin-reports`) over `lib/admin/reports.ts`
(ten aggregate SQL queries, one after the other) and `lib/views/admin-reports.ts`; page `web/src/pages/admin/Reports.tsx` with
`web/src/components/views/admin/ReportsView.tsx`; tests in `tests/admin-reports.test.ts`. No migration, no dependency, no shared file touched.

How the numbers follow the payout code (so the report cannot disagree with the payout screens):
- **Fees and paid-out amounts** are the stored `fee_minor` / `net_minor` of `PAID` payouts, which `createPayout()` computed with
  `buildPayoutTotals()` (the influencer's override or `PLATFORM_FEE_BPS`, `floor(net x bps / 10000)`); nothing is recomputed. The test makes its
  payouts with the real `createPayout`, `markPayoutPaid` and `cancelPayout` (override 10% for one influencer, the platform default 7% for the other).
- **To recover** is `postPayoutRefunds()` in one SQL statement (per `PAID` payout: refunds now on its payments minus `refunds_minor`, never below
  zero for that payout, then summed per currency). The query is in `lib/admin/reports.ts` (`toRecoverByCurrency`), not in `lib/payouts.ts` (not a
  WP-F file); the test asserts it equals the sum of `postPayoutRefunds` over the fixture's paid payouts.
- A payment is money paid when `CAPTURED` or `REFUNDED`; what is left of it is `amount - refund_amount_minor` (`netOf`); a booking "holds" it
  when `PAID`, `SCHEDULED` or `COMPLETED`.

Reconciliation identity, per currency, over a range that holds every payment (asserted in the test):
`gross - refunds - fees = held + owed to customers + not payable + paid out (net) - to recover`. With nothing flagged, not payable or refunded
since, this is the plan's `gross - refunds - fees = held + paid out`. Figures that are "right now" (the balances) are all-time, whatever the range.

Deviations and interpretations:
1. **Extra balance `unallocatedMinor`** ("Not payable" on the page): captured money for a booking that is cancelled, expired or failed with no refund
   flagged and not in a sent payout (`payoutBlocker` gives "booking-not-held", so no payout can ever take it). Without it the identity does not
   hold for a cancelled-without-refund booking. The page shows it only when it is not zero.
2. **"Held" includes the payments of payouts that are still pending** (the plan says "not in a PAID payout"). "In pending payouts" is therefore
   the same money after the platform fee; the page says so under both numbers. Cancelled payouts release their payments back into held.
3. **The monthly table ends with the month of `to`** (never later than this month), not always with this month, so a range in the past has its
   months in the table. With the default range it is the last 12 months, as planned. A month and currency with no payments, refunds or fees is
   not listed.
4. **Range input.** A `from` or `to` that is not a real day between 2000 and 2100 is ignored and replaced by the default, like the earnings page
   (`to` = today; `from` = the 1st of the month of `to`, which is also the default when only `to` is given). A range that ends before it starts
   or is longer than 366 days (both ends counted) is a 400 `{ error }`; the page keeps its form and shows that sentence.
5. **Dates in SQL** are compared as `created_at >= $1::date AND created_at < ($2::date + 1)`, so the day boundaries are UTC midnight regardless of the
   session time zone (the columns are `timestamp(3)` holding UTC); the test pins 23:59:59.999 and 00:00:00.000.
6. The plan lists this section in `doc/13-marketplace-essentials.md`; the assignment brief said `doc/13-deviations.md` (the foundation's file). It
   is written here.

Needs the integration owner: `tests/foundation.test.ts` "placeholder pages ..." still lists `admin-reports` / `web/src/pages/admin/Reports.tsx`
and asserts the text "Coming soon"; the page is real now, so that tuple must be removed from the loop (it is the only failing assertion).

## Verification

_Written by the integration owner (WP-Z)._
