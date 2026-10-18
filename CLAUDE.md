# CLAUDE.md

Guidance for Claude Code (and any newcomer) working in this repository. Everything here was checked against the code at the
`spa/90-cleanup` branch; when code and this file disagree, the code wins, then fix this file.

## What this is

Paid 1:1 and small-group sessions for creators. A customer picks a time on an influencer's page, pays with Razorpay, and a
Google Meet link is created on the influencer's own calendar and sent by WhatsApp (SMS fallback) and email, with reminders.
Influencers have accounts and a dashboard; the platform owner has a separate admin console. All seven phases in `doc/` are
implemented (`doc/00-overview.md` is the map). The front end is a React single-page app in `web/`; Next.js is the backend.

## Commands

```
npm run dev              # ONE command, one origin: Vite watch build of web/ + next dev on http://localhost:3000 (no worker)
npm run dev:hmr          # Vite hot reload on :5173 in front of next dev on :3000; APP_URL becomes :5173 (see README caveats)
npm run dev:web          # only Vite's dev server (when you start Next yourself; SPA_API_TARGET names that Next)
npm run dev:mock         # local mock of Google and Meta + next dev + web build; no worker (doc/11, README)
npm run build            # vite build -> scripts/spa-postbuild.mjs (checks + copy to public/assets) -> next build
npm start                # next start: Next serves the API, the built assets and the shell from one port
npm run typecheck        # tsc for the root project AND for web/tsconfig.json
npm test                 # tsx --test --experimental-test-module-mocks tests/*.test.ts (see "Tests" for the safe way)
npm run worker           # BullMQ worker + hold expiry (expire-holds is an alias)
npm run db:seed          # demo influencer "demo" with a 1:1 and a group service; npx prisma migrate dev | db:deploy
npm run db:seed:features # demo rows for moderation, portal, reports (after db:seed); -- --remove deletes only them
npm run admin:create -- --email you@x.com --name "You" [--reset | --reset-2fa]   # administrators (no public registration)
npm run dev:logins       # random test logins for demo + two admins -> dev-logins.local.md (gitignored; refuses non-local APP_URL)
npm run data:cleanup-test [-- --apply --confirm=DELETE-TEST-DATA]   # dry run by default: removes test admins/influencers (and their rows) left by tests and QA; see README
npm run data:normalise-timezones [-- --apply --confirm=NORMALISE-TIMEZONES]   # dry run by default: moves availability rules saved in another time zone to IST where that is exact; doc/14
npm run keys:verify | keys:rotate     # TOKEN_ENCRYPTION_KEY rotation, see doc/08 section 9
node scripts/spa-smoke.mjs <url> [--no-db]   # HTTP smoke test of a built server (CI runs it against the Docker image)
```

Setup: `cp .env.example .env`, `npm install`, `npx prisma generate` (client goes to `generated/`, gitignored), migrate, seed.
Node 22.12+ to run, 22.23+ for the tests (`scripts/check-node.mjs` refuses older: `mock.module` changed). There is no lint script. Never print or commit `.env` (it holds real secrets on the owner's machine).

## Architecture

**Two programs, one origin.** `web/` is the browser app (Vite + React 19 + React Router 7 in data mode + TanStack Query 5).
The Next.js app (`app/`, `lib/`, `proxy.ts`) is the backend: JSON API under `app/api/**`, webhooks, metadata routes
(`robots`, `sitemap`, icon, `opengraph-image`), the worker and the shell route. Next renders no page of its own. Read
`doc/12-front-end.md` before touching `web/`; the history is `doc/10-react-migration-*.md` (deviations override the plan).

**Page request path.** `proxy.ts` (the Next 16 "middleware") handles every request: pages get a per-request CSP nonce
(`strict-dynamic`), the cookie-presence redirects (`/dashboard`, `/onboarding` -> `/login?next=`, `/admin` -> `/admin/login?next=`),
and a rewrite to the internal route `app/spa-shell/[[...path]]`, which answers only when the proxy handed it `x-nonce`. That route
reads `web/dist/index.html` (Vite output, cached in production, re-read per request in development), puts the nonce into every tag
and writes the route's `<head>` (`lib/spa/head.ts`: title, robots, canonical, Open Graph, JSON-LD; profile pages get a real 404).
`lib/spa/routes.ts` is the one route table (pure; the proxy, the head and the web router all read it). Hashed JS/CSS/fonts are plain
files in `public/assets` (copied by the post-build step) with `immutable` caching. `/api/*` requests get rate limits
(`lib/rate-limit/policies.ts`, Redis with Postgres fallback) and the CSRF Origin check (webhooks exempt, signature-verified).

**Data for pages = JSON endpoints built from view functions.** A page's data loader lives in `lib/views/<group>-<page>.ts` and
returns an explicit DTO built field by field (never a spread Prisma row, never a token, hash or id the screen does not show). The
endpoint wraps it in `jsonView()` (`private, no-store`, object body, no CORS). Auth: influencer reads `requireApiAuth()`, admin
reads `requireAdminMfa()` (NOT `requireAdminApi`, which lets a password-only session of a 2FA admin through). Every endpoint test
calls `assertNoSecretKeys` (`tests/helpers`). The browser types the answer as `Jsonify<XView>` (Dates become strings). Types that
both sides share live in `lib/` as plain `.ts` (for example `lib/views/dashboard-types.ts`), never in a component file.

**Browser rules.** Browser code may import only the `lib/` modules on the allowlist in `web/vite-server-guard.ts` (pure, no
environment beyond four build-time names) plus `import type` from anything; no `next/*` at all; nothing under `app/`. The guard fails
the build and `tests/spa-guard.test.ts` pins the list. `NEXT_PUBLIC_BRAND_NAME`, `NEXT_PUBLIC_SUPPORT_EMAIL`, `APP_LOCALE`,
`ENABLE_DESIGN_PAGE` are the only environment values the bundle can see; the post-build step fails if any other `process.env` or any
secret-looking value is in `web/dist`. Guards in the SPA (RequireInfluencer, RequireAdmin, ...) are UX; every endpoint enforces.

**Stack details.** Prisma 7 with the `@prisma/adapter-pg` driver adapter: the connection URL is in `prisma.config.ts`, not in
`schema.prisma`; the client is `@/generated/prisma/client`; keep `prisma` and `@prisma/client` on one version. Raw SQL uses the
`@@map` table names (`sessions`, `bookings`, `webhook_events`, ...). `lib/db.ts` pools with `DATABASE_POOL_MAX` (default 10),
statement and connect timeouts. Path aliases: `@/` = repo root, `@web/` = `web/src`.

**Booking and capacity (read `lib/holds.ts` first).** A `Session` is one occurrence of a service at one UTC instant (unique on
`(serviceId, startTime)`), created lazily by `INSERT ... ON CONFLICT DO NOTHING`; many `Booking`s hang off it (a 1:1 is capacity 1).
`createHold` locks the session row (`SELECT ... FOR UPDATE`) and counts seat-occupying bookings. `activeSeatWhere(now)` is the single
definition of "occupies a seat" (`PAID/SCHEDULED/COMPLETED` always; `HELD/PENDING_PAYMENT` only while `holdExpiresAt > now`), so
availability is right even when the worker is down. An influencer is in ONE session at a time across all their services:
`hasOverlappingBusySession` (same file) refuses a time that overlaps another of their sessions with an occupied seat, in `createHold`,
`openSlots`, `rescheduleBooking` and a late capture, under `lockInfluencerSchedule` (a transaction advisory lock per influencer, taken
before any session row lock). Status machine: `HELD -> PENDING_PAYMENT -> PAID -> SCHEDULED -> COMPLETED`;
exits `EXPIRED / CANCELLED / FAILED`. Slots (`lib/slots.ts`): weekly rules, ISO weekday, wall-clock `HH:mm` in the rule's zone
(luxon handles DST), all stored times UTC; the hold endpoint re-validates that the requested start is a generated slot.

**Payments.** `POST /api/checkout` (`lib/checkout.ts`) locks the booking, extends the hold to the payment window, creates ONE
Razorpay order (second call reuses it); the amount always comes from the `Service` row. `POST /api/webhooks/payment` verifies the
HMAC of the raw body, then `handleRazorpayEvent` does the idempotency insert (`webhook_events`), status changes and the BullMQ enqueue
in ONE transaction; any failure rolls back and returns 500 so Razorpay retries. Only the webhook marks a booking paid. Late or
mismatched payments become `Payment.needsRefund`. The worker's payment recovery re-checks old orders (`lib/payment-recovery.ts`).
Refunds `lib/refunds.ts`; influencer payouts and reconciliation `lib/payouts.ts` (admin-approved, four-eyes, see below).

**Google credentials and platform e-mail (doc/15).** There is no platform-wide Google app by default: every influencer saves their OWN OAuth client
(`influencer_google_clients`, secret encrypted with AAD `google-client:<id>`), and `lib/google-credentials.ts` (`getGoogleCredentials`, `GOOGLE_CLIENT_MODE`
own | platform | either) is the one place that picks the client. A grant remembers its client (`google_tokens.client_kind`) and every refresh, health
check and Gmail send passes `{ influencerId, clientKind }` to `GoogleClient.refreshAccessToken`; a missing own client is "reconnect needed", never a
fallback. `EMAIL_PROVIDER=none` is allowed in production: `sendAccountEmail` is then a logged no-op returning `false`, customer e-mail goes only through
the influencer's Gmail, and pages learn `emailEnabled` (a boolean, never the provider name) from the session and view DTOs. Administrators verify
addresses and hand over one-time reset links by hand (`lib/admin/account-help.ts`).

**Worker and queues.** `worker/index.ts` runs hold expiry every 30 s, housekeeping, Google token health, WhatsApp sync, monitoring and
three BullMQ workers (`meetings`, `messages`, `reminders`; ids are deterministic, jobs idempotent and read current state, up to 5
attempts with backoff). Do not start a second worker against a database and Redis that already have one: it takes the other worker's jobs, and a worker pointed at the mock sweeps every influencer's Google and WhatsApp connection and marks them broken.

**Readiness gating (`lib/readiness.ts`).** A booking page takes money only when the influencer has a verified email, a service,
availability and (by default) a working Google connection and verified payout details (`READINESS_REQUIRED`, `READINESS_BYPASS`
outside production). An owner sees a preview with the blockers; a stranger gets a 404. `/api/ready` (database + Redis) is for load
balancers, `/api/health` is liveness only.

**Admin plane (`lib/admin/*`, `/admin`).** Separate accounts, cookie (`__Host-sa_admin`, SameSite=Strict, 12 h absolute), TOTP
two-factor with recovery codes and lockout (`ADMIN_REQUIRE_2FA` defaults on in production), an append-only audit log, payout creation
and four-eyes approval (`PAYOUT_FOUR_EYES`: the creator cannot approve), reconciliation, system health. The MFA gate has three
outcomes (`ok`, `enroll`, `verify`) in `mfaGateStatus`; `GET /api/admin/session` reports it to the SPA.

**Moderation (`lib/admin/moderation.ts`).** Suspend, reinstate and approve an influencer; the change and its audit row are one
transaction, each a conditional update (a repeat is a 409). "Live" has ONE definition, `buildPublicInfluencerWhere` in
`lib/readiness.ts` (mirrored by `evaluateReadiness` / `isLiveBlocker`, kept in step by a test): onboarded, verified e-mail,
`suspendedAt = null`, `approvedAt` set when `READINESS_REQUIRED` contains `approval` (off by default), plus the required connections.
The public page, slots, holds and sitemap all use it, so never re-implement it. A suspension also stops `startCheckout` (it share-locks
the influencer row), approving a booking request and `createPayout`; approving or paying an EXISTING payout needs the explicit
`acknowledgeSuspended` override with a reason (audited). It does not cancel or refund anything, and customers can still cancel but not
reschedule. Finishing onboarding while the gate is off sets `approved_by_email = 'system:gate-off'`.

**Activity log (`lib/activity.ts`, `lib/activity-actions.ts`).** `recordActivity` is BEST EFFORT, unlike `recordAudit`: call it after the
action succeeded and outside its transaction; it never throws, never changes the response, and stops waiting after 2 s. What may be
stored is fixed per action in `ACTIVITY_DETAIL_KEYS` (never customer data, secrets or full account numbers); a new action needs an entry in
`ACTIVITY_ACTIONS`, `ACTIVITY_DETAIL_KEYS` and `summariseActivity`. Low-value repeats merge into one row with a count
(`COALESCED_ACTIONS`, 15 min, same IP); security and money entries never merge. Rows older than 365 days are deleted by
`sweepExpiredAuthRows` (worker housekeeping). The admin audit log (`recordAudit`) stays awaited before money moves.

**Admin money operations (`lib/admin/{exports,refund,cancel,reports}.ts`).** Exports build each column from an explicit `select`,
neutralise formulas (`csvCell`), cap at 20,000 rows (a 400, never truncation), and write the `admin.export` audit row BEFORE returning
the file. `adminRefundPayment` never takes an amount from the client: it refunds what is left of the payment (the page's
`expectedRemainingMinor` is only a check), awaits the `payment.refund_requested` audit row before calling Razorpay, and goes through
`refundPayment` (`blockPendingPayout`, `expectedRemainingMinor` options) so the claim and Razorpay's deterministic receipt settle races.
`adminCancelBooking` reuses `cancelBooking` with `byPlatform: true`. Reports are read-only aggregate SQL (nine queries, one at a time) that
must agree with `lib/payouts.ts`; Gross is dated by `payments.created_at` (the schema has no capture time).

**Admin money ledger (`lib/admin/money.ts`, `lib/views/admin-money.ts`, `/admin/money`, `GET /api/admin/money`).** One newest-first list of every money
movement, read by ONE `UNION ALL` of three explicit selects (`branch`) with `LIMIT/OFFSET` (50 a page) and a count query; nothing is loaded unbounded.
Movements and their dates are the Reports dates, on purpose, so the rows of a range add up to the Reports figures: a payment IN (CAPTURED or REFUNDED)
by `payments.created_at` (checkout start; there is no capture time), a refund OUT by `refunds.created_at` (a FAILED one is listed and is in no total),
a payout OUT (PAID) by `paid_at`. PENDING payouts are not movements: `scheduledPayouts` lists them apart, whatever the dates. Day bounds come from
`istStart` of `lib/admin/reports.ts`, never a second copy. The cards are `moneyTotals` = `rangeFigures` + `balanceFigures` (do not re-implement the maths;
both take an optional `ReportScope { influencerId }` that adds `AND ... IN (the influencer's bookings)` or `AND influencer_id = ...` and changes nothing
without it); the `type` tab narrows the rows, never the cards. The DTO masks the Razorpay payment id and the UTR to `****1234` (`maskTail`); the CSV kind `money`
(`exportMoney`, oldest first, audit detail also carries `type` and `influencerId`) writes them in full like the payments and payouts exports. An influencer id that
is not shaped like an id is a 400 (never silently ignored); a well-formed unknown one is an empty page. `influencerPayoutSummary` sums paid and pending payouts in SQL
(it used to read only the 50 newest). The view function runs its queries in three stages, at most four connections at a time. Rate rule `admin-money-ledger`.

**Customer portal (`lib/customer-portal.ts`, `lib/receipts.ts`, `/bookings`).** Customers have no accounts: a random token e-mailed to
the booking address, valid one hour, stored as SHA-256 in `customer_access_tokens`, opens that address's bookings, a JSON export and
erasure (`eraseCustomerData`, with `isKeptBooking` as the one "kept" rule). It is NOT the signed manage/pay token of `lib/signing.ts`.
`requestPortalLink` runs detached and answers the same 202 for every address (the per-address limit and
`CUSTOMER_PORTAL_MAIL_CAP_PER_HOUR` are silent). Receipts are pure (`buildReceipt`) and are not tax invoices. Expired tokens are swept
by `sweepExpiredCustomerAccess`.

**Reminder repair (`worker/reminder-reconcile.ts`, `lib/reminders.ts`).** Every 10 minutes and 60 s after worker start, re-creates missing
reminder jobs for `SCHEDULED` bookings in the next 25 h (`reconcileReminders`, `ensureReminder` in `lib/queue.ts`); a late reminder job is
skipped by `staleReminderReason` and writes no `Message` row, which the repair relies on.

**Booking-request messages (`lib/message-kinds.ts`, `lib/request-messages.ts`, `lib/request-message-context.ts`, `doc/16-request-whatsapp-flow.md`).**
For services that need approval the customer also gets WhatsApp (linked number first, official template, SMS) at each step, besides the
unchanged e-mails: `request-received` (hold route), `request-approved` with the payment link (`approveRequest`), `request-declined`
(`declineRequest`), `request-expired` (the worker's `expireStaleHoldsAndNotify`), then the usual `booking-confirmation` after payment.
`messageMayBeSent` in `lib/message-kinds.ts` is the ONE table of "which booking states may each message be sent in", read by
`lib/messaging.ts` and by the linked number's `booking-guard.ts`. A job is `{ bookingId, template }` only: the payment link (a bearer link)
is built when the message is sent, never stored or logged, and `redactBearerLinks` takes it (and the manage link) out of any stored, logged or thrown error, in its plain, JSON-escaped and percent-encoded spellings. Queueing is best
effort and happens after the database change committed; tests must not reach a real queue (`delete process.env.REDIS_URL` or pass the
`deps`/`enqueue` seam). Nothing is queued unless `customerMessageRoute` (`lib/message-route.ts`) finds a route to the customer (linked number, official connection with the template approved, SMS set up for it); the decision answer has `messageRoute` and `messageQueued`.

**Provider simulator (doc/11).** `scripts/mock-providers` fakes Google (OAuth, Calendar/Meet, Gmail) and Meta (Graph, templates,
Embedded Signup). `MOCK_PROVIDERS_URL` is honoured only in development with a local `APP_URL` (`lib/provider-endpoints.ts` decides
every host); production refuses to start with it. It proves the app's side only.

**Optional QR-code WhatsApp (`lib/whatsapp-web/*`, `worker/whatsapp-web*.ts`, `doc/14-whatsapp-qr-deviations.md`).** UNOFFICIAL and off
unless `WHATSAPP_QR_ENABLED=true` on the web app AND the worker (the official Cloud API stays the default and the fallback; SMS and e-mail
are never reduced). An influencer links their own number as a linked device by scanning a QR code. `WhatsAppWebTransport`
(`transport.ts`) is the one interface; `baileys-transport.ts` is the only file that knows the library (reached by a dynamic `import()` from
`worker/whatsapp-web.ts` and nowhere else) and `fake-transport.ts` is the `WHATSAPP_QR_FAKE` simulator (development only, refused in
production). ONLY the single worker opens sockets (`worker/whatsapp-web-manager.ts`; a second worker would log the first out); the web
side writes the intent through `lib/whatsapp-web/commands.ts` and reads the status (Postgres) and the QR payload (Redis, about a minute,
never logged or stored in Postgres). The login of a device is one AES-256-GCM blob per influencer (`auth-state.ts`, AAD
`wa-web:<influencerId>`, in the key-rotation list); it never reaches a log, a DTO or the browser. `lib/messaging.ts` tries the linked number
FIRST (`tryWhatsAppWeb`, one send at a time per number through `send-queue.ts`: gap, daily cap, booking guard, breaker), and any refusal
falls through to the official connection, then SMS, then e-mail; a send is never repeated (the `in-flight` marker on its `Message` row).
Browser rules: only `import type` from `lib/whatsapp-web/types.ts` and `api-types.ts`; the Vite guard forbids the WhatsApp library, `uqr`
and `libsignal`. The QR arrives as a server-rendered SVG string and is shown ONLY through `<img src="data:...">` after `safeQrImageSrc`
(`web/src/lib/whatsapp-web-ui.ts`), never as markup. Screens: `WhatsAppModePicker` and `WhatsAppQrLink` in Settings, and
`InfluencerWhatsAppWebPanel` on the admin Influencer page (`doc/12-front-end.md`). Keep the copy honest: no sentence may promise the
number cannot be banned or hint at avoiding detection (a test reads the sources for that).

**Key rotation.** Secrets at rest (Google refresh tokens, payout account numbers, WhatsApp tokens, TOTP secrets) are encrypted with
`TOKEN_ENCRYPTION_KEY` (`lib/crypto.ts`). Rotation uses `TOKEN_ENCRYPTION_KEY_PREVIOUS` plus `keys:verify` / `keys:rotate`
(`lib/key-rotation*.ts`, dry run by default, `--apply` needs the new key's fingerprint). `APP_SECRET` (signed links only) rotates with
`APP_SECRET_PREVIOUS`, which `verifyToken` accepts but never signs with. Procedure: `doc/08-deployment.md`.

**Start-up validation (`lib/env.ts`, `instrumentation.ts`).** `KNOWN_ENV_VARS` is kept in step with `.env.example` by a test. In
production a bad configuration exits 1 with one secret-free message; the web process also refuses to start without
`web/dist/index.html` or with `HOSTNAME=127.0.0.1`/`::1` (warnings on Vercel-like platforms). `ALLOW_INSECURE_LOCAL_RUN=true` lets the
production build run on `http://localhost` for local checks.

## Tests

Node's built-in runner through tsx, on Node 22.23 or newer (older 22.x breaks `mock.module` across tests in one file). Files in `tests/*.test.ts`; several need the database, and skip themselves when `DATABASE_URL`
is unset (they create timestamped rows and delete them in `after`). The database is a small shared Postgres: run files ONE AT A TIME:

```
DATABASE_POOL_MAX=2 npx tsx --test --experimental-test-module-mocks --test-concurrency=1 tests/<file>.test.ts
npx tsx --test --experimental-test-module-mocks --test-name-pattern="exactly one" tests/holds.test.ts   # one test by name
```

`--experimental-test-module-mocks` is required (tests replace `next/headers` and, for server-rendered views, `@web/lib/navigate`
with `mock.module`, which only affects modules imported afterwards: import inside `before`). The "concurrent holds" test needs a pool
bigger than 2 and fails on a small one. A DB file can time out once on the shared database; retry before debugging. A test that can
reach `getHealthReport()` must `delete process.env.REDIS_URL` in `before`, otherwise BullMQ keeps the process alive. View tests render
with `react-dom/server`; `tests/helpers/fake-navigate.ts` stands in for the router hooks, `AppLink` renders a plain `<a>` without a
router. Use `RATE_LIMIT_STORE=memory` when a test or server run should not touch Redis.

## Conventions and pitfalls

- INDIA ONLY (doc/14-india-localisation.md). `lib/india.ts` is the one pure, browser-safe source: `APP_TIME_ZONE` (Asia/Kolkata), `APP_CURRENCY` (INR), the IST formatters (`formatDateTime` -> "Sat, 25 Oct 2026, 6:30 PM IST"), IST day/month arithmetic and the Indian mobile parser. Never format a date for a user with `Intl`/`toLocale*`, or with `getUTC*` arithmetic of your own (that arithmetic lives only inside `lib/india.ts`): use its helpers. The UI has no time zone or currency picker; the server accepts a client `timezone`/`tz` only to replace it with Asia/Kolkata (a non-zone is a 400), except on the availability routes, which refuse any zone that is not Asia/Kolkata/Calcutta (their HH:mm would move); blocked days are matched on IST dates; services are INR only; phones are Indian mobiles (`toE164` -> `+91XXXXXXXXXX`). Reports, earnings and exports bucket by IST days and months (`AT TIME ZONE 'Asia/Kolkata'`; midnight IST is 18:30 UTC). `lib/slots.ts` still honours the zone stored on an OLD availability rule; `scripts/normalise-timezones.ts` converts the exact ones.
- Money is integer minor units (paise). All stored times are UTC; display is IST; `APP_LOCALE` (default en-IN) only governs number and money formats.
- Never trust a client time, amount or id: slots are re-validated, prices come from the `Service` row, ids are checked for shape
  (`isEntityId`), bodies go through `readJson` (rejects NUL bytes; the proxy returns 400 for broken percent escapes and `%00`).
- Jobs are idempotent with deterministic ids and read current state when they run (`doc/05`).
- Security properties to keep: Origin/CSRF check, CSP nonce, rate limits, DTO field lists, escaping of anything written into the
  shell head (`escapeHtml`), token handling (logs never contain tokens; `loggablePath` redacts), the Vite guard, `Referrer-Policy:
  no-referrer` on token pages, `Cache-Control: private, no-store` on `/api/dashboard|admin|auth|bookings|customer`.
- Windows + Git Bash: `.gitattributes` keeps Dockerfiles LF; other files are CRLF in the working tree (autocrlf). `git mv` for moves.
- Turbopack (`next dev`, `next build`) cannot use a `node_modules` junction that points outside the project ("Symlink node_modules could
  not be resolved"): a worktree needs a real copy of `node_modules` (`robocopy`), then `npx prisma generate`.
- Browsers share cookies between ports of one host. The proxy's Origin check accepts a POST whose `Origin` equals the request's own
  origin or `APP_URL` (`allowedOrigins`, `lib/auth/csrf.ts`); a mismatched `APP_URL` breaks e-mailed links and the Google/Razorpay returns,
  not POSTs. Next rewrites `127.x.x.x` and `::1` request URLs to `localhost`, so a browser at `http://127.0.0.7:<port>` matches neither
  unless `APP_URL` is exactly that origin: use `http://localhost:<port>`.
- Nothing is frozen any more (the migration's freeze rule on `web/src/lib`, `lib/spa`, `proxy.ts`... is lifted). Tests that pin a
  behaviour (the guard allowlist, the DTO key sets, the proxy rules) are changed deliberately, with the reason in the commit.
- After pulling a change that deletes or moves pages (the migration's cleanup did), `npm run typecheck` can fail inside `.next/types`
  (generated route types of pages that no longer exist). Stop `next dev`, delete the `.next` folder (or run `npm run build`) and run it again.
- Background processes are not killed when the shell that started them is: `taskkill` or Task Manager for a stray `next dev` or
  worker, and never run two workers against one database and Redis (a second worker double-processes jobs).
- Lead times that are not code: WhatsApp template approval, DLT registration and Google OAuth verification take days to weeks.

## Where to read next

`README.md` (run, integrations, admin, readiness, payment recovery), `doc/08-deployment.md` (Docker, env table, rollouts, key
rotation, backups), `doc/12-front-end.md` (the web app), `doc/07-...` (accounts, UI, integrations), `doc/11-provider-simulator.md`.
The six marketplace features (moderation, admin money operations, activity log, customer portal, reminder repair, reports) are
recorded, with their deviations, in `doc/13-product-build-plan.md`, `doc/13-marketplace-essentials.md` and `doc/13-deviations.md`.
The request-flow WhatsApp messages are in `doc/16-request-whatsapp-flow.md`.
