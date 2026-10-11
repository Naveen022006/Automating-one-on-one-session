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
