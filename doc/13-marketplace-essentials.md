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

Done 2026-10-11 as in the plan (section 2, WP-E). What exists:

- `lib/reminders.ts`: `staleReminderReason` (pure) and a `now` dep on `sendReminderForBooking`: `15m` is skipped from the session start on,
  `24h` when less than 12 h are left; the log line says why. Skipping writes no `Message` row. `planReminderRepairs` (pure) and
  `reconcileReminders(now, deps)` (keyset-paged booking queries, one `messages` query per page, no transaction; see change 9 below).
- `lib/queue.ts`: `ensureReminder(kind, bookingId, startTime, now, queue)` returns `added | replaced | kept`; every Redis call is bounded
  with `within` (5 s).
- `worker/reminder-reconcile.ts`: `startReminderReconcile()`, first run after 60 s, then every 10 minutes, single flight, off without
  `REDIS_URL`. `worker/index.ts`: one import and one call.
- Tests: `tests/reminders.test.ts` (extended, pure), `tests/reminder-reconcile.test.ts` (pure plus database cases scoped to their own rows with a fake queue).

Deviations and additions (all small):

1. **Where this is written.** The task brief named `doc/13-deviations.md`; the plan (and the foundation's own note there) put each work
   package's record in its section of this file, so it is here.
2. **Give-up rule.** The plan does not say what happens when Redis is down. `reconcileReminders` stops after 3 Redis failures in a row
   (instead of waiting out a 5 s timeout for each of up to 1000 steps) and throws, so the worker reports it and the next tick retries.
   A single failing step is counted in `failed` and the run continues. The summary is `{ checked, repaired, failed }`.
3. **Locked job.** If `ensureReminder` finds a stale delayed/waiting job but BullMQ refuses to remove it because a worker has just locked
   it, the job is left alone (`kept`).
4. **No new index.** The repair query filters `bookings.status = 'SCHEDULED'` and a range on `sessions.start_time` (there is no index on
   that column alone). With the cap of 500 and today's volumes it is cheap; an index would be a migration, which this package does not own.
5. **Existing test helper.** `reminderFakes` in `tests/reminders.test.ts` now injects a clock (24 h before the booking) because the
   fixtures start in January 2026 and would otherwise be "already started". No assertion of an existing case changed.

Changes after review (same day):

6. **A reminder skipped on purpose is not "lost" (E1).** `enqueueReminders` never schedules a reminder whose fire time had already
   passed when the booking was made. The repair now skips a reminder whose fire time (start minus offset) is earlier than the booking's
   `armedAt`: its `createdAt`, or the update time of its `reschedule` notice row when later (a reschedule re-arms the reminders and
   leaves no other trace). `planReminderRepairs` takes `armedAt` on each booking.
7. **Replace a leftover for another time in any state but `active` (E2).** A completed or failed job for the old time (a reschedule
   while Redis was unreachable) is removed and re-added; only a running job is left alone.
8. **Re-check before touching the queue (E3).** `ensureReminder(..., stillCurrent)` asks `reconcileReminders` to re-read the booking
   (still SCHEDULED, same start) right before any remove/add; otherwise it returns `stale` and does nothing.
9. **Keyset paging (E4).** The scan reads pages of 250 ordered by (session start, id), at most 2000 bookings per run, and leaves out in
   SQL the bookings whose two reminders were both delivered. A run that hits the cap returns `next`; the worker resumes there on the next
   tick (and starts over after a complete pass). The summary is `{ checked, repaired, failed, next }`.
10. **"Already sent" means delivered (E5).** The plan said any `Message` row blocks the repair. A reschedule re-arms messages by setting
    their rows back to `PENDING` (`rearmMessage`), so the repair now treats only `SENT`, `DELIVERED` and `READ` rows as sent, the same
    set `sendMessageForBooking` dedupes on. A `FAILED` row does not block (a leftover failed job still does, so there is no retry loop).
11. **`lib/manage.ts` (not owned, tiny edit).** Rescheduling a `SCHEDULED` booking now also re-arms `reminder-24h` and `reminder-15m`
    (in a separate `step`, so a failure there never stops the new reminders being queued), so a reminder already sent for the old time
    can be sent for the new one. `tests/manage-calendar-problems.test.ts` asserts it.
12. **Tests scope themselves (E6).** `reconcileReminders(now, deps, { bookingIds })` restricts the scan; the database tests pass only
    their own booking ids.

Not checked: the acceptance walk-through with a real worker and Redis (the brief forbids starting a worker against the shared Redis);
the behaviour is covered with injected queues and fake timers instead.

## WP-F Admin finance report

Done 2026-10-11 on `mk/f-admin-reports`. Read-only: `GET /api/admin/reports` (`requireAdminMfa`, rate rule `admin-reports`) over `lib/admin/reports.ts`
(nine aggregate SQL queries, one after the other: 3 range, 3 months, 3 balances; asserted in the test) and `lib/views/admin-reports.ts`; page `web/src/pages/admin/Reports.tsx` with
`web/src/components/views/admin/ReportsView.tsx`; tests in `tests/admin-reports.test.ts`. No migration, no dependency, no shared file touched.

How the numbers follow the payout code (so the report cannot disagree with the payout screens):
- **Fees and paid-out amounts** are the stored `fee_minor` / `net_minor` of `PAID` payouts, which `createPayout()` computed with
  `buildPayoutTotals()` (the influencer's override or `PLATFORM_FEE_BPS`, `floor(net x bps / 10000)`); nothing is recomputed. The test makes its
  payouts with the real `createPayout`, `markPayoutPaid` and `cancelPayout` (override 10% for one influencer, the platform default 7% for the other).
- **To recover** is `postPayoutRefunds()` in one SQL statement (per `PAID` payout: refunds now on its payments minus `refunds_minor`; the positive
  part per payout, summed per currency). The query is in `lib/admin/reports.ts` (`refundsSinceByCurrency`), not in `lib/payouts.ts` (not a
  WP-F file); the test asserts it equals the sum of `postPayoutRefunds` over the fixture's paid payouts. The negative part, which
  `postPayoutRefunds` clips away (a refund counted when the payout was made that failed afterwards), is its own figure, `refundsNotCompletedMinor`.
- A payment is money paid when `CAPTURED` or `REFUNDED`; what is left of it is `amount - refund_amount_minor` (`netOf`); a booking "holds" it
  when `PAID`, `SCHEDULED` or `COMPLETED`.

Reconciliation identity, per currency, over a range that holds every payment (asserted in the test):
`gross - refunds - fees = held + owed to customers + not payable + paid out (net) - to recover + refunds that did not complete`. With nothing
flagged, not payable or refunded since, this is the plan's `gross - refunds - fees = held + paid out`. Figures that are "right now" (the balances)
are all-time, whatever the range. Every paid payment is in exactly one place, in this order: in a PAID payout (paid out) / flagged `needs_refund`
(owed) / in a PENDING payout (held) / booking PAID, SCHEDULED or COMPLETED (held) / anything else (not payable). `payoutBlocker` does not look at
the flag, so a flagged payment (a duplicate payment, a refund that failed and re-flagged it) can be paid out: it is then inside Paid out and also
shown as `flaggedPaidOutMinor` ("Flagged, already paid out": the influencer has it and a customer may still be owed it), not in Owed.

Deviations and interpretations:
1. **Extra balances** (shown only when not zero): `unallocatedMinor` ("Not payable"): captured money, not flagged, in no payout, for a booking that is
   REQUESTED, HELD, PENDING_PAYMENT, EXPIRED, CANCELLED or FAILED (anything but PAID/SCHEDULED/COMPLETED; no payout can ever take it, and a customer
   may still be owed part of it, for example the rest after a partial refund, which clears the flag); `flaggedPaidOutMinor` and
   `refundsNotCompletedMinor` (see above). Without them the identity does not hold.
2. **"Held" includes the payments of payouts that are still pending** unless they are flagged (those are in Owed); the plan says "not in a PAID
   payout". "In pending payouts" is the net after the fee of the payouts; the page says its payments are counted in Held, or in Owed when flagged.
   Cancelled payouts release their payments. "Owed to customers" is amount minus refunded of flagged payments that are not in a PAID payout.
2b. **Gross is dated by `payments.created_at`, the day checkout began** (the order was created). The schema has no capture time (no `captured_at`;
   `updated_at` moves with every later change), so a capture applied days later by the recovery job stays on the day it began. The page and the
   DTO comments say so. No migration was added.
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

`tests/foundation.test.ts`: the `admin-reports` row was removed from the "placeholder pages" loop (the page is real now).
Test fixtures (four run-unique currencies derived from the clock): refunds, partial and full, fee override 10% / 0 / default, a flagged duplicate
payment on one booking paid out, a refund that failed after the payout, a flagged payment inside a pending payout, a FAILED booking with captured
money, and the real `refundPayment` / `applyRefundWebhook` (Razorpay injected) for the refund steps.

## Verification

_Written by the integration owner (WP-Z)._
