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
