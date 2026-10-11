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

Branch `mk/a-moderation`, 2026-10-11. Built as in the plan (section 2, WP-A); the differences and the things the next person must know:

1. **"Awaiting approval" means a finished page.** `accountStatusOf` (lib/admin/data.ts) reports `awaiting-approval` only when the gate is on,
   nobody approved the page, it is not suspended **and onboarding is finished** (`onboardedAt` set). A registration that has not finished
   onboarding is not reviewable yet, so it stays out of the queue and out of the "Awaiting approval" count (the readiness checklist still
   shows its "Platform review" item, so it is not live). The Approve button works for any unapproved account (pre-approval is harmless).
2. **The "Awaiting approval" tab is hidden while its count is 0** (it appears when somebody waits, or when it is the open tab). With the
   gate off the tab would be permanent noise; "Suspended" is always shown. The API and `?status=awaiting-approval` always work.
3. **Approving a suspended account is allowed** (the plan only says "only when required and not approved"); the panel offers both buttons.
4. **`approveRequest` has a second, race-safe guard:** besides the up-front check the conditional `updateMany` also requires
   `influencer.suspendedAt = null`, so a suspension that lands between the check and the update wins.
5. **`createPayout` reads `suspendedAt` in the same select as the payout account**, after the existing `FOR UPDATE` on the influencer row.
   The suspend update takes the same row lock, so a payout in progress and a suspension cannot interleave.
6. **The list filter `live` / `not-live` uses `buildPublicInfluencerWhere`** (the same filter the public page and the sitemap use), so the
   tabs, the rows' `live` flag and the public page cannot disagree. Counts on the two moderation tabs are global, not narrowed by `q`.
7. **Where the deviations are recorded:** the plan says this file, the brief said `doc/13-deviations.md` (which is the foundation's);
   they are here so six branches do not all append to the end of one file.
8. **Pinned tests changed deliberately:** `readiness` (new required input fields, AND count 4 to 5 and so on, new cases),
   `spa-admin-core` (list key set gains `accountStatus`, `status`, `counts`), `spa-admin-core-pages` and `qa-console` (the same fields in the
   fixtures; the Influencers page cache key gains `status`; the detail page mounts the mocked status panel).

Shared-file requests: none required. Optional polish for the integration owner: `GoLiveChecklist` shows the "Platform review" item with a
"Set up" button that links to `/dashboard` (the page you are on); a label such as "Waiting" would read better (`web/src/components/app/GoLiveChecklist.tsx`).

## WP-B Admin money operations

_Not started._

## WP-C Influencer activity log

_Not started._

## WP-D Customer portal

_Not started._

## WP-E Reminder repair

_Not started._

## WP-F Admin finance report

_Not started._

## Verification

_Written by the integration owner (WP-Z)._
