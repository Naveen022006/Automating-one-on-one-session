# Foundation branch (`mk/00-foundation`): deviations from `doc/13-product-build-plan.md`

Dated 2026-10-11. Only differences from WP-0 (section 2, "WP-0 Foundation"); everything else was done as written. Each work package
records its own deviations in its section of `doc/13-marketplace-essentials.md`.

1. **HEAD on the new GET rate rules.** `admin-export`, `admin-reports`, `customer-export` and `customer-portal` match `GET` and `HEAD`
   (the plan says GET). Next answers HEAD with the GET handler, so a HEAD request would run the same query (an export, a portal read)
   with only the global 300/min ceiling. This matches the SPA view rules already in `policies.ts` (`public-profile`, `pay-view`,
   `self-service-view`) and is pinned in `tests/rate-limit.test.ts`.
2. **Footer link placement.** The plan puts "Find your booking" in the site footer's "Help" column; the footer has no such column
   (Product, Legal, Contact), so the link is the last item of **Contact**. The focused-layout footer is as planned.
3. **Migrations were split by hand from one diff.** One `prisma migrate diff --from-schema <old> --to-schema <new> --script` was
   produced (purely additive) and cut into the three migration folders; the data backfill was added to the first. After
   `migrate deploy`, `migrate diff` from the live database to the schema is empty. The backfill was verified on throwaway rows in a
   transaction that was rolled back (an onboarded influencer became `approved_at = onboarded_at` / `system:grandfathered`, a
   not-onboarded one stayed null; the 9 real rows were unchanged in count).
4. **`db:seed:features` details the plan leaves open.**
   - `review-demo` has a verified login that nobody can use (random password, hashed and discarded): without a verified e-mail the
     page would never be live and the approval demo would show the wrong blocker. Its slug is `review-demo` as the plan names it, so
     recognisability comes from its id (`seedfeat_inf_review`) and e-mail (`review.seedfeat@example.com`).
   - The upcoming booking also has a `CAPTURED`, reconciled payment (a `SCHEDULED` booking is a paid one; the portal and the report need it).
   - Seeded sessions start at 10:07 UTC so they can never collide with a real slot. The upcoming and cancelled sessions move with the
     calendar on a re-run (they stay "20 days ahead" and "5 days ahead"); past ones never change. A re-run also restores the customer's
     details on the five bookings (after an erasure demo) but leaves statuses and money alone; `-- --remove` then seed resets everything.
   - The customer's phone is `+910000000000`, not dialable, so the seed cannot message anyone; Meet links are `meet.example.com` placeholders.
   - `--remove` also deletes portal access tokens issued for `customer.seedfeat@example.com`.
5. **Stub components** read `void influencerId;` so the unused prop is explicit; the sweep stubs do the same with `now`.
6. **Sweeps run sequentially** after the existing three deletes in `sweepExpiredAuthRows` (the plan only says "adds both counts"), to keep
   the connection use of the worker's housekeeping flat.
7. **Extra pinned-test changes beyond the plan's list:** `tests/qa-console.test.ts` (admin nav now lists 10 sections, C11),
   `tests/spa-proxy.test.ts` (token page header, rewrites, `/admin/reports` redirect), plus the new `tests/foundation.test.ts`
   (wiring of routes, placeholders, nav, stub mounts, sweeps, schema).
8. **No `README.md` / `CLAUDE.md` / `doc/08` / `doc/12` edits** (WP-Z owns them); `doc/13-marketplace-essentials.md` was created with the
   empty WP sections as specified.

## WP-D customer portal (`mk/d-customer-portal`): deviations from `doc/13-product-build-plan.md`

Dated 2026-10-11. Only differences from the WP-D section; everything else was done as written.

1. **`requestPortalLink(email, deps)` has no `ip` parameter.** The per-IP limit is the `customer-access` route rule (applied by the
   proxy); the function would not have used the address. The per-address limit runs inside the detached part, so a request over its
   limit takes as long as any other, and its key is the SHA-256 of the address (the rate-limit store never collects customers' e-mail
   addresses).
2. **Which addresses get a link.** Any non-erased booking counts (as the plan says), including holds that were never paid; the portal
   then lists only paid bookings, and the export and the erasure cover all of them. An address whose bookings are all erased gets no e-mail.
3. **What the list shows.** Listed = status PAID/SCHEDULED/COMPLETED, or any booking with a captured or refunded payment (so a cancelled,
   refunded booking keeps its receipt). Unpaid REQUESTED/FAILED/CANCELLED bookings are not listed, like HELD/EXPIRED. `erasable` and
   `blocked` are counted over every non-erased booking of the address with the same rule as `eraseCustomerData` (HELD, PENDING_PAYMENT,
   PAID or SCHEDULED and not yet over = kept), so the dialog states exactly what the button will do.
4. **Erase is silent when it changes nothing.** The audit row and the confirmation e-mail are written only when at least one booking was
   erased (a repeat, or a second tab, adds neither). The audit row has no IP either.
5. **`paidAt` is the payment row's creation time** (no capture time is stored), like the earnings export's `paid_at`. A receipt says
   "Refunded" as soon as the refund total reaches the amount, including a refund that is still pending at Razorpay.
6. **The export nests payments and messages under each booking** instead of three loose lists. Intake answers are exported as
   `{ question, answer }`. Meet links are not exported (they are not in the plan's list).
7. **`ManageBooking.tsx` was edited** (it is not in the plan's file list): the manage page shows the receipt from inside it, because that
   component owns the page's `FocusedLayout`, so `ManageView.tsx` (which only chooses between `ManageBooking` and the notices) could not.
   The receipt is hidden once the booking is cancelled. `ManageView.tsx` needed no change.
8. **`print.css` carries the receipt's screen styles too** (`.receipt`, `.portal__*`), to avoid touching `components.css`.
9. **`tests/foundation.test.ts` was changed deliberately** (its own comment says a work package updates it): the "Coming soon" check now
   covers only `admin-reports`, and the call that asserted the stub's 0 for `sweepExpiredCustomerAccess` is gone, because the sweep now
   deletes rows (tested in `tests/customer-portal.test.ts`). `tests/spa-booking-pages.test.ts` and `tests/spa-booking.test.ts` gained the
   `receipt` key.
10. **Not verified:** a real browser print dialog and PDF (the `@media print` rules were applied to the screen and checked on the DOM),
    and a delivered e-mail (seen only through the log provider's line in a production build).
11. **Review fixes (D1 to D8).** A pending approval REQUEST is now kept by every erasure: `KEPT_BOOKING_STATUSES` / `isKeptBooking` in
    `lib/privacy.ts` is the one list, used by the host's Erase and by the portal (a test pins that the portal copies nothing), and
    `approveRequest` (`lib/booking-approval.ts`, WP-A's file; three lines) refuses a request whose customer was erased. `eraseCustomerData`
    redacts with a conditional update and counts only the rows it changed.
12. **Mail limits: order and trade-off.** The lookup now runs BEFORE the per-address allowance is used, so asking about addresses with no
    bookings costs nobody anything; then the per-address limit (3 per hour); then a global cap on all portal mail
    (`CUSTOMER_PORTAL_MAIL_CAP_PER_HOUR`, default 300, `0` stops all portal mail; read in `lib/customer-portal.ts`, silent, same 202). The
    trade-off that remains: anyone can use up a real customer's 3 per hour from one IP (5 asks per hour per IP), which delays that
    customer's link by up to an hour but cannot reveal anything or send them more than 3 e-mails; the alternative (no per-address limit)
    would let one IP mail-bomb a customer. The global cap bounds the total however many addresses and IPs are used.
13. **`after()`** keeps the detached send alive on serverless hosts; the response is unchanged. Two simultaneous erasures of one address
    in one process share a single run (one audit row, one e-mail); across processes the conditional update still prevents double counting.
14. **"In progress"**: a paid session that has started and not ended is listed with the upcoming ones under that label, has no manage
    link (as on the manage page) and is kept by an erasure (the erase rule uses the end time).
15. **Receipt payment**: among captured or refunded payments, one that is neither flagged for a refund nor fully refunded wins, then the
    earliest (`pickReceiptPayment` in `lib/receipts.ts`).

16. **Deviation note location:** the plan puts WP deviations in `doc/13-marketplace-essentials.md`; this section is in this file as
    the work-package instructions said.

# WP-C (`mk/c-activity-log`): deviations from `doc/13-product-build-plan.md`

Dated 2026-10-11. Only differences from the WP-C section; everything else was done as written.

1. **A failed log write is a warning line, not `reportError`.** `recordActivity` leaves one JSON line on `console.warn` (cause only, last line of the
   database message, never the input) and no error-webhook post. Reason: `reportError` is `console.error` plus a webhook, which pages somebody for a missing
   log row, and it would break an existing test that must stay unchanged (`tests/google-connect.test.ts`, "N1: a failing revoke", counts `console.error` calls; the mocked
   influencer `inf1` makes the insert fail). The result is the same: never throws, never changes the response.
2. **A write is capped at 2 s (`ACTIVITY_WRITE_TIMEOUT_MS`).** The caller stops waiting (the insert carries on in the background), so a saturated
   pool cannot slow an action down. No extra connection: the app's one pool is used.
3. **Detail allowlist is enforced in code** (`ACTIVITY_DETAIL_KEYS` + `sanitiseActivityDetail` in `lib/activity-actions.ts`), not only by call-site
   discipline: keys that are not listed for the action are dropped, values are strings (cut to 120 characters), finite numbers, booleans or null.
4. **"No `@` in any summary" holds except `google.connected` / `google.disconnected`**, which show the influencer's own Google account (the plan's detail is
   `{ account: <google e-mail> }`; without it the entry cannot show a takeover to another Google account). No customer e-mail can reach a summary. A UPI ID
   is not shown at all, not even masked (its mask contains `@`); a bank account shows its last four digits.
5. **Extra helpers**: `recordActivityForUser(userId, ...)` (register, verify-email and reset-password only know the sign-in id) and
   `recordFailedLogin(email, req)` (fire-and-forget: it looks the e-mail up in the background, so the 401 takes the same time for unknown and known
   e-mails; an unknown e-mail records nothing). `describeDevice` lives in the pure `lib/activity-actions.ts` and is re-exported by `lib/activity.ts`.
6. **Instrumentation beyond the table's letter**: a refund whose Razorpay answer is unclear (`RefundPendingError`, 202) is logged with
   `status: "unconfirmed"`; a cancel or reschedule that ends in `ManageBlockedError` (the booking changed, the calendar did not) is logged too;
   `onboarding.completed` is only written the first time (`!auth.onboarded`); `profile.updated.fields` lists the fields the request carried (the Profile form sends
   all of them), not only those whose value changed; `service.updated` is written for every successful update, with price and visibility only when
   they changed (a currency change also names the price); `whatsapp.disconnected` is written only when a connection existed.
7. **Routes whose handler gained a `req: Request` argument** (to read IP and user agent): `POST /api/auth/logout-all`, `DELETE /api/dashboard/whatsapp`,
   `POST /api/dashboard/onboarding`. `POST /api/auth/login` also selects `influencerId` in its existing user query.
8. **The activity table starts its query after mount** (`ActivityLog` in `AccountActivityPanel.tsx`), so the existing view tests that render `SettingsView`
   to static markup without a QueryClient (`tests/spa-dashboard-setup.test.ts`) stay green unchanged. In the browser the loading lines show for one frame.
9. **`tests/foundation.test.ts` changed in one assertion**: the stub test "returns 0" for `sweepOldActivity` (it ran without a database) is replaced by a
   `typeof` check; the real sweep is tested with the database in `tests/activity-log.test.ts` (the foundation test's own header asks each WP to do this).
10. **Page limit**: `?page=` is a whole number from 1 to 400, anything else is page 1 (the same convention as the other list endpoints); `pageCount` is capped at 400.
    A valid page past the end answers with an empty `rows`.
11. **Not logged (the plan does not list them)**: `POST /api/auth/forgot-password` and `resend-verification`, failed re-authentication, and failed password change.

12. **Review round (C1 to C7).** Repeated entries of `auth.login_failed`, `auth.reauthenticated`, `profile.updated`, `availability.changed` (same kind of change) and `earnings.exported` from the same influencer, actor and IP within 15 minutes are one row whose `detail.count` rises (no migration; `COALESCED_ACTIONS` in `lib/activity-actions.ts`); security and money entries are never merged. Both activity endpoints take an optional `?action=` (a known action, else ignored); the 400-page cap applies to the filtered list. `booking.rescheduled` / `booking.cancelled` gain `detail.calendar = "not-updated"` (also when Google refuses a reschedule, which still answers 502). An unconfirmed refund reads "Refund requested ... (not confirmed yet)". The user lookup and the insert share one 2 s deadline. The Settings views refresh the card through the window event `sa:activity-changed` (password change, password prompt, e-mail alerts switch; the profile and address forms already call `router.refresh()`), which touches `SettingsForms.tsx` and `ApiProvider.tsx` by one line each.

# WP-B (`mk/b-admin-money-ops`): deviations from `doc/13-product-build-plan.md`

Only differences from section 2, "WP-B Admin money operations"; everything else was done as written.

1. **Booking search matches the id AND the text.** The plan says a `q` that passes `isEntityId` matches the booking id exactly, else it is a
   "contains". A name such as "asha" also passes `isEntityId`, so a name-only search would have found nothing. `q` is now an exact id match
   (when it has the shape of one) OR a case-insensitive "contains" on the e-mail or the name (`bookingSearchWhere` in `lib/admin/data.ts`).
2. **Refund eligibility also returns `remainingMinor` when refused**, so the row DTO (`refund: { allowed, reason, remainingMinor }`) is
   always the same shape. The pending-payout check reads payout statuses with one extra query by id in `lib/views/admin-payments.ts`
   (`listPayments` in `lib/admin/data.ts` is not WP-B's).
3. **Extra audit actions** beyond the plan's, so no `*_requested` entry is left dangling: `payment.refund_refused` (lost the claim race, nothing
   sent), `payment.refund_error` (unexpected fault after the claim), `booking.cancel_refused` (the booking changed between read and
   cancel), `booking.cancel_error`. Audit writes AFTER the money call are best-effort (reported, never turned into a 500 that hides the
   outcome); the write BEFORE it is awaited and stops the action if it fails.
4. **Export range defaults:** with only `to` given, `from` defaults to the 1st of `to`'s month (the plan only defines both missing). Invalid
   `from`/`to` text is a 400 (the earnings export treats it as open). Audit `admin.export` uses `targetType: "export"`, `targetId: <kind>`.
5. **Export download in the browser** is a plain `<a href download>` (works without JavaScript) whose click is intercepted to `fetch` the
   file, so a refusal ("More than 20,000 rows...") shows as a message instead of a failed download. The Refund action sits in the Payment
   cell (visible without horizontal scrolling); Cancel has its own Actions column.
6. **Not changed, noted risk:** `cancelBooking` (`lib/manage.ts`, not WP-B's) has no claim, so two administrators cancelling the same booking
   in the same instant could both pass and send the customer notice twice. Money is not affected (refunds go through the claim in `refundPayment`).
7. **Review fixes, with small edits outside WP-B's file list** (all additive; other callers behave as before):
   - `lib/refunds.ts`: `refundPayment` options `blockPendingPayout` (the claim also requires no PENDING payout; a payout that took the payment
     in between gives "in a pending payout") and `expectedRemainingMinor` (a check, never the amount: `RefundAmountChangedError`, and the
     claim requires the refund total it read to be unchanged). Only the admin path passes them.
   - `lib/payouts.ts`: `createPayout`'s claim now also requires no refund in flight and the same refund total as read, so a refund claimed
     in between turns the count check into a 409; optional test-only `hooks.afterRead` to interleave.
   - `lib/manage.ts`: `cancelBooking` option `byPlatform` (no "refund-needed"/"refund-failed" alert to the host; the customer is told the
     platform will refund). `lib/dashboard.ts`: `csvCell` also neutralises a leading LF and the full-width = + - @ (shared with the earnings export).
   - A flagged (`needsRefund`) payment on an upcoming live booking is refundable only when the booking has ANOTHER captured payment.
   - The refund body requires `expectedRemainingMinor`; a mismatch is `409 { code: "amount-changed" }`. An unexpected fault after the claim is
     `500 { error: "outcome-unknown" }`, audited `payment.refund_unconfirmed`; Razorpay status other than `processed` is audited
     `payment.refund_submitted`. Exports start with a UTF-8 BOM.
8. **Tests:** `tests/spa-admin-money.test.ts` pinned key sets updated (`refund`, `cancel`, `q`); new `tests/admin-exports.test.ts`,
   `tests/admin-refund-cancel.test.ts`, `tests/admin-money-views.test.ts`.
