# Marketplace essentials: product build plan

Author: product architect pass, 2026-10-11, against `main` at `3e20e0f`. Read-only analysis; nothing in the repository was changed.
Inputs read: CLAUDE.md, README.md, doc/00 to doc/08, doc/10 sections 4 and 5, doc/12, `prisma/schema.prisma`, `lib/spa/routes.ts`,
`lib/rate-limit/policies.ts`, `web/src/router.tsx`, the two shells (`AppShell`, `AdminShell`), `lib/readiness.ts`, `lib/public*.ts`,
`lib/checkout.ts`, `lib/refunds.ts`, `lib/manage.ts` (cancel), `lib/privacy.ts`, `lib/self-service.ts`, `lib/reminders.ts`, `lib/queue.ts`,
`lib/payouts.ts`, `lib/admin/*`, `lib/views/*`, the admin/dashboard/auth route handlers, `worker/index.ts`, the email templates, the
earnings CSV export and the test helpers.

> **Status (what happened after this plan was written).** The foundation (WP-0) and all six features are built and merged to `main`:
> moderation (A: suspend, reinstate, approve; opt-in approval gate), admin money operations (B: CSV exports, refund, cancel on the
> customer's behalf, booking search), the influencer activity log (C), the customer portal with receipts, export and erasure (D), the
> reminder repair job (E) and the admin finance Reports page (F). Where the build differs from the text below, the record is
> `doc/13-deviations.md` (the foundation, B, C and D) and `doc/13-marketplace-essentials.md` (A, E and F); those override this plan. How to
> use the features is in `README.md`; the operational side (the `approval` value, `CUSTOMER_PORTAL_MAIL_CAP_PER_HOUR`, retention, migrations
> `20261105` to `20261108`) is in `doc/08-deployment.md`.
>
> **Deferred, and why** (details in sections 1 and 5): coupons (changes the payable amount and needs a funding policy, a fee basis and
> checkout order invalidation); automatic refunds of flagged payments (`needsRefund` mixes real duplicates with fraud signals, so a human
> keeps the decision; B makes it one audited click); reviews and ratings (need moderation and a fake-review policy); discovery and search of
> influencers (the product is link-in-bio today and discovery needs ranking and content moderation); GST and tax invoices (a legal decision
> on who is the supplier, a GSTIN and a numbering policy; the receipt is not a tax invoice); a notification center (the overview "needs
> attention" list and e-mail alerts cover the urgent cases); influencer analytics beyond Earnings; influencer two-factor sign-in (payout
> changes already need a recent password, admin verification and an e-mail notice, and the activity log makes a takeover visible);
> influencer account closure (financial records and outstanding payouts must be kept; handled by hand through the admin); admin roles
> (two admins today, four-eyes covers payouts); Sentry (needs an account; `reportError` and `ERROR_WEBHOOK_URL` exist). The final
> cross-check by the integration owner is the "Verification" section of `doc/13-marketplace-essentials.md`.

---

## 0. Decisions in one screen

Six features, one foundation branch first, one integration branch last. Every feature fits the existing architecture (view functions,
`jsonView`, `requireApiAuth` / `requireAdminMfa`, hand-picked DTOs, rate rules), uses **no new npm dependency** and **no external
provider**: e-mail goes through the existing provider (`EMAIL_PROVIDER=log` locally), Razorpay calls are injectable and mocked in tests.

| WP | Branch | What | Audience | Why now |
|---|---|---|---|---|
| 0 | `mk/00-foundation` | Schema + 3 additive migrations, route rows, router placeholders, nav, rate rules, stubs, seed data | all | Removes every shared-file collision for the six parallel branches |
| A | `mk/a-moderation` | Suspend / reinstate an influencer; opt-in approval before go-live | admin, influencer | The platform is merchant of record and has no way to stop a bad actor taking money |
| B | `mk/b-admin-money-ops` | Admin CSV exports; refund a captured payment; cancel a booking on the platform's behalf; booking search | admin | Reconciliation/accounting need data out; money the platform holds for customers can only be returned from the Razorpay dashboard today |
| C | `mk/c-activity-log` | Influencer activity log (security and dispute trail), visible to the influencer and to the admin | influencer, admin | Only admin actions are logged; disputes and account takeovers cannot be investigated |
| D | `mk/d-customer-portal` | "Find your bookings" by e-mail (lost manage link), data export and erasure for customers, receipts on screen | customer | DPDP-style data rights for the people who pay; support load from lost links; receipts |
| E | `mk/e-reminder-repair` | Reminder staleness guard + reconciliation after a worker/Redis outage | customer (reliability) | A worker outage today can send "starts in 15 minutes" after the session, or no reminder at all |
| F | `mk/f-admin-reports` | Finance report: gross, refunds, fees, payouts, and balances held / owed | admin | The owner holds everyone's money and cannot see how much is owed to whom |
| Z | `mk/z-integration` | Docs, deviations, final cross-checks, smoke run | all | |

Explicitly deferred (section 5): coupons/discounts, automatic refunds of flagged payments, reviews/ratings, discovery/search, tax invoices,
notifications center, influencer analytics beyond what exists, Sentry, influencer 2FA, account closure, admin roles.

Merge order: **0 -> A -> E -> B -> C -> D -> F -> Z** (section 4). Implementers A to F start in parallel as soon as 0 is on `main`.

---

## 1. Gap analysis per audience

Scores: **Value** 1-5 (to the business: trust, money, legal, support load), **Risk** 1-5 (chance of breaking money paths or leaking data;
higher is riskier), **Effort** S (<= 2 h), M (2-4 h), L (> 4 h) for one Sonnet implementer.

### 1.1 Customer (guest, no account)

**Exists today:** public profile and booking page with live slots and holds; intake questions; booking window; approval-required services
(request -> pay link); Razorpay checkout; confirmation page polling; confirmation + receipt + reschedule + cancellation e-mails; WhatsApp
with SMS fallback; `.ics`; reminders 24 h and 15 min; signed `/manage/<token>` link (30 days) to reschedule and cancel under the booked
refund policy; legal pages; contact page.

| # | Gap | Why it matters | V | R | E | Decision |
|---|---|---|---|---|---|---|
| C1 | No way to recover a lost manage link or see all my bookings (the manage token expires after 30 days; resend needs the booking id from the confirmation page) | Every lost e-mail becomes a support ticket; customers cannot cancel in time and then dispute the charge | 5 | 2 | M | **BUILD NOW (D)** |
| C2 | No self-service data export or erasure (only the influencer can erase) | Data-principal rights (India DPDP Act 2023: access, erasure); trust; today the request goes to the influencer, who may not act | 4 | 2 | M | **BUILD NOW (D)** |
| C3 | Receipt only as an e-mail | Customers expensing a session need a printable receipt; reduces "send me a receipt" tickets | 3 | 1 | S | **BUILD NOW (D)** |
| C4 | Reminders can be wrong or missing after a worker or Redis outage (past-session sends; "tomorrow" sent hours before; flushed delayed jobs never re-created) | Wrong reminders look broken; missing reminders cause no-shows and refund requests | 4 | 2 | S | **BUILD NOW (E)** |
| C5 | Tax invoice (GST) | Needed for B2B customers eventually | 3 | 3 | M | DEFER: needs a legal decision on who is the supplier (platform or influencer), a GSTIN, and an invoice-numbering policy |
| C6 | Coupons / discounts | Marketing lever | 3 | 5 | M | DEFER (section 5.1): changes the payable amount; needs a funding policy and checkout order invalidation |
| C7 | Reviews / ratings | Social proof | 3 | 3 | L | DEFER: needs moderation and a fake-review policy; low value without discovery (traffic comes from the creator's own audience) |
| C8 | Discovery / search of influencers | New demand | 2 | 3 | L | DEFER: link-in-bio model today; needs approval gate (A gives the base), ranking, content moderation |
| C9 | Customer accounts | Convenience | 2 | 3 | L | DEFER / not planned: the e-mail-verified portal (D) gives the useful half without passwords |
| C10 | Waitlist for full group sessions | Revenue on popular sessions | 2 | 2 | M | DEFER |

### 1.2 Influencer dashboard

**Exists today:** registration with verified e-mail, onboarding wizard, go-live checklist; services (1:1, group, custom questions, booking
window, prep notes, approval required, refund policy); weekly availability and blocked dates; sessions board with drawer (cancel,
reschedule, refund, resend, approve/decline requests); customers list and erase; earnings with CSV; payout details (encrypted, admin
verified) and payouts list; messages log; settings (profile, Google, Gmail send, WhatsApp, devices, password, log out everywhere).

| # | Gap | Why it matters | V | R | E | Decision |
|---|---|---|---|---|---|---|
| I1 | No record of what happened on the account (logins, failed logins, password changes, payout-detail changes, refunds, price changes, customer erasures) | Account takeover cannot be spotted or investigated; disputes ("I never refunded that") have no evidence | 4 | 2 | M | **BUILD NOW (C)** |
| I2 | No account status (the platform cannot suspend; nothing tells the influencer why the page is offline) | Paired with A1: the influencer must see "suspended, reason, contact support" instead of a silently dead page | 4 | 2 | S | **BUILD NOW (A, through the checklist)** |
| I3 | Analytics (conversion holds -> paid, repeat customers, trends) | Helps creators sell more | 3 | 1 | M | DEFER: Earnings already has totals by service and CSV; next iteration |
| I4 | Notifications center | Convenience | 2 | 2 | M | DEFER: overview "needs attention" + e-mail alerts already cover the urgent cases |
| I5 | Platform-fee invoices / payout statements (PDF) | Influencer accounting | 3 | 3 | M | DEFER: same tax decision as C5; payouts list + earnings CSV suffice for now |
| I6 | Influencer two-factor sign-in | Account security | 3 | 3 | M | DEFER: payout destination changes already need recent password, admin verification and an e-mail notice; C makes takeovers visible |
| I7 | Account closure / own-data deletion | Data rights for influencers | 3 | 4 | M | DEFER: financial records and outstanding payouts must be retained; handle manually through the admin for now |
| I8 | Coupons | | | | | DEFER (C6) |
| I9 | Team members / assistants, custom domains | | 2 | 3 | L | DEFER |

### 1.3 Admin console

**Exists today:** overview totals and attention counts; influencers list and detail (readiness, connections, payout details verify /
reject / audited reveal, fee override, payout creation, four-eyes approval, mark paid, cancel); payments with filters and Razorpay
reconciliation; bookings list by status; system health with queues and recovery; append-only admin audit log; TOTP 2FA, recovery codes,
lockout; settings.

| # | Gap | Why it matters | V | R | E | Decision |
|---|---|---|---|---|---|---|
| A1 | Cannot suspend an influencer (fraud, abuse, chargebacks, complaints) | The platform collects the money and carries the chargebacks; it must be able to stop new bookings and hold payouts | 5 | 3 | M | **BUILD NOW (A)** |
| A2 | Cannot require review before a new page goes live | Proactive vetting for an open-registration marketplace | 3 | 2 | S on top of A1 | **BUILD NOW (A), opt-in, default off** (`READINESS_REQUIRED=...,approval`) so nothing changes until the owner turns it on |
| A3 | No CSV exports (payments, bookings, payouts, audit) | Bookkeeping, GST filing, reconciliation in a spreadsheet, evidence for disputes | 4 | 2 | S | **BUILD NOW (B)** |
| A4 | Cannot refund from the console (flagged `needsRefund` payments, cancelled bookings, disputes) | The platform holds customers' money; today the owner must use the Razorpay dashboard with no audit entry here | 4 | 4 | M | **BUILD NOW (B)** with airtight rules (section 2, WP-B) |
| A5 | Cannot cancel a booking on the platform's behalf | Needed to unwind a suspended influencer's upcoming sessions; customer gets the normal cancellation notice and a full-refund decision | 4 | 3 | S | **BUILD NOW (B)** reusing `cancelBooking` |
| A6 | No booking search by customer e-mail or booking reference | First thing support needs ("I paid but got nothing") | 3 | 1 | S | **BUILD NOW (B)** |
| A7 | No finance report (gross, refunds, fees, payouts; money held for influencers; money owed to customers) | The owner cannot see liabilities; a marketplace holding funds must | 4 | 2 | M | **BUILD NOW (F)** |
| A8 | No view of influencer activity | Investigations | 4 | 2 | (in C) | **BUILD NOW (C)** |
| A9 | Automatic refunds of flagged payments | Less manual work | 3 | 5 | M | DEFER (section 5.2): keep a human in the loop; A4 makes it one click |
| A10 | Error tracking (Sentry) | Faster incident response | 4 | 1 | S | DEFER: needs an account; `reportError` and `ERROR_WEBHOOK_URL` exist, a Sentry adapter is a one-file change later |
| A11 | Admin roles (support vs finance) | Least privilege as the team grows | 3 | 3 | M | DEFER: two admins today; four-eyes covers payouts |
| A12 | E-mail to admins when a page awaits approval | Faster review | 2 | 1 | S | DEFER: the Influencers page gets an "Awaiting approval" tab with a count |

---

## 2. The BUILD NOW set (work packages)

### Rules that apply to every work package

- Branch from `main` **after WP-0 is merged**. Do not edit files you do not own (lists below). If you truly need a change in a shared file,
  write it in your PR description under "Shared-file requests"; the integration owner applies it.
- Data for a screen comes from an endpoint backed by a view function in `lib/views/*`, answered with `jsonView()`. DTOs are built field by
  field; every endpoint test pins the exact key set and calls `assertNoSecretKeys` (`tests/helpers/assert-no-secret-keys.ts`; note that
  any key containing `token`, `hash`, `secret`, `password` or ending in `enc` fails it, so never name a DTO key like that).
- Influencer endpoints: `requireApiAuth()` (reads) / `requireRecentAuth()` (irreversible actions), scoped by `auth.influencerId`.
  Admin endpoints: `requireAdminMfa()`, never `requireAdminApi`.
- Bodies through `parseJson`/`readJson` with zod; ids checked with `isEntityId`; never trust a client amount, time or id.
- Browser code imports server modules with `import type` only; the Vite guard allowlist is **not** extended by any WP.
- Tests: `node:test` via tsx, one file at a time on the shared database:
  `DATABASE_POOL_MAX=2 npx tsx --test --experimental-test-module-mocks --test-concurrency=1 tests/<file>.test.ts`.
  DB tests create timestamped rows and delete them in `after`; they skip when `DATABASE_URL` is unset; they must pass on CI with
  `MESSAGING_DRY_RUN=true`, no `.env`, `RATE_LIMIT_STORE=memory`; set `APP_URL`/`APP_SECRET` in `before` when a link is built; a test that
  can reach `getHealthReport()` deletes `process.env.REDIS_URL` in `before`. Inject Razorpay (`deps`/`overrides` or `mock.module("@/lib/payments")`):
  **no test may call Razorpay, Google or Meta**.
- **Shared database etiquette (15 connections):** at most one DB test process per implementer at a time, pool 2; no implementer runs
  `npm run dev` against the shared database while others test (use `npm run typecheck`, unit tests and view render tests during
  development; one person at a time for browser checks). Only the integration owner applies migrations (`npx prisma migrate deploy`).
- Each WP records its deviations from this plan in its own section of `doc/13-marketplace-essentials.md` (created by WP-0).
- "Done" for a WP = `npm run typecheck` clean, the WP's new and touched test files green, `npm run build` passes, acceptance walk-through
  done by the implementer (with `EMAIL_PROVIDER=log`, `READINESS_BYPASS=true`, `RATE_LIMIT_STORE=memory` locally), PR lists files changed.

---

### WP-0 Foundation (`mk/00-foundation`) — owner: the integration owner. About 2 h. Must merge before anything else.

Purpose: touch every shared file once so the six feature branches never collide.

**0.1 Schema (`prisma/schema.prisma`) and migrations** (generate the DDL with `npx prisma migrate diff` from the current schema to the
new one and save it as `migration.sql`; never `migrate dev`; additive only):

```prisma
// in model Influencer (new fields + relation)
  // Platform moderation (WP-A). Suspended: the page is offline, new holds/checkouts/approvals and new payouts are refused.
  suspendedAt      DateTime? @map("suspended_at")
  suspendedReason  String?   @map("suspended_reason")
  suspendedByEmail String?   @map("suspended_by_email")
  // Set when an administrator approved the page. Only enforced when READINESS_REQUIRED contains "approval".
  approvedAt       DateTime? @map("approved_at")
  approvedByEmail  String?   @map("approved_by_email")
  activity         InfluencerActivity[]

// WP-C: what happened on an influencer account (append-only; retention 365 days, swept by the worker)
model InfluencerActivity {
  id           String   @id @default(cuid())
  influencerId String   @map("influencer_id")
  actor        String   @default("influencer") // "influencer" | "system"
  action       String
  targetType   String?  @map("target_type")
  targetId     String?  @map("target_id")
  detail       Json?
  ip           String?
  userAgent    String?  @map("user_agent")
  createdAt    DateTime @default(now()) @map("created_at")

  influencer Influencer @relation(fields: [influencerId], references: [id], onDelete: Cascade)

  @@index([influencerId, createdAt])
  @@index([createdAt])
  @@map("influencer_activity_logs")
}

// WP-D: one-hour access to "your bookings" for whoever proves they read the inbox. Only the SHA-256 of the token is stored.
model CustomerAccessToken {
  id        String   @id @default(cuid())
  tokenHash String   @unique @map("token_hash")
  email     String
  expiresAt DateTime @map("expires_at")
  createdAt DateTime @default(now()) @map("created_at")

  @@index([email])
  @@index([expiresAt])
  @@map("customer_access_tokens")
}
```

| Migration folder | Content |
|---|---|
| `20261106000000_influencer_moderation` | `ALTER TABLE "influencers" ADD COLUMN` x5 (all nullable). Then a hand-written backfill: `UPDATE "influencers" SET "approved_at" = "onboarded_at", "approved_by_email" = 'system:grandfathered' WHERE "onboarded_at" IS NOT NULL;` (existing live-capable accounts are grandfathered, so turning on the approval gate later never takes them offline) |
| `20261107000000_influencer_activity_log` | `CREATE TABLE "influencer_activity_logs"` + FK `ON DELETE CASCADE` + the two indexes |
| `20261108000000_customer_access_tokens` | `CREATE TABLE "customer_access_tokens"` + unique on `token_hash` + two indexes |

Apply with `npx prisma migrate deploy` to the shared DB once, then `npx prisma generate`.

**0.2 Route table (`lib/spa/routes.ts`)**, three rows (count 36 -> 39):

```ts
// booking (customer facing), before `pay`
{ id: "customer-bookings", path: "/bookings", robots: "noindex", template: "brand", title: "Find your bookings", head: "static" },
{ id: "customer-portal", path: "/bookings/:token", robots: "noindex,nofollow", template: "brand", title: "Your bookings", noReferrer: true, head: "static" },
// admin, after admin-payouts
{ id: "admin-reports", path: "/admin/reports", robots: "noindex,nofollow", template: "admin", title: "Reports", head: "static" },
```

`matchSpaRoute`: add, next to the pay/manage branch, `if (first === "bookings" && parts.length === 2 && parts[1]) return { route:
spaRouteById("customer-portal"), params: { token: parts[1] }, status: 200 };`. `bookings` is already a reserved slug (`lib/auth/slug.ts`),
so no profile can shadow it. Update `tests/spa-routes.test.ts`: count 39, `sample()` already maps `:token`, privacy-flags test (the two
customer routes are not `index`; `customer-portal` has `noReferrer`), and a case that `/bookings/abc` is `customer-portal` while
`/bookings-coach` stays a profile.

**0.3 Robots (`lib/robots-rules.ts`)**: add `"/bookings$", "/bookings/", "/bookings?"` to `ROBOTS_DISALLOW`; extend `tests/spa-robots.test.ts`
(private list gains `/bookings` and `/bookings/x`; the M6 list gains `/bookings-with-asha` as still crawlable).

**0.4 Router (`web/src/router.tsx`)**: `pages` gains `"customer-bookings": () => import("./pages/booking/FindBookings")`,
`"customer-portal": () => import("./pages/booking/CustomerPortal")`, `"admin-reports": () => import("./pages/admin/Reports")`; leaves:
the two customer pages are public (next to `pay`/`manage`, before `book`/`profile`), `admin-reports` inside `RequireAdmin`.
Placeholder page modules (each exports `Component` rendering exactly one `<PageTitle>` equal to the route title and an `EmptyState`
"Coming soon"): `web/src/pages/booking/FindBookings.tsx`, `web/src/pages/booking/CustomerPortal.tsx`, `web/src/pages/admin/Reports.tsx`.
Ownership passes to D (first two) and F (third).

**0.5 Navigation**: `AdminShell` NAV gains `{ href: "/admin/reports", label: "Reports", icon: IconBarChart }` after Payouts (not in
`MOBILE_PRIMARY`; it lands in "More"). `web/src/components/icons.tsx` gains `IconBarChart` (same 24-px stroke style as the others).
`SiteChrome` footer "Help" column gains `<li><AppLink href="/bookings">Find your booking</AppLink></li>`; `FocusedLayout` default footer
gains ` · <AppLink href="/bookings">Your bookings</AppLink>`. No dashboard nav change (activity lives in Settings).

**0.6 Rate limits (`lib/rate-limit/policies.ts`)**, inserted where first-match order requires:

| Name | Method, pattern | Limit | Key | Position |
|---|---|---|---|---|
| `admin-export` | GET `^/api/admin/exports/(payments\|bookings\|payouts\|audit)$` | 30 / hour | ip | before `admin` |
| `admin-reports` | GET `^/api/admin/reports$` | 30 / 10 min | ip | before `admin` |
| `admin-moderation` | POST `^/api/admin/influencers/[^/]+/status$` | 60 / hour | ip | before `admin` |
| `admin-money` (extended) | POST, PATCH `^\/api\/admin\/(payouts\/\|influencers\/[^/]+\/(payouts\|fee)$\|payments\/[^/]+\/(unreconcile\|refund)$\|bookings\/[^/]+\/cancel$)` | 60 / hour (unchanged) | ip | unchanged |
| `customer-access` | POST `^/api/customer/access$` | 5 / hour | ip | public booking block |
| `customer-erase` | POST `^/api/customer/portal/[^/]+/erase$` | 5 / hour | ip | before `customer-portal` |
| `customer-export` | GET `^/api/customer/portal/[^/]+/export$` | 10 / hour | ip | before `customer-portal` |
| `customer-portal` | GET `^/api/customer/portal/[^/]+$` | 60 / 10 min | ip | public booking block |

`IDENTITY_RULES.customerAccessEmail = { name: "customer-access-email", limit: 3, windowMs: HOUR }`. Dashboard/admin GETs of the new
activity and status endpoints fall under the existing `dashboard` / `admin` rules. Extend `tests/rate-limit.test.ts`: each new path hits
its rule; `/api/bookings/x`, `/api/admin/payments/x/unreconcile`, `/api/admin/influencers/x/payouts` still hit their old rules.

**0.7 Other shared one-liners**
- `lib/rate-limit/redact.ts`: `loggablePath` also redacts `/api/customer/portal/<token>` (`/api/customer/portal/:token/...`); test in `tests/rate-limit.test.ts`.
- `next.config.ts`: `{ source: "/api/customer/:path*", headers: privateApiHeaders }`.
- `lib/env.ts`: `READINESS_REQUIRED` accepts `approval` (message "may only list: google, gmail, whatsapp, payout, approval"); `tests/env.test.ts`;
  `.env.example` comment: "`approval`: a new page goes live only after an administrator approves it (Admin > Influencers)".
- `web/src/lib/query.ts`: `customerPortal: (token: string) => ["customer", "portal", token] as const`.
- `web/src/styles/print.css` (comment only) imported from `web/src/styles/globals.css` (D fills it).
- Stub components, mounted once by WP-0 in `web/src/components/views/admin/InfluencerDetailView.tsx` (status panel directly under the
  page header, activity panel as the last card): `web/src/components/admin/InfluencerStatusPanel.tsx` (owner A) and
  `web/src/components/admin/InfluencerActivityPanel.tsx` (owner C), each `export function X({ influencerId }: { influencerId: string }) { return null; }`.
- Stub sweeps wired into `lib/auth/sweep.ts` (`sweepExpiredAuthRows` adds both counts): `lib/activity-retention.ts` exporting
  `sweepOldActivity(now?: Date): Promise<number>` (owner C) and `lib/customer-access-sweep.ts` exporting
  `sweepExpiredCustomerAccess(now?: Date): Promise<number>` (owner D); both return 0 in the stub.
- `scripts/spa-smoke.mjs`: `/bookings` (200, `noindex`), `/bookings/not-a-token` (200 shell, `noindex, nofollow`, `Referrer-Policy: no-referrer`),
  `/admin/reports` without cookie (redirect to `/admin/login?next=%2Fadmin%2Freports`).
- `doc/13-marketplace-essentials.md`: title, a one-paragraph summary of this plan, and empty sections `## WP-A` ... `## WP-F`, `## Verification`.

**0.8 Demo data: `prisma/seed-features.ts` + `package.json` script `"db:seed:features": "tsx prisma/seed-features.ts"`** (refuses unless
`APP_URL` is local, like `scripts/dev-logins.ts`; idempotent; `-- --remove` deletes everything it created; every row it creates is
recognisable: slugs/emails/ids containing `seedfeat`, provider ids `pay_SEEDFEAT...`/`order_SEEDFEAT...`). Requires `npm run db:seed` first.
- Influencer `review-demo` ("Review Demo"), onboarded, `approvedAt = null`, one 1:1 service, weekday rules, verified demo payout details
  (to demo the approval queue with `READINESS_REQUIRED=google,payout,approval`).
- On `demo`, customer `customer.seedfeat@example.com` ("Asha Seed", `whatsappOptIn: false`):
  three past `SCHEDULED` bookings with `CAPTURED`, reconciled payments; one upcoming `SCHEDULED` booking **20 days ahead** with a placeholder
  `meetLink` (outside the reminder window, see E); one `CANCELLED` booking whose payment is `CAPTURED` with `needsRefund: true`;
  one `PAID` payout containing one past payment, plus a later `processed` refund row on that payment (shows "to recover" in F).
- Never run a worker connected to real providers against seeded data. Refunds of `pay_SEEDFEAT...` are rejected by Razorpay (definite 4xx)
  and show the error path; a real refund demo uses a real test-mode payment.

**WP-0 tests:** `spa-routes`, `spa-robots`, `rate-limit`, `env`, `spa-proxy` (token page gets `no-referrer` for `/bookings/x`),
`spa-guard` unchanged and green, `npm run typecheck`, `npm run build`, smoke against `next start`.
**WP-0 acceptance:** `/bookings`, `/bookings/x`, `/admin/reports` render the placeholder with the right title; the admin sidebar shows
Reports; `db:seed:features` runs twice without duplicates and `--remove` leaves nothing.

---

### WP-A Influencer moderation (`mk/a-moderation`). About 3.5 h.

**Behaviour**
- **Suspend** (admin, reason 5-500 chars): the public page goes offline for everyone but the owner (owner preview shows the blocker);
  slot listing for strangers, new holds, new checkouts (including holds created before the suspension), approving pending requests, and
  creating new payouts are refused. Existing paid bookings are **not** touched: the customer can still reschedule/cancel through the manage
  link, the influencer can still deliver, cancel and refund, and the admin can cancel/refund through WP-B. A Razorpay payment already opened
  before the suspension still completes through the unchanged webhook (decided on purpose: the webhook and `applyCapturedPayment` are not
  modified); the admin unwinds it with WP-B if needed. The influencer can still sign in.
- **Reinstate**: clears the three suspension columns; everything works again.
- **Approve** (only meaningful when `READINESS_REQUIRED` contains `approval`): sets `approvedAt`/`approvedByEmail`. With the gate off the
  button is hidden and the status is never "awaiting approval". `READINESS_BYPASS=true` (development only) bypasses the approval gate but
  **never** a suspension.
- Influencer is e-mailed on suspend (with the reason and `NEXT_PUBLIC_SUPPORT_EMAIL`), reinstate and approve (platform e-mail, best effort).

**Readiness changes (`lib/readiness.ts`)** — the single place the "live" rule lives:
- `ReadinessKey` gains `"account"`. `ReadinessInput` gains **required** fields `suspended: { reason: string } | null` and `approved: boolean`
  (required on purpose: `tsc` then finds every caller that must select the new columns).
- `approvalRequired(env)`: `READINESS_REQUIRED` contains `approval` and not (`READINESS_BYPASS=true` outside production).
- `evaluateReadiness(input, required, opts = { approvalRequired: approvalRequired() })` appends an `account` item **only** when it applies:
  suspended -> `{ key: "account", label: "Account in good standing", state: "attention", required: true, detail: "Suspended by the platform: <reason>. Contact <support e-mail> to resolve it.", href: "/contact" }`;
  else approval required and not approved -> `{ label: "Platform review", state: "todo", required: true, detail: "We review new booking pages before they go live. You will get an e-mail.", href: "/dashboard" }`.
  Normal accounts get exactly today's items (existing checklist tests keep passing).
- `export function isLiveBlocker(key: ReadinessKey): boolean` = `key === "email" || key === "account" || CONNECTION_KEYS.includes(key)`; replace
  the three copies of that filter in `lib/public-profile.ts`, `lib/admin/data.ts` (`listInfluencers`) and `lib/views/dashboard-overview.ts`.
- `buildPublicInfluencerWhere` always adds `{ suspendedAt: null }` and, when `approvalRequired(env)`, `{ approvedAt: { not: null } }`.
  This covers holds (`app/api/bookings/hold`), slots (`lib/availability.ts`) and the sitemap automatically. Update the AND-count test.
- `readinessInput(row, emailVerified)`: row type gains `suspendedAt: Date | null; suspendedReason: string | null; approvedAt: Date | null`; update the
  selects in `loadReadiness`, `lib/admin/data.ts` (`listInfluencers`, `getInfluencerDetail`) and `lib/public-profile.ts` (its `include` already returns scalars).

**Server guards (owned by A)**
- `lib/checkout.ts` `startCheckout`: load `service.influencer.suspendedAt` with the booking; if set, `throw new NotPayableError("This booking can no longer be paid. You have not been charged.")` before any order is created or reused.
- `lib/booking-approval.ts` `approveRequest`: refuse with `ApprovalError("Your account is suspended, so requests cannot be approved.", 409)` (decline stays allowed).
- `lib/payouts.ts` `createPayout`: inside the transaction, after the existing influencer row lock, read `suspendedAt`; if set, `throw new PayoutError("This influencer is suspended. Reinstate them before creating a payout.", 409)`. Approve / mark paid / cancel of existing payouts are unchanged.

**Endpoints**
- `GET /api/admin/influencers/:id/status` (`requireAdminMfa`, 404 unknown id) -> `lib/views/admin-influencer-status.ts` `loadInfluencerStatusView(id)`:
  ```ts
  interface AdminInfluencerStatusView {
    status: "active" | "suspended" | "awaiting-approval";
    suspension: { at: Date; reason: string; byEmail: string } | null;
    approval: { required: boolean; at: Date | null; byEmail: string | null };
    impact: { upcomingPaidBookings: number; pendingPayouts: number }; // shown in the confirm dialog
  }
  ```
- `POST /api/admin/influencers/:id/status` (`requireAdminMfa`; rate `admin-moderation`) body (zod discriminated union):
  `{ action: "suspend", reason: string(5..500) }` | `{ action: "reinstate" }` | `{ action: "approve" }` ->
  `200 { ok: true, view: AdminInfluencerStatusView }`; `400` bad body; `404` unknown; `409 { error }` when the state does not allow it
  (already suspended, not suspended, already approved, approval not required). Implementation in `lib/admin/moderation.ts`:
  one transaction with a conditional `updateMany` (`where: { id, suspendedAt: null }` for suspend, `{ id, suspendedAt: { not: null } }` for
  reinstate, `{ id, approvedAt: null }` for approve; `count === 0` -> 409) **plus** `recordAudit(..., tx)` (`influencer.suspended` with
  `{ reason }`, `influencer.reinstated`, `influencer.approved`) so the change never happens without its audit row. E-mail after commit.
- `GET /api/admin/influencers?page&q&status` gains `status = all | live | not-live | suspended | awaiting-approval` (unknown -> all); rows gain
  `accountStatus: "active" | "suspended" | "awaiting-approval"`; the view gains `status` and `counts: { suspended: number; awaitingApproval: number }`.

**E-mail:** new file `lib/email/account-status.ts` (pure, uses `renderEmail`): `accountSuspendedMessage(name, reason, supportEmail)`,
`accountReinstatedMessage(name, pageUrl)`, `accountApprovedMessage(name, pageUrl)`; sent with `sendAccountEmail(..., "account-status")`.

**UI**
- `InfluencerStatusPanel` (fills the WP-0 stub): fetches `GET .../status` (`useApiQuery(queryKeys.admin("influencer-status", { id }))`),
  shows a status badge, the reason/by/when, and buttons: Suspend (ConfirmDialog with required reason textarea and the impact numbers:
  "3 upcoming paid bookings stay booked; cancel them from Bookings if needed. 1 pending payout is not affected; cancel it if needed."),
  Reinstate (confirm), Approve (only when `approval.required` and not approved). After success `router.refresh()`.
- `InfluencersView` + `InfluencerSearchForm` + `pages/admin/Influencers.tsx`: status tabs (`LinkTabs`, with counts on Suspended and Awaiting
  approval) and a status badge column.
- Influencer side: no new screen; the go-live checklist on Overview and Onboarding shows the `account` item (existing `GoLiveChecklist`).

**Files owned by A:** `lib/readiness.ts`, `lib/public-profile.ts`, `lib/views/dashboard-overview.ts`, `lib/admin/data.ts` (only
`listInfluencers`, `getInfluencerDetail`, and the `InfluencerRow` type), `lib/views/admin-influencer.ts` (list part), `lib/checkout.ts`,
`lib/booking-approval.ts`, `lib/payouts.ts`, `lib/admin/moderation.ts` (new), `lib/views/admin-influencer-status.ts` (new),
`lib/email/account-status.ts` (new), `app/api/admin/influencers/[id]/status/route.ts` (new), `app/api/admin/influencers/route.ts`,
`app/api/admin/influencers/[id]/payouts/route.ts` (error mapping only if needed), `web/src/components/admin/InfluencerStatusPanel.tsx`,
`web/src/components/views/admin/InfluencersView.tsx`, `web/src/components/views/admin/InfluencerSearchForm.tsx`,
`web/src/pages/admin/Influencers.tsx`, tests below.

**Security considerations:** MFA-verified admin only; reason is plain text rendered by React (escaped) and in e-mail through
`renderEmail` (escaped); no influencer secret in any DTO; audit in the same transaction; the influencer never sees who suspended them
(the DTO for the influencer carries only the reason); suspension cannot be bypassed by `READINESS_BYPASS`; race-safe conditional updates.

**Tests**
- `tests/readiness.test.ts` (extend): suspended -> `account` blocker, `ready: false`, not bypassed; approval required + not approved -> blocker;
  gate off -> no `account` item; `isLiveBlocker`; `buildPublicInfluencerWhere` contains `suspendedAt: null` always and `approvedAt` only with the gate (AND count updated deliberately);
  the DB case "is live" flips with `suspendedAt`.
- `tests/moderation.test.ts` (new, DB): status GET gate (401 no cookie, 403 password-only session when 2FA required, 404), key set +
  `assertNoSecretKeys`; suspend -> 200, audit row exists with action `influencer.suspended`, e-mail captured via `setEmailSender`; second suspend
  -> 409; stranger `loadPublicProfile` -> null, owner -> preview with "Account in good standing"; hold route for that service refused;
  `startCheckout` on a pre-existing HELD booking -> `NotPayableError` and **no Payment row created** (inject `createOrder` via
  `mock.module("@/lib/payments")`); `approveRequest` -> 409; `createPayout` -> `PayoutError` 409; reinstate -> all of the above work again;
  approve with gate off -> 409, with gate on -> 200; list `?status=suspended` returns it, counts correct.
- Existing pinned tests updated deliberately: admin influencers list key set (`tests/spa-admin-core*.test.ts`).

**Acceptance walk-through**
1. Admin > Influencers > demo > Suspend with reason "Chargeback investigation". The panel shows Suspended; the audit log shows `influencer.suspended`; the server console prints the e-mail.
2. In a private window `/demo` is a 404; as `demo@example.com` it is a preview listing "Account in good standing"; the dashboard checklist shows the reason.
3. A hold made before step 1 cannot be paid (clear error, nothing charged). Creating a payout for demo is refused with the message.
4. Reinstate: `/demo` is live again in the private window. With `READINESS_REQUIRED=google,payout,approval` (or `payout,approval`), `review-demo` sits under "Awaiting approval"; Approve puts it live.

---

### WP-B Admin money operations (`mk/b-admin-money-ops`). About 3.5-4 h.

**B1 CSV exports**
- `GET /api/admin/exports/:kind?from=YYYY-MM-DD&to=YYYY-MM-DD`, `kind in payments|bookings|payouts|audit` (else 404). `requireAdminMfa`.
  Dates parsed with `parseReportDay` (`lib/views/dashboard-params.ts`); default range = the 1st of the current month (UTC) to today; `to` is
  inclusive; a range over 366 days -> 400. Count first; more than `ADMIN_EXPORT_ROW_CAP = 20_000` rows -> `400 { error: "More than 20,000 rows. Choose a shorter range." }`
  (honest refusal instead of a silently cut file). Body via `toCsv` from `lib/dashboard.ts` (already neutralises `= + - @` formula injection).
  Headers: `text/csv; charset=utf-8`, `Content-Disposition: attachment; filename="<kind>-<from>-to-<to>.csv"`, `Cache-Control: no-store`.
  Each export writes `recordAudit` action `admin.export` with `{ kind, from, to, rows }` (awaited before the body is returned).
- Columns (money as decimals `/100`, the convention of the earnings export; timestamps ISO UTC; erased customers as `(erased)` and empty e-mail):
  - payments (by `createdAt`): `created_at, payment_id, provider_payment_id, provider_order_id, status, amount, refunded, currency, needs_refund, refund_status, reconciled_at, reconciled_by, payout_id, booking_id, booking_status, influencer_slug, influencer_name, service_title, session_start, customer_name`
  - bookings (by `createdAt`): `created_at, booking_id, status, influencer_slug, service_title, service_type, session_start, customer_name, customer_email, paid, refunded, currency, meet_link_created` (yes/no, never the URL; never the phone or intake answers)
  - payouts (by `createdAt`): `created_at, payout_id, influencer_slug, status, currency, gross, refunds, fee_bps, fee, net, payment_count, destination (masked), reference, created_by, approved_by, approved_at, paid_by, paid_at`
  - audit (by `createdAt`): `created_at, admin_email, action, target_type, target_id, ip` (no `detail`, matching the audit page)
- Implementation: `lib/admin/exports.ts` (one function per kind returning `string[][]`, sequential queries, `select` only the listed columns),
  `app/api/admin/exports/[kind]/route.ts`. UI: `web/src/components/admin/ExportControls.tsx` (from/to date inputs + an `AppLink` "Download CSV"
  to the `/api` URL, which `AppLink` treats as a normal download) placed on Payments, Bookings, Payouts and Audit pages.

**B2 Refund a captured payment (admin)**
- `POST /api/admin/payments/:id/refund` body `{ reason: string(5..300), confirm: true }` (zod `z.literal(true)`). `requireAdminMfa`; rate `admin-money`.
- `lib/admin/refund.ts`:
  - `adminRefundEligibility(p, now): { allowed: true; remainingMinor } | { allowed: false; reason }` (pure). Allowed only when ALL hold:
    1. `p.status === "CAPTURED"` and `p.providerPaymentId` set;
    2. `remaining = amountMinor - (refundAmountMinor ?? 0) > 0`;
    3. not (`refundStatus === "requested"` and claimed less than `CLAIM_STALE_MS` ago) -> "A refund is already in progress";
    4. the booking is **not an upcoming live session**: not (`booking.status in [PAID, SCHEDULED]` and `session.startTime > now`), unless
       `p.needsRefund` (a double payment on a live booking is flagged on the payment) -> otherwise "Cancel the booking first (Bookings > Cancel)";
    5. the payment is not locked in a **PENDING** payout -> "This payment is in a pending payout. Cancel that payout first."
       (A payment in a PAID payout may be refunded; the existing "refunded since, to recover" logic in `lib/payouts.ts` flags it, and the
       confirm dialog says so.)
  - `adminRefundPayment(paymentId, admin, reason, ip, deps = { refund: refundPayment })`: load + eligibility (409 with reason);
    `recordAudit("payment.refund_requested", { remainingMinor, currency, reason })` **awaited before** Razorpay is called; then
    `deps.refund(paymentId, { reason })` (full remaining amount only; no influencer scope; no client amount). Map: `RefundNotAllowedError` -> 409,
    `RefundError` -> 502 `{ error }` + audit `payment.refund_failed`, `RefundPendingError` -> 202 `{ ok: true, status: "pending" }` + audit
    `payment.refund_pending`, success -> 200 `{ ok: true, status, amountMinor, fullyRefunded }` + audit `payment.refunded`.
- Why this is airtight: the amount is never client-supplied (always "what is left", computed from the row); idempotency and double-click
  safety come from `refundPayment`'s conditional claim (`refundStatus = "requested"`) and Razorpay's deterministic receipt
  `rf_<paymentId>_<cumulative>`; the webhook path (`applyRefundWebhook`) is untouched and still upserts by Razorpay refund id; capture amount
  checks are untouched; payout snapshots cannot be corrupted because pending payouts are excluded.
- Customer notice: Razorpay's own refund notification (default on for payments with an e-mail); no new customer e-mail in this WP.
- `lib/views/admin-payments.ts`: each row gains `refund: { allowed: boolean; reason: string | null; remainingMinor: number }` computed with
  `adminRefundEligibility` (one extra `select` of `booking.session.startTime` and `payout.status`). `PaymentsView`: a "Refund..." button on
  allowed rows -> ConfirmDialog (amount, customer name, influencer, reason textarea, warning when in a paid payout).

**B3 Cancel a booking on the platform's behalf**
- `POST /api/admin/bookings/:id/cancel` body `{ reason: string(5..500), confirm: true }`. `requireAdminMfa`; rate `admin-money`.
- `lib/admin/cancel.ts` `adminCancelBooking(bookingId, admin, reason, ip, deps = { cancel: cancelBooking, alert: alertInfluencer })`:
  allowed when `status in [PAID, SCHEDULED]` and `session.startTime > now`, or `status === "FAILED"` (what `cancelBooking` accepts; past sessions are
  refused: "This session has already taken place; refund the payment instead"). Audit `booking.cancel_requested` (awaited) -> `deps.cancel(bookingId,
  { actor: "influencer", reason: "Cancelled by the platform: " + reason })` (influencer actor = full refund decision; payments get `needsRefund`, or are
  refunded at once when `AUTO_REFUND_ON_CANCEL=true`; Calendar event, reminders and customer notice handled by the existing code) -> audit
  `booking.cancelled_by_admin` with `{ refund: result.refund.issued, warning: !!result.warning }` -> alert the influencer
  (`InfluencerAlertKind` gains `"platform-cancelled"` in `lib/alerts.ts`, message includes service, time and reason).
  Response `200 { ok: true, refund: { eligible, issued }, warning: string | null }`; 404; 409 with reason.
- `lib/views/admin-bookings.ts`: rows gain `cancel: { allowed: boolean; reason: string | null }`; `BookingsView`: "Cancel..." on allowed rows
  (ConfirmDialog with reason) and, after success, a toast "Cancelled. Refund: flagged for refund — use Payments > Refund" (or "refunded").

**B4 Booking search**
- `GET /api/admin/bookings?status&page&q`: `q` trimmed, max 120; if it passes `isEntityId` it matches the booking id exactly, else it is a
  case-insensitive `contains` on `customerEmail` (lowercased) or `customerName`. View gains `q`. `pages/admin/Bookings.tsx` passes `q`; a search input
  in `BookingsView` (GET form, URL is state, like the influencer search).

**Files owned by B:** `lib/admin/exports.ts`, `lib/admin/refund.ts`, `lib/admin/cancel.ts` (new); `lib/admin/data.ts` (only `listBookings`);
`lib/views/admin-payments.ts`, `lib/views/admin-bookings.ts`, `lib/alerts.ts` (one union member + its message/action URL);
`app/api/admin/exports/[kind]/route.ts`, `app/api/admin/payments/[id]/refund/route.ts`, `app/api/admin/bookings/[id]/cancel/route.ts` (new);
`app/api/admin/bookings/route.ts`; `web/src/components/admin/ExportControls.tsx`, `web/src/components/admin/RefundAction.tsx`,
`web/src/components/admin/CancelBookingAction.tsx` (new); `web/src/components/views/admin/PaymentsView.tsx`, `BookingsView.tsx`,
`PayoutsView.tsx`, `AuditView.tsx`; `web/src/pages/admin/Bookings.tsx`; tests below.

**Security considerations:** MFA gate on every endpoint (exports contain personal data); CSV injection neutralised; exports audited with
row counts; no phone numbers, intake answers, Meet URLs, tokens or full bank numbers in any export; refund/cancel need `confirm: true` and
a reason, are rate limited under `admin-money`, audited **before** the side effect; amounts server-computed only; CSRF Origin check applies
(POST) and the admin cookie is SameSite=Strict.

**Tests**
- `tests/admin-exports.test.ts` (new, DB): gate (401/403), unknown kind 404, bad range 400, over-cap 400 (use a small cap through an exported
  constant override or a `rowCap` parameter of the lib function), each kind's header row exactly, an erased booking shows `(erased)` and no e-mail,
  a cell starting with `=` is prefixed, `admin.export` audit row with the right count, `Cache-Control: no-store`.
- `tests/admin-refund-cancel.test.ts` (new): pure eligibility table (every branch above); DB: refund with injected fake `refund` -> audit
  `payment.refund_requested` then `payment.refunded`; second concurrent call -> 409 (claim); RefundError -> 502 and `refund_failed`; payment in
  PENDING payout -> 409; upcoming live booking -> 409, same with `needsRefund` -> allowed; route-level 401/403/400 (`confirm` missing)/404 with
  `mock.module("@/lib/payments")` so nothing reaches Razorpay; cancel with injected fake `cancel` and `alert` -> audit rows and alert called;
  past session -> 409.
- Existing pinned key sets updated deliberately: admin payments rows (`refund`), admin bookings view (`q`, rows `cancel`) in `tests/spa-admin-money.test.ts`.
- View render tests (react-dom/server + `fake-navigate`): Refund button only on allowed rows; Cancel only on allowed rows; export link URL.

**Acceptance walk-through**
1. Admin > Payments: "Download CSV" for this month opens a CSV; Audit shows `admin.export`.
2. Payments > Needs refund: the seeded cancelled booking's payment shows "Refund..."; confirm -> Razorpay rejects the seeded id -> clear error and `payment.refund_failed`. With a real test-mode payment (book `/demo`, pay with the test card, then step 3), the refund succeeds and the row shows Refunded after the webhook / reconciliation.
3. Admin > Bookings: search `customer.seedfeat@example.com`; on the upcoming booking "Cancel..." with a reason -> customer notice logged, payment flagged, influencer alert logged; then refund it from Payments.

---

### WP-C Influencer activity log (`mk/c-activity-log`). About 3 h.

**Library**
- `lib/activity-actions.ts` (pure, no imports): `export const ACTIVITY_ACTIONS = { "auth.login": "Signed in", ... } as const;
  export type ActivityAction = keyof typeof ACTIVITY_ACTIONS;` plus `summariseActivity(action, detail): string` (server-side wording).
- `lib/activity.ts`: `recordActivity(input: { influencerId: string; action: ActivityAction; actor?: "influencer" | "system"; targetType?: string;
  targetId?: string; detail?: Record<string, string | number | boolean | null>; req?: Request }, db = prisma): Promise<void>`. Takes the IP from
  `clientIp(req.headers)` (sliced to 64) and the user agent (sliced to 200). **Never throws** (catches and `reportError`s): a logging failure must
  not fail the influencer's action. Decision: best-effort after the action succeeds (not in the same transaction), documented in doc/13; the
  admin audit log keeps its stricter rule. `describeDevice(userAgent)` -> "Chrome on Windows"-style summary (small regex table, no dependency).
- `lib/activity-retention.ts` (fills the stub): `sweepOldActivity(now)` deletes rows older than 365 days (`ACTIVITY_RETENTION_DAYS = 365`, a constant, no env var).
- **Detail allowlist:** never a customer e-mail, name or phone, never a token, password, account number or UPI id (masked values only), never free text typed by the customer.

**Instrumentation** (one `await recordActivity(...)` after success unless noted; C owns these route files for this purpose only):

| Route | Action | Detail |
|---|---|---|
| `POST /api/auth/register` | `auth.registered` | — |
| `POST /api/auth/login` success | `auth.login` | — |
| `POST /api/auth/login` wrong password for an existing user | `auth.login_failed` | — (called **without** `await` so response timing does not reveal that the account exists) |
| `POST /api/auth/verify-email` | `auth.email_verified` | — |
| `POST /api/auth/change-password` | `auth.password_changed` | — |
| `POST /api/auth/reset-password` | `auth.password_reset` | — |
| `POST /api/auth/logout-all` | `auth.logout_all` | `{ sessions: n }` |
| `DELETE /api/auth/sessions` | `auth.session_revoked` | — |
| `POST /api/auth/reauth` | `auth.reauthenticated` | — |
| `PATCH /api/dashboard/profile` | `profile.updated` | `{ fields: "name,slug", slugFrom, slugTo }` (slug only when changed) |
| `POST/PATCH /api/dashboard/services` | `service.created` / `service.updated` | `{ serviceId, title, priceFrom, priceTo, currency, activeFrom, activeTo }` (only changed values) |
| `POST/PATCH/DELETE /api/dashboard/availability`, `/blocked-dates` | `availability.changed` | `{ change: "rule-added" | "rule-updated" | "rule-removed" | "day-blocked" | "day-unblocked" }` |
| `POST /api/dashboard/bookings/:id` cancel / reschedule | `booking.cancelled` / `booking.rescheduled` | `{ bookingId }` |
| `POST /api/dashboard/bookings/:id/decision` | `booking.request_approved` / `booking.request_declined` | `{ bookingId }` |
| `POST /api/dashboard/bookings/:id/refund` | `booking.refunded` | `{ bookingId, amountMinor, currency, status }` |
| `POST /api/dashboard/customers/erase` | `customers.erased` | `{ erased, blocked }` (never the e-mail) |
| `PUT /api/dashboard/payout-account` | `payout_account.updated` | `{ method, destination: <masked> }` |
| `GET /api/google/callback` success / `DELETE /api/dashboard/google` | `google.connected` / `google.disconnected` | `{ account: <google e-mail> }` |
| `POST/DELETE /api/dashboard/whatsapp` | `whatsapp.connected` / `whatsapp.disconnected` | `{ phone: <display phone> }` |
| `POST /api/dashboard/onboarding` (finish) | `onboarding.completed` | — |
| `GET /api/dashboard/earnings/export` | `earnings.exported` | `{ from, to, rows }` |

**Endpoints**
- `GET /api/dashboard/activity?page=` (`requireApiAuth`, own rows only) -> `lib/views/dashboard-activity.ts`:
  `{ page, pageCount, rows: { id, createdAt, action, summary, actor: "you" | "system", ip: string | null, device: string | null }[] }` (25 per page, page <= 400).
- `GET /api/admin/influencers/:id/activity?page=` (`requireAdminMfa`, 404 unknown influencer) -> `lib/views/admin-influencer-activity.ts`: same shape with `actor: "influencer" | "system"`.

**UI:** `web/src/components/app/AccountActivityPanel.tsx` (new card "Account activity" in `SettingsView`, below devices: table When / What / Device / IP, pagination
via local state + `useApiQuery(queryKeys.dashboard("activity", { page }))`, an explanatory line "If you do not recognise an entry, change your password and log out everywhere");
`web/src/components/admin/InfluencerActivityPanel.tsx` (fills the stub, same table).

**Files owned by C:** `lib/activity-actions.ts`, `lib/activity.ts`, `lib/activity-retention.ts`, `lib/views/dashboard-activity.ts`,
`lib/views/admin-influencer-activity.ts`, `app/api/dashboard/activity/route.ts`, `app/api/admin/influencers/[id]/activity/route.ts` (new);
the instrumented route files in the table (only the added calls); `web/src/components/app/AccountActivityPanel.tsx`,
`web/src/components/admin/InfluencerActivityPanel.tsx`, `web/src/components/views/dashboard/SettingsView.tsx` (mount only); tests below.

**Security considerations:** influencer sees only own rows (scoped by `auth.influencerId`); IPs are shown to the account owner and admins
only; no customer personal data in `detail`; failed-login logging cannot become an existence oracle (not awaited, and only after the existing
constant-time path); retention bounded; user agent never returned raw.

**Tests:** `tests/activity-log.test.ts` (new, DB): `recordActivity` never throws (bad influencer id -> no throw, `reportError` called);
detail allowlist (a unit test that `summariseActivity` output for every action contains no `@`); dashboard endpoint 401, own rows only (a second
influencer's rows invisible), key set + `assertNoSecretKeys`, paging; admin endpoint 401/403/404 + key set; integration: call the login route
handler (mock `next/headers`) with good and bad passwords -> `auth.login` row, `auth.login_failed` row appears (poll up to 1 s); refund route
with injected Razorpay -> `booking.refunded`; customers erase -> `customers.erased` without the e-mail anywhere in the row; `sweepOldActivity`
deletes a 400-day-old row only. Existing auth/dashboard route tests must stay green unchanged.

**Acceptance walk-through:** log in as demo (and once with a wrong password) -> Settings > Account activity lists "Failed sign-in" and "Signed in"
with device and IP; change a service price -> "Service updated: price 1,000 -> 1,200"; admin > Influencers > demo shows the same entries.

---

### WP-D Customer portal: find your bookings, export, erase, receipts (`mk/d-customer-portal`). About 4 h.

**Flow:** `/bookings` asks for an e-mail -> the server always answers "If we have bookings for that address, we have e-mailed a link" -> the
e-mail (only sent when bookings exist) links to `/bookings/<token>` (valid 60 minutes) -> the portal lists every booking for that address across
all influencers, with the manage link for upcoming live ones, a receipt for paid ones, "Download my data (JSON)" and "Erase my data".

**Library (`lib/customer-portal.ts`)**
- `requestPortalLink(emailInput, ip, deps = { send: sendAccountEmail, now })`: normalise (`trim().toLowerCase()`), identity limit
  `IDENTITY_RULES.customerAccessEmail` (limited -> silently do nothing), look up whether any non-redacted booking exists; if yes, create
  `CustomerAccessToken` (`randomToken()` / `hashToken()` from `lib/auth/tokens.ts`, `expiresAt = now + 60 min`), delete that address's expired tokens,
  and e-mail `${APP_URL}/bookings/<token>` through the **platform** provider (never the influencer's Gmail). Returns `{ done: Promise<void> }`; the route
  does **not** await `done`, so response time does not reveal whether bookings exist (tests await `done` directly). The deployment is a
  long-running Node server (doc/08), so the detached promise completes.
- `resolvePortalToken(token)`: shape check (base64url, 20-100 chars), lookup by hash, `expiresAt > now` -> `{ email } | null`.
- `loadPortalBookings(email)`: bookings with `customerEmail = email` and `redactedAt = null`, newest first, max 200, with service, influencer name,
  session, captured/refunded payments.
- `buildPortalExport(email)`: everything stored about that address: bookings (reference, created, status, influencer, service, start/end, name,
  e-mail, phone, time zone, WhatsApp opt-in, intake answers), payments (amount, currency, status, refunded, created, payment reference), messages
  (channel, template, status, sent at). No internal ids except the booking reference; no provider order ids; no Meet links of other people.
- `erasePortalData(email, now)`: group bookings by influencer, call the existing `eraseCustomerData(influencerId, email, now)` for each (it already
  keeps upcoming live bookings and payment rows), sum `{ erased, blocked }`; if `blocked === 0` delete all of that address's tokens; write one
  system audit row `recordAudit({ adminId: null, email: "system:customer-request" }, { action: "customer.erased", detail: { erased, blocked } })`
  (no e-mail stored); send a confirmation e-mail "Your data was erased" (or "...kept N upcoming bookings; cancel them first").
- `lib/customer-access-sweep.ts` (fills the stub): delete expired `customer_access_tokens`.
- `lib/receipts.ts` (pure): `buildReceipt(booking, payments): ReceiptView | null` used by both the portal and the manage page.
  ```ts
  interface ReceiptView {
    reference: string;            // booking id, already shown to customers as the reference
    issuedTo: string;             // customer name
    seller: string;               // BRAND_NAME (the platform collects the payment)
    hostName: string; serviceTitle: string; sessionStart: string;
    paidAt: string; amountMinor: number; currency: string;
    paymentReference: string | null; // Razorpay payment id, already in the confirmation e-mail
    refundedMinor: number;
    statusText: "Paid" | "Partly refunded" | "Refunded";
  }
  ```
- E-mail templates in new file `lib/email/customer-portal.ts`: `portalLinkMessage(url)`, `portalErasedMessage({ erased, blocked })`.

**Endpoints** (all under `/api/customer`, private no-store via WP-0's `next.config.ts` entry; CSRF Origin check applies to the POSTs)
- `POST /api/customer/access` body `{ email: z.email().max(200) }` -> always `202 { ok: true }` (400 only for a malformed body). Rate `customer-access` + identity rule.
- `GET /api/customer/portal/:token` -> `lib/views/customer-portal.ts` `loadCustomerPortalView(token)`:
  `403 { state: "expired" }` | `200 { state: "ok", email, expiresAt, bookings: PortalBooking[], erasable: number, blocked: number }` with
  `PortalBooking = { reference, influencerName, serviceTitle, startTime, durationMin, status, statusText, manageUrl: string | null, receipt: ReceiptView | null }`.
  Bookings never paid (`HELD`/`PENDING_PAYMENT`/`EXPIRED` without a captured payment) are not listed (they are in the export). `manageUrl` =
  `buildSelfServiceUrl(id)` only for `PAID`/`SCHEDULED` with a future start. Rate `customer-portal`.
- `GET /api/customer/portal/:token/export` -> `application/json` attachment `my-bookings-<date>.json`, `Cache-Control: no-store`; 403 when expired. Rate `customer-export`.
- `POST /api/customer/portal/:token/erase` body `{ confirm: true }` -> `200 { ok: true, erased, blocked }`; 403 expired. Rate `customer-erase`.
- `GET /api/manage/:token` (existing): `ManageBookingData` gains `receipt: ReceiptView | null`.

**UI**
- `web/src/pages/booking/FindBookings.tsx` + `web/src/components/views/booking/FindBookingsView.tsx`: e-mail field, submit, the neutral
  confirmation text, a note on how long the link lasts. `FocusedLayout`.
- `web/src/pages/booking/CustomerPortal.tsx` + `web/src/components/views/booking/CustomerPortalView.tsx`: `useApiQuery(queryKeys.customerPortal(token), ...)`;
  expired state with a link back to `/bookings`; upcoming and past lists; per booking "Manage" (manage URL) and "Receipt" (expands a
  `ReceiptCard`, with "Print" calling `window.print()`); "Download my data"; "Erase my data" ConfirmDialog that states exactly what is erased and what is
  kept (payment records for accounting; upcoming sessions until cancelled). After erasure: success state, no further data shown.
- `web/src/components/views/booking/ReceiptCard.tsx` (shared by portal and manage); `ManageView.tsx` shows it for paid bookings.
- `web/src/styles/print.css`: hide header/footer/buttons, show only the expanded receipt.
- `PrivacyView.tsx`: a paragraph "Your rights" linking to `/bookings` (access, export, erasure; what is retained and why).

**Files owned by D:** `lib/customer-portal.ts`, `lib/customer-access-sweep.ts`, `lib/receipts.ts`, `lib/email/customer-portal.ts`,
`lib/views/customer-portal.ts` (new); `lib/views/booking-manage.ts`; `app/api/customer/**` (new); `web/src/pages/booking/FindBookings.tsx`,
`CustomerPortal.tsx`; `web/src/components/views/booking/FindBookingsView.tsx`, `CustomerPortalView.tsx`, `ReceiptCard.tsx` (new),
`ManageView.tsx`; `web/src/components/views/public/PrivacyView.tsx`; `web/src/styles/print.css`; tests below.

**Security considerations:** possession of the inbox is the authentication; tokens are 256-bit random, stored hashed, 60-minute TTL, never logged
(`loggablePath` redaction from WP-0), sent with `Referrer-Policy: no-referrer`, `noindex,nofollow`; no enumeration (constant answer, detached send,
identity + IP limits; no e-mail to addresses without bookings, so the form cannot be used to spam strangers); the portal DTO has no key named
like a token (the manage link travels as `manageUrl`); erasure reuses the reviewed `eraseCustomerData` rules and is idempotent; the audit row stores
no personal data; export contains only that address's own data; rate limits on every route.

**Tests:** `tests/customer-portal.test.ts` (new, DB; sets `APP_URL`, `APP_SECRET`, `EMAIL_PROVIDER=log` or `setEmailSender` capture):
request for an address with bookings -> one e-mail with a `/bookings/` link, token row stored hashed (the raw token is not in the table);
for an unknown address -> 202 and no e-mail; identity limit -> fourth request sends nothing; malformed body 400; portal: expired/unknown/garbage token
-> 403, valid -> key set pinned + `assertNoSecretKeys`, lists bookings of two different influencers, hides never-paid holds, `manageUrl` only for
future live bookings; export -> JSON attachment headers, contains intake answers and phone, contains no `providerOrderId`; erase -> past bookings
redacted, upcoming kept and reported as `blocked`, tokens kept while blocked > 0 and deleted when 0, audit row has no `@`; second erase is a no-op;
`buildReceipt` pure cases (paid, partly refunded, refunded, none); manage view key set updated deliberately (`tests/spa-booking*.test.ts`);
view render tests for the portal states. `tests/spa-booking-pages.test.ts`-style wiring check for the two pages (title equals route table).

**Acceptance walk-through:** `/bookings` -> enter `customer.seedfeat@example.com` -> the server console shows the e-mail link -> open it: three
past, one upcoming (Manage works), one cancelled; open a receipt and print preview shows only the receipt; download the JSON; Erase -> "4 erased,
1 kept (upcoming)"; reload the link -> only the upcoming booking is left. An unknown e-mail shows the same confirmation and no e-mail is logged.

---

### WP-E Reminder repair (`mk/e-reminder-repair`). About 2 h.

**Problem found in the code:** nothing ever marks a booking `COMPLETED`, so a past session stays `SCHEDULED`; `sendReminderForBooking` checks
only the status and `expectedStartTime`. A delayed job that fires late (worker down for hours, then restarted) is therefore sent even after the
session, and the 24-hour template says "your session is tomorrow". If Redis loses its data, delayed reminder jobs are gone and nothing re-creates them.

**Changes**
- `lib/reminders.ts` `sendReminderForBooking`: `ReminderDeps` gains `now: () => Date` (default `() => new Date()`). Before sending: `15m` is
  skipped when `now >= session.startTime`; `24h` is skipped when `startTime - now < REMINDER_24H_MIN_LEAD_MS` (12 h, because the text says
  "tomorrow"). Outcome `"skipped"` with a log line saying why.
- `lib/queue.ts`: `ensureReminder(kind, bookingId, startTime, now, queue = getQueue(REMINDER_QUEUE))`: if a job with `reminderJobId(kind, id)` exists
  and its `data.expectedStartTime` equals `startTime` -> leave it; if it exists with a different time and is `delayed` or `waiting` -> remove and
  re-add; if it is active/completed/failed -> leave it; if none -> add with `delay = max(0, fireTime - now)` and the same options as
  `enqueueReminders` (deterministic id, attempts, backoff, `removeOnComplete: { age: 7 days }`, `removeOnFail: false`). Every Redis call bounded with `within` (lib/timeout.ts).
- `lib/reminders.ts`: pure `planReminderRepairs(bookings, sentTemplates, now) -> { bookingId, kind, startTime }[]`: for SCHEDULED bookings with
  `now < start <= now + 25 h`: `24h` wanted if `start - now >= 12 h`; `15m` wanted if `start > now`; skip any (booking, template) that already has a
  `Message` row on any channel. `reconcileReminders(now, deps)`: query (max 500, ordered by start, `redactedAt: null`), `Message` rows for those
  ids with templates `reminder-24h`/`reminder-15m`, plan, `ensureReminder` each; returns `{ checked, repaired }`; logs when `repaired > 0`.
- `worker/reminder-reconcile.ts`: `startReminderReconcile()` runs 60 s after start (a restart after an outage is exactly when repair matters) and
  then every 10 minutes, never overlapping itself; skipped without `REDIS_URL`; errors go to `reportError`. `worker/index.ts`: one import + one call.

**Files owned by E:** `lib/reminders.ts`, `lib/queue.ts`, `worker/reminder-reconcile.ts` (new), `worker/index.ts` (one line), tests below.

**Security considerations:** none new (no endpoint, no data exposure). Correctness: idempotent through deterministic job ids, the `Message`
unique key and the run-time guards; cannot double-send because `sendMessageForBooking` returns `already-sent` for a template already sent.

**Tests:** `tests/reminders.test.ts` (extend, pure): 15m after start skipped; 24h at 11 h before skipped, at 13 h sent; existing cases unchanged.
`tests/reminder-reconcile.test.ts` (new): `planReminderRepairs` table (window edges, existing Message rows, past bookings excluded); `ensureReminder`
with a fake `ReminderQueue` (none -> add with delay 0 for an overdue 15m; same time -> no-op; different time delayed -> remove + add; completed -> no-op);
DB: own influencer + SCHEDULED booking starting in 3 h, no Message rows, fake queue -> exactly one `15m` add (24h not wanted), second run -> no add.
`tests/dev-mock-worker.test.ts` and other worker tests stay green.

**Acceptance walk-through:** with a local worker and `MESSAGING_DRY_RUN=true`: make a booking starting in ~2 h, flush its reminder jobs (or delete them
from Redis), restart the worker -> within 60 s the log shows `repaired 1` and the 15-minute reminder fires at the right time; a booking whose 24h job
fires 6 h before start logs "skipped: less than 12 h left".

---

### WP-F Admin finance report (`mk/f-admin-reports`). About 2.5 h.

**Endpoint:** `GET /api/admin/reports?from=YYYY-MM-DD&to=YYYY-MM-DD` (`requireAdminMfa`; rate `admin-reports`; default = 1st of current month UTC to today;
inclusive `to`; range <= 366 days else 400) -> `lib/views/admin-reports.ts` `loadAdminReportsView(from, to, now)` over `lib/admin/reports.ts`
(raw SQL on the `@@map` table names, **sequential** queries, not `Promise.all`, to respect the connection cap):

```ts
interface AdminReportsView {
  from: string; to: string; generatedAt: Date;
  range: {                        // per currency, for [from, to]
    currency: string;
    grossMinor: number; paymentCount: number;      // payments CAPTURED or REFUNDED, by payments.created_at
    refundsMinor: number; refundCount: number;     // refunds pending|processed, by refunds.created_at
    netMinor: number;                              // gross - refunds (period figures, not the same payments; labelled so)
    payoutsPaidCount: number; payoutsPaidNetMinor: number; feesEarnedMinor: number; // payouts PAID, by paid_at
  }[];
  monthly: { month: string /* YYYY-MM, UTC */; currency: string; grossMinor: number; refundsMinor: number; feesEarnedMinor: number; paymentCount: number }[]; // last 12 months
  balances: {                     // right now, per currency
    currency: string;
    heldForInfluencersMinor: number; // CAPTURED, needs_refund = false, booking PAID|SCHEDULED|COMPLETED, not in a PAID payout: amount - refunded (before platform fee)
    inPendingPayoutsMinor: number;   // payouts PENDING: net
    owedToCustomersMinor: number;    // CAPTURED and needs_refund = true: amount - refunded
    toRecoverMinor: number;          // refunds made after their payout was paid (the same rule as postPayoutRefunds in lib/payouts.ts)
  }[];
}
```

The implementer must read `postPayoutRefunds` and `loadPayable` in `lib/payouts.ts` and reuse their exact rules; a test asserts that
`toRecoverMinor` equals the sum of `postPayoutRefunds` over the fixture's paid payouts.

**UI:** `web/src/pages/admin/Reports.tsx` (replaces the placeholder) + `web/src/components/views/admin/ReportsView.tsx`: a GET form for the range (the
`GetForm` pattern), period cards per currency (`Stat`), a monthly table, a balances card with a one-line definition under each number ("before the
platform fee", "flagged payments not yet refunded"). No chart library; the monthly table may carry a CSS bar (pure CSS width) at most.

**Files owned by F:** `lib/admin/reports.ts`, `lib/views/admin-reports.ts`, `app/api/admin/reports/route.ts` (new),
`web/src/pages/admin/Reports.tsx`, `web/src/components/views/admin/ReportsView.tsx` (new), tests below.

**Security considerations:** MFA gate; aggregates only (no personal data, no ids); bounded range; rate limited; read-only.

**Tests:** `tests/admin-reports.test.ts` (new, DB). The report aggregates the whole shared database, so the fixture uses its own influencer
and a test-only currency code (`XTS`, the ISO code reserved for testing; `currency` is free text in the schema) and asserts only that currency's
rows: fixture with captured, partly refunded, fully refunded, needs-refund payments, a PENDING and a PAID
payout and a refund after the payout -> every number asserted; range validation 400; key set + `assertNoSecretKeys`; gate 401/403. A page wiring test
(title equals route table, endpoint used).

**Acceptance walk-through:** Admin > Reports shows this month's figures; with seed data, "To recover" shows the seeded refund after the paid payout and
"Owed to customers" the seeded needs-refund payment; after refunding it in WP-B it moves to Refunds and leaves "Owed to customers".

---

## 3. Cross-cutting work

### 3.1 Navigation (all in WP-0)
- Admin sidebar: **Reports** (`/admin/reports`, `IconBarChart`) after Payouts. Mobile: under "More".
- Influencer sidebar: unchanged (Account activity is a card in Settings).
- Site footer: "Find your booking" -> `/bookings`; focused-layout footer: "Your bookings".
- Influencers page tabs (WP-A) and the Payments/Bookings row actions (WP-B) are inside existing pages.

### 3.2 Route table (`lib/spa/routes.ts`, WP-0)

| id | path | title | template | robots | noReferrer | guard |
|---|---|---|---|---|---|---|
| `customer-bookings` | `/bookings` | Find your bookings | brand | noindex | — | public |
| `customer-portal` | `/bookings/:token` | Your bookings | brand | noindex,nofollow | yes | public (token) |
| `admin-reports` | `/admin/reports` | Reports | admin | noindex,nofollow | — | `RequireAdmin` |

Plus the `matchSpaRoute` branch, robots disallow lines, smoke paths, route count 39.

### 3.3 Rate limits
All listed in WP-0 (0.6). No feature branch edits `lib/rate-limit/policies.ts`.

### 3.4 New and changed endpoints (summary)

| Method, path | Auth | WP |
|---|---|---|
| GET, POST `/api/admin/influencers/:id/status` | `requireAdminMfa` | A |
| GET `/api/admin/influencers?status=` (changed) | `requireAdminMfa` | A |
| GET `/api/admin/exports/:kind` | `requireAdminMfa` | B |
| POST `/api/admin/payments/:id/refund` | `requireAdminMfa` | B |
| POST `/api/admin/bookings/:id/cancel` | `requireAdminMfa` | B |
| GET `/api/admin/bookings?q=` (changed), GET `/api/admin/payments` (rows gain `refund`) | `requireAdminMfa` | B |
| GET `/api/dashboard/activity` | `requireApiAuth` | C |
| GET `/api/admin/influencers/:id/activity` | `requireAdminMfa` | C |
| POST `/api/customer/access` | none (rate + identity limits) | D |
| GET `/api/customer/portal/:token`, GET `.../export`, POST `.../erase` | access token | D |
| GET `/api/manage/:token` (gains `receipt`) | signed token | D |
| GET `/api/admin/reports` | `requireAdminMfa` | F |

### 3.5 DTO tests (every new or changed endpoint: gate, ownership, exact key set, `assertNoSecretKeys`)
New: `tests/moderation.test.ts` (A), `tests/admin-exports.test.ts`, `tests/admin-refund-cancel.test.ts` (B), `tests/activity-log.test.ts` (C),
`tests/customer-portal.test.ts` (D), `tests/reminder-reconcile.test.ts` (E), `tests/admin-reports.test.ts` (F).
Deliberately changed pinned tests (reason in the commit): `spa-routes` (count, flags), `spa-robots`, `rate-limit`, `env` (WP-0); `readiness`,
admin influencers key set (A); admin payments/bookings key sets (B); manage view key set (D); `reminders` (E).

### 3.6 Docs (WP-Z unless noted)
- `README.md`: new sections "Suspending and approving influencers", "Admin exports, refunds and cancellations", "Account activity",
  "Find your bookings (customers)", "Reports", and a line under "Payment recovery and monitoring" for reminder repair; `READINESS_REQUIRED` gains `approval` under "Go-live readiness".
- `CLAUDE.md`: Architecture gains four short bullets: account status is part of readiness (`isLiveBlocker`, `suspendedAt` in `buildPublicInfluencerWhere`); every new
  influencer mutation calls `recordActivity` (best-effort, detail allowlist); customer portal access tokens (hashed, 60 min, `/api/customer/*`); admin refund/cancel rules
  (server-computed amount, audit before side effect, pending-payout exclusion). Commands: `npm run db:seed:features`.
- `doc/12-front-end.md`: the three new pages in the folder map; the stub-component pattern used by WP-0 (for the next parallel project).
- `doc/08-deployment.md`: `READINESS_REQUIRED=approval`; retention of activity rows (365 days) and access tokens; the reminder repair timer.
- `doc/13-marketplace-essentials.md`: per-WP deviations (written by each WP in its own section) and the final verification notes (Z).
- Privacy policy wording (`PrivacyView`, WP-D) and `.env.example` comment (WP-0).

### 3.7 Seed / dev-logins
- `npm run db:seed:features` (WP-0, section 0.8). `npm run dev:logins` unchanged (demo influencer + two admins are enough: two admins are needed to see the four-eyes
  flows; one admin suspends, either refunds).
- For the approval demo run the server with `READINESS_REQUIRED=payout,approval` (and `READINESS_BYPASS=false`), otherwise `READINESS_BYPASS=true` as today.

---

## 4. Order of work and merging

1. **WP-0 foundation** (integration owner). Merge to `main`, apply the migrations to the shared DB, `npx prisma generate`. Announce "go".
2. **A, B, C, D, E, F in parallel** (six Sonnet implementers), each branching from the new `main`, each touching only its owned files.
3. Merge order (each: rebase on `main`, `npm run typecheck`, the WP's test files + every pinned test it touched, `npm run build`, then merge):
   1. **A** first: it changes the live rule, checkout and payouts (the money path); landing it first means every later branch is tested against it.
   2. **E**: backend only, small; touches the worker.
   3. **B**: money operations; depends on nothing from A but is tested after A so suspension + cancel + refund can be walked end to end.
   4. **C**: wide but shallow edits to many route files; merging after A and B avoids rebasing their tests on top of it.
   5. **D**: new public surface; independent.
   6. **F**: read-only; last because its fixtures can then include refunds made the B way.
4. **WP-Z integration** (integration owner): docs (3.6), consolidate `doc/13`, run the whole suite one file at a time (`DATABASE_POOL_MAX=2
   --test-concurrency=1`, one retry for known flaky DB timeouts), `npm run build`, `node scripts/spa-smoke.mjs` against `next start`, the
   cross-feature walk-through below, an Opus security/code review of the combined diff, then tag.

Shared files and their single owner:

| Shared file | Owner | When |
|---|---|---|
| `prisma/schema.prisma`, `prisma/migrations/*` | WP-0 | before features |
| `lib/spa/routes.ts`, `web/src/router.tsx`, `lib/robots-rules.ts`, `scripts/spa-smoke.mjs` | WP-0 | before features |
| `lib/rate-limit/policies.ts`, `lib/rate-limit/redact.ts`, `next.config.ts`, `lib/env.ts`, `.env.example` | WP-0 | before features |
| `AdminShell.tsx`, `SiteChrome.tsx`, `icons.tsx`, `web/src/lib/query.ts`, `globals.css` | WP-0 | before features |
| `InfluencerDetailView.tsx` (stub mounts), `lib/auth/sweep.ts` (stub wiring) | WP-0 | before features |
| `lib/admin/data.ts` | A (`listInfluencers`, `getInfluencerDetail`), B (`listBookings`) | separate functions; integration owner resolves any textual conflict |
| `package.json` (script `db:seed:features`) | WP-0 | before features |
| `README.md`, `CLAUDE.md`, `doc/12`, `doc/08` | WP-Z | after all |
| `doc/13-marketplace-essentials.md` | each WP its own section; Z the rest | |

**Cross-feature walk-through (Z):** register a new influencer with `READINESS_REQUIRED=payout,approval` -> awaiting approval -> approve -> book and pay
with a Razorpay test card -> customer finds the booking at `/bookings` -> admin suspends the influencer -> admin cancels the booking -> admin refunds the
payment -> Reports shows the refund and nothing owed -> influencer's Account activity and the admin audit log show every step -> customer erases their data.

---

## 5. Risks, and what was deliberately not chosen

### 5.1 Not chosen: coupons / discounts (money-touching)
The server rules could be made sound (the coupon is resolved server-side at `startCheckout`, `Payment.amountMinor` is the discounted price, and
`applyCapturedPayment` already compares the capture with `Payment.amountMinor`, so the webhook check stays valid). It is deferred because it needs
**business decisions that do not exist yet**: who funds the discount (influencer or platform), whether the platform fee is computed on the list or the
paid price, how an already-created Razorpay order is invalidated when a coupon is applied after `startCheckout` reused an open order, per-customer and
global usage limits under concurrency (row locks on a coupon table), and how refunds and payout snapshots treat a discounted payment. Value today is
marketing; risk is high and spans checkout, payouts and refunds.

### 5.2 Not chosen: automatic refunds of flagged payments
`needsRefund` covers several different situations (late capture after the slot was retaken, amount mismatch, double payment, policy cancellations). An
amount mismatch can be a test or fraud signal; a worker that refunds automatically would move money with no human judgment and would interact with
pending payouts. `AUTO_REFUND_ON_CANCEL` already covers the policy path; WP-B makes every other case one audited click with server-enforced rules.

### 5.3 Other deferrals (see section 1 for reasons)
Reviews/ratings, discovery/search, tax invoices and payout statements (legal decision on supplier and GSTIN), notifications center, influencer analytics
beyond Earnings, influencer 2FA, influencer account closure, admin roles, admin e-mail on new approval requests, Sentry (needs an account; adapter later
behind `reportError`), waitlists, customer accounts.

### 5.4 Risks and mitigations

| Risk | Mitigation |
|---|---|
| A's readiness change takes live pages offline by mistake | `account` item only appears when suspended or gate on; gate default off; migration grandfathers onboarded accounts; `isLiveBlocker` replaces three copies of the rule; A merges first and the full readiness/public-profile/hold tests run on it |
| Turning on the approval gate later hides influencers who registered while it was off | Documented in README/doc/08; the "Awaiting approval" tab lists them with a count; approval is one click |
| Admin refunds double-pay or corrupt payout snapshots | Reuses `refundPayment` (conditional claim, deterministic receipt); full remaining amount only; pending-payout payments refused; upcoming live bookings must be cancelled first; audit before the call; tests for concurrency and every refusal |
| Suspension does not stop a checkout already in Razorpay | Accepted on purpose (webhook untouched); admin cancels and refunds via WP-B; stated in the confirm dialog text and README |
| Activity logging slows or breaks influencer actions | Best-effort, never throws, one insert; failed-login write not awaited |
| Customer portal used for enumeration or spam | Constant 202, detached send, no e-mail to unknown addresses, IP + per-address limits, hashed 60-minute tokens, no-referrer, redacted logs |
| Erasure removes data needed for accounting or an upcoming session | Reuses `eraseCustomerData` (keeps payments and upcoming live bookings); confirm dialog states what is kept |
| Reminder repair sends duplicates | Deterministic job ids, `Message` row check, `already-sent` in messaging, run-time guards; tests with a fake queue |
| Finance numbers disagree with payouts code | F must reuse `lib/payouts.ts` rules; a test cross-checks `toRecoverMinor` with `postPayoutRefunds` |
| Six implementers exhaust the 15-connection shared database | Pool 2, one DB test process per implementer, no parallel `npm run dev` against it, only the integration owner migrates |
| Branch collisions | WP-0 pre-registers routes, nav, rate rules, query key, schema, stubs and sweeps; per-file ownership lists; A/B split `lib/admin/data.ts` by function |
| Placeholder pages ship if a WP slips | Z refuses to tag while any placeholder `EmptyState "Coming soon"` remains (grep in the release checklist); a slipped WP can be reverted to its placeholder route, which is harmless |
| Existing behaviour regresses | No webhook, capture, hold-locking or signing code is modified; pinned tests change only deliberately with the reason in the commit; full suite + smoke + Docker build in Z |

### 5.5 Time box
WP-0 about 2 h; A 3.5 h; B 3.5-4 h; C 3 h; D 4 h; E 2 h; F 2.5 h; Z 1.5-2 h. With six parallel implementers the elapsed time is roughly
2 h (foundation) + 4 h (features) + 2 h (merges and Z), about one working day.
