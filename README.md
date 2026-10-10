# Session Automation

Paid 1:1 and small-group sessions for creators: the customer picks a time and pays with Razorpay, a Google Meet link
is created on the creator's calendar, and the link goes out on WhatsApp (SMS fallback) and email, with reminders.

All seven phases in `doc/` are implemented: booking and slots, Razorpay payments, Google Meet links, WhatsApp/SMS
messaging, reminders and retries, groups and dashboard, and Phase 7 (accounts, integrations, landing page, redesigned
UI, rate limiting). See `doc/07-product-ui-auth-and-integrations.md` section 11 for what Phase 7 contains.

## Run locally
1. Start Postgres and Redis, copy `.env.example` to `.env` and set at least `DATABASE_URL`, `REDIS_URL`, `APP_URL`,
   `APP_SECRET` and `TOKEN_ENCRYPTION_KEY` (`openssl rand -base64 32` for the last two).
2. `npm install`, then `npx prisma generate`
3. `npx prisma migrate dev` then `npm run db:seed`
4. `npm run dev` and open http://localhost:3000 (landing) or http://localhost:3000/demo (demo booking page)
5. Log in at `/login` as `demo@example.com` / `demo-sessions-2026` (seeded, development only), or register a new
   account at `/register`. With `EMAIL_PROVIDER=log`, verification and reset links are printed in the server console.
6. `npm run worker` in a second terminal: hold expiry, `create-meeting`, `send-message` and reminders, plus cleanup every
   10 minutes of expired sessions, tokens and rate-limit buckets.
7. `npm run typecheck` and `npm test` (database tests need a migrated Postgres at `DATABASE_URL`; the rest are pure).
   For local messaging without provider accounts set `MESSAGING_DRY_RUN=true`.

CI (`.github/workflows/ci.yml`) runs install, `prisma generate`, migrations, typecheck, tests, `next build` and an
advisory `npm audit` against Postgres and Redis service containers, and builds the Docker images with a start-up smoke test.

## Accounts
Influencers have accounts (email + password, verified email, password reset). Customers stay guests and manage their
own booking through the signed `/manage/<token>` link in their confirmation email. Sessions are opaque, HttpOnly
cookies with a rolling 30-day expiry; refunds, disconnecting Google, erasing customer data and logging out everywhere
ask for the password again if it was last entered more than 8 hours ago. Passwords are hashed with scrypt.

## Rate limiting
Every `/api/*` route is rate limited in `proxy.ts` (global per-IP ceiling + a per-route rule) and sensitive handlers
add per-email/per-booking limits. All limits live in `lib/rate-limit/policies.ts`.
- Storage: Redis (atomic Lua sliding window). If Redis is missing or down, limits fall back to the Postgres table
  `rate_limit_buckets`, so they keep working on the database alone. `RATE_LIMIT_STORE` forces one store.
- Responses: `429` with `Retry-After` and `RateLimit-Limit/Remaining/Reset` headers.
- Production: set `CLIENT_IP_HEADER` to the header your platform sets with the real client IP. Without it the
  right-most `X-Forwarded-For` entry is used; client-settable headers are never trusted by default.
- Database protection: connection pool size, wait timeout and per-statement timeout (`DATABASE_*` in `.env.example`).

## Integrations
| Integration | Where | Configure |
|---|---|---|
| Razorpay payments + refunds | `lib/payments.ts`, `lib/refunds.ts`, `/api/webhooks/payment` | `RAZORPAY_*`; webhook events `payment.captured`, `payment.failed`, `order.paid`, `refund.processed`, `refund.failed` |
| Google Calendar / Meet | `lib/google.ts`, `lib/meeting.ts`, Settings → Google Calendar | `GOOGLE_*`, see below |
| WhatsApp Cloud API | `lib/whatsapp.ts`, `lib/message-templates.ts` | `WHATSAPP_*`; template names and variables in `lib/message-templates.ts` |
| SMS fallback | `lib/sms.ts` | `SMS_PROVIDER=msg91` (DLT flows `MSG91_TEMPLATE_*`) or `twilio` |
| Email | `lib/email.ts`, `lib/email/*` | `EMAIL_PROVIDER=resend` or `postmark`, `EMAIL_FROM`; set up SPF and DKIM |

### Google Meet setup
Meet links are created on the **influencer's own** Google Calendar (a service account cannot create Meet links for
personal Gmail).
1. In Google Cloud Console: create a project, enable the **Google Calendar API**, configure the OAuth consent screen,
   and create an **OAuth client ID** (type *Web application*). Add `GOOGLE_REDIRECT_URI`
   (e.g. `http://localhost:3000/api/google/callback`) as an authorised redirect URI. While the consent screen is in
   *Testing*, add the influencer's Gmail as a test user; refresh tokens of Testing apps expire after 7 days, so publish
   the app (and complete verification for `calendar.events`) before going live.
2. Fill in `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI`.
3. The influencer clicks **Connect Google Calendar** in onboarding or Settings. The dashboard then shows
   "Connected as <email>", or "Reconnect needed" with Google's reason if the grant is revoked; paid bookings wait as
   `PAID` and are re-queued automatically after reconnecting.

## Design system
Tokens: `app/styles/tokens.css`. Components: `components/ui/`. Every component and state is shown at `/design`
(development only, or `ENABLE_DESIGN_PAGE=true`).

## Admin console
A separate plane for the platform owner at `/admin` (own accounts, own cookie, 12-hour sessions, never reachable
with an influencer login). Create an administrator from the command line (there is no public registration):

```
npm run admin:create -- --email you@company.com --name "Your Name"
```

It prints a generated password once (or set `ADMIN_PASSWORD`); add `--reset` to change an existing admin's password.
The console shows platform totals, every influencer with their connection status, every payment (with filters for
"needs refund" and "captured but booking not paid"), bookings, and an append-only audit log of admin activity.

## Payout details
Influencers add where to be paid under **Dashboard > Payouts** (bank account + IFSC, or UPI). Saving needs a recent
password entry, stores the account number / UPI id AES-256-GCM encrypted (`TOKEN_ENCRYPTION_KEY`), shows only a masked
value afterwards, and emails the influencer a security notice. New or changed details are `PENDING_REVIEW` until an
administrator verifies them (admin console > influencer > Payout details). Revealing the full number is audit-logged.

## Reconciliation and influencer payouts
Customers pay the platform's Razorpay account; the owner pays influencers by hand. In the admin console:

1. **Payments > To reconcile > Reconcile with Razorpay.** Each payment is fetched from Razorpay and must match
   (payment id, order, amount, currency, captured). Only reconciled payments are payable.
2. A payment becomes payable once it is reconciled, the session has finished plus `PAYOUT_HOLD_DAYS` (default 2), the
   booking is `SCHEDULED`/`COMPLETED`, and no refund is in flight.
3. **Influencers > (influencer) > Earnings and payouts > Create payout.** Needs *verified* payout details. It locks the
   payable payments into a `PENDING` payout (a row lock stops two admins paying the same money twice):
   `payout = (paid - refunded) - platform fee`. The fee is `PLATFORM_FEE_BPS` by default, overridable per influencer, and
   is floored to a whole paisa.
4. A second administrator **approves** the payout (see below). Reveal the account (audit-logged), send the money yourself,
   then **Payouts > Mark as paid** with the bank reference (UTR). The influencer is emailed. **Cancel** releases the
   payments. A refund made after a payout was paid is flagged "refunded since, to recover".

## Admin two-factor and payout approval
Revealing bank details and moving money used to need only an admin password. Now:

- **Two-factor sign-in (TOTP, RFC 6238; authenticator app, no extra dependency).** Under **Admin > Security** an
  administrator adds a key (or the `otpauth://` link) to Google Authenticator, Authy, 1Password etc., confirms one code,
  and is shown 10 single-use **recovery codes** once (they are stored only as SHA-256). From then on sign-in is two
  steps: email + password gives a 5-minute signed token and no session; the session is created only after a valid
  6-digit code or a recovery code. A code works once (the last accepted 30-second step is stored, so a code that was
  seen cannot be replayed), +-1 step of clock drift is tolerated, and the second step is rate limited per admin and IP.
  The secret is stored AES-256-GCM encrypted (`TOKEN_ENCRYPTION_KEY`).
- **A session cookie alone can never change two-factor.** Setting it up, confirming it, regenerating recovery codes and
  turning it off all need the administrator's **current password** (and, except for the first step of setup, a valid
  code). Enabling signs out the admin's other sessions, and so does turning it off, so a leftover session cannot race to
  enrol its own authenticator. The admin is **emailed** and the action audited whenever 2FA is enabled or disabled or
  recovery codes are regenerated. The administrator list on the Security page is only shown to a session that has
  passed what it must (enrolled and verified when 2FA is required).
- **Code guessing is bounded without relying on the rate limiter.** Every code attempt (login second step and Security
  page together) is counted in the database before it is checked; 10 in a row lock authenticator codes for 15 minutes
  (4x longer each time it repeats, at most 24 h), whatever IP addresses the guesses come from and even if Redis and the
  rate-limit table are down. A success resets it. The admin is emailed, the lock is audited
  (`admin.mfa_locked`) and reported to the operator channel (`ERROR_WEBHOOK_URL`). A locked account still accepts its
  password plus a **recovery code** (long random strings cannot be guessed), so someone who only knows the password cannot
  shut the real admin out. The admin MFA and password re-entry rate limits also **fail closed**: if no rate-limit store is
  reachable they answer 503 instead of allowing unlimited attempts (other routes still fail open), and the Security
  page is additionally capped at 30 attempts per hour per admin across all IPs.
- **`ADMIN_REQUIRE_2FA`** (default `true` in production, `false` elsewhere). When on, an administrator who has not enrolled
  is redirected to `/admin/security` from every other admin page, and every admin API except the enrolment one answers
  `403 { error, mfaRequired: true }`. A password-only session of an admin who already has 2FA (one that predates the
  enrolment) is sent back to sign in with a code, and a password-only session is never created for such an admin.
  **Break-glass:** if an admin loses both the authenticator and the recovery codes (or you need to override a lock), the
  owner runs `npm run admin:create -- --email them@company.com --reset-2fa` on the server: it turns 2FA off, clears the
  lock, ends all their sessions and writes an audit entry (`admin.2fa_reset_cli`).
- **Sensitive actions need an MFA-verified session** whenever 2FA is required or enabled: reveal / verify / reject payout
  details, reconcile and undo, create, approve, pay and cancel payouts, change a fee. A password-only session (for
  example one that predates enrolment) gets `403 mfaRequired` and has to sign in again.
- **`PAYOUT_FOUR_EYES`** (default `true` in production, `false` elsewhere): a payout can only be marked as paid after a
  second administrator has **approved** it, and the approver must not be the administrator who created it (enforced in
  `lib/payouts.ts`, not just hidden in the UI). The payout list shows "Awaiting approval" and an Approve button for
  the other administrator; Mark as paid stays disabled until then. `PAYOUT_FOUR_EYES_MIN_MINOR` (default `0` = always)
  limits approval to smaller payouts: it is in the **minor units of each payout's own currency** (paise for INR, cents
  for USD; there is no conversion, so one number applies to every currency) and it is compared with the payout's net
  amount **plus the same influencer's other unapproved payouts in that currency from the last 24 hours**, so splitting one
  transfer into several below the threshold does not avoid approval. With four-eyes on and only one active
  administrator the console says so: create a second one (`npm run admin:create`) or set `PAYOUT_FOUR_EYES=false`.
  Approvals are audit-logged as `payout.approved`.
- **Security page** also lists every administrator (2FA on or off, last sign-in, disabled).

## Custom services
Every service is influencer-defined: title, length, price, 1:1 or group (any seat count), cancellation policy, plus:
- **Questions for the customer** (up to 8: short answer, long answer or choose-one; required or optional). Asked on the
  booking page, validated on the server, stored on the booking with the question text copied in, shown in the dashboard
  booking drawer, and erased with the customer's data. Answers are never put in the shared Calendar event.
- **Booking rules**: earliest a customer can book (minimum notice) and furthest ahead. Applied to the slot list, the hold
  endpoint and customer rescheduling; the owner previewing their own page is not limited.
- **What to prepare**: shown before booking, on the confirmation page and in the confirmation email.

## Booking approval
A service can be set to **I approve each booking request**. The customer picks a time and sends a request instead of
paying; the booking is `REQUESTED` and holds the seat for up to 48 hours. The influencer sees it under
**Sessions > Requests** (and in the needs-attention list) and approves or declines:

- **Approve** -> `HELD` with a payment deadline (24 hours, never later than 15 minutes before the session). The customer
  is emailed a signed link to `/pay/<token>` where they pay through the normal Razorpay checkout.
- **Decline** -> `CANCELLED`, the customer is emailed the reason. Nothing was ever charged, so there is nothing to refund.
- An unanswered request expires with the normal expiry job and the seat is released.

## Sending customer email from the influencer's Gmail
The Google connection asks for Calendar (Meet links) and, unless `GOOGLE_REQUEST_GMAIL_SEND=false`, permission to send
email (`gmail.send`). Customer-facing emails (confirmation, receipt, reschedule, cancellation, booking request /
approval / decline) then go out from the influencer's own Gmail address. If they decline that permission, or Gmail
fails or is rate limited, the platform's email provider sends instead with the influencer as Reply-To, so an email is
never lost. A dead Google grant flags the influencer to reconnect. Account emails (verification, password reset, payout
notices, alerts) always come from the platform. `gmail.send` is a restricted Google scope: it works for test users while
the consent screen is in Testing, and needs Google verification before general use.

## Influencer WhatsApp numbers
Customers are messaged from the **influencer's own WhatsApp Business number**. In **Settings > WhatsApp** the influencer
connects it either with Meta **Embedded Signup** (needs `META_APP_ID`, `META_APP_SECRET`, `META_ES_CONFIG_ID` and a Meta app
approved as a Tech Provider) or by entering their WhatsApp Business Account id, phone number id and a permanent system-user
token. Credentials are verified against Meta before saving (the number must belong to the account) and the token is stored
AES-256-GCM encrypted and never shown again.

On connect we submit our five message templates (booking-confirmation, reminder-24h, reminder-15m, reschedule, cancellation)
to the influencer's account for approval and keep their status current from Meta's template webhook and a Refresh button;
the dashboard shows which are approved. Until a template is approved, or if there is no healthy connection, the message goes
by SMS. A token Meta rejects flags the connection once and alerts the influencer. Set `WHATSAPP_PLATFORM_FALLBACK=true` only
for testing with the platform's own number. Embedded Signup could not be exercised without an approved Meta app: the manual
connect path is verified against Meta's real Graph API.

## Go-live readiness
A booking page only takes bookings (and money) once the influencer has what the product needs. The same rules drive the
dashboard checklist, the public page and the booking/slot APIs (`lib/readiness.ts`):

- **Always required:** verified email, one active service, weekly hours.
- **Required by default:** Google Calendar (Meet links are created on it) and payout details (added; verification happens
  before the first payout).
- **Recommended, not blocking:** their own WhatsApp number and sending email from their Gmail. Without them customers get SMS
  and the platform's email address.

Change what blocks with `READINESS_REQUIRED` (comma list of `google,gmail,whatsapp,payout`). Until a page is live only its
owner can open it, as a preview that lists what is missing; everyone else gets a 404 and holds are refused. The influencer
overview shows a go-live checklist, the onboarding wizard has WhatsApp and payout steps, and the admin console shows
Live / Not live (and what each influencer is waiting for). A dead Google grant takes a page offline until they reconnect.

For local development set `READINESS_BYPASS=true` (ignored in production) so the seeded demo page is bookable without
connecting Google. The seed also adds verified demo payout details.

## Payment recovery and monitoring
Only Razorpay's webhook marks a booking paid, so a lost webhook (tunnel down, outage, wrong secret) would leave a customer
who really paid on a booking that expires. Two things in the worker (`npm run worker`) now cover that, plus a health page.

**Missed-webhook recovery** (`lib/payment-recovery.ts`, every 2 minutes). It selects payments still `CREATED` whose order is
3 minutes to 7 days old and whose booking is `HELD`, `PENDING_PAYMENT` or `EXPIRED`, at most 50 per run, never-checked first and then
longest-unchecked (`payments.recovery_checked_at`). Each order is looked up with `GET /orders/{id}/payments`
(`fetchOrderPayments` in `lib/payments.ts`). Orders are re-checked every run in their first hour, every 30 minutes for the rest of the
first day, every 6 hours after that, so abandoned carts are not fetched over and over. If Razorpay reports a `captured` payment,
`applyCapturedPayment` (`lib/payment-capture.ts`) applies it. The webhook calls the very same function, so the rules are identical:
amount mismatch -> flagged `needsRefund` and the booking `FAILED`; session already started -> flagged `needsRefund` and `FAILED` (a capture
that surfaces days late is never booked); hold expired and slot still free -> paid; slot taken -> flagged `needsRefund` and `FAILED`;
otherwise `PAID` and one `create-meeting` job. It is idempotent with the webhook arriving before, after or at the
same moment (the booking row lock plus a re-read of the payment under it; recovery also records `recovery:<razorpayPaymentId>` in
`webhook_events`). Queueing the meeting job is bounded to 5 s inside that transaction (the BullMQ connection waits forever while Redis is
down): on timeout everything rolls back, the booking is not marked paid without a job, `payments.recovery_error` records why and the next
run retries; the queue helper used is `requeueCreateMeeting`, which first clears a finished job with the same id (BullMQ would ignore the new
one). Every recovered or flagged payment is written to the admin audit log as `system:payment-recovery`
(`payment.recovered` / `payment.recovered_needs_refund`) in the same transaction, and also sent to `ERROR_WEBHOOK_URL`, because finding one
means the webhook did not arrive. A payment Razorpay captured under 3 minutes ago is left for its webhook. Razorpay being unreachable is
logged and never thrown; after 3 failures in a row a run stops. A 400/404 for an unknown order (for example test-mode orders after switching
to live keys) counts as an answered lookup, not a failure. The job is skipped when `REDIS_URL` or the Razorpay keys are missing, or with
`PAYMENT_RECOVERY_ENABLED=false`.

**Heartbeat and monitor** (`lib/health.ts`, `lib/health-alerts.ts`, `worker/monitoring.ts`). The worker writes a heartbeat to Redis every
30 s (an in-memory fallback when Redis is down) and every 5 minutes measures: payments Razorpay has captured that recovery could not apply
(older than 10 min), whether recovery's lookups keep failing, paid bookings without a Meet link for 15 min, upcoming bookings whose
confirmation failed on every channel, BullMQ counts (waiting, active, failed, delayed) for `meetings`, `messages` and `reminders`, unpaid
holds that expired more than 5 min ago and are still open, the heartbeat age (stale after 180 s), whether Redis itself answers (an outage is
critical, because every other Redis-based check goes "unknown" during one) and whether the recovery loop's last-run timestamp is older than
6 minutes (3 x its interval: a stuck loop under a live worker). The evaluation is pure
(`lib/health-eval.ts`); thresholds are the `HEALTH_*` variables in `.env.example`. Recovery, monitor and heartbeat each run on their own timer
and never overlap themselves. The monitor also repairs: whenever a paid booking has had no Meet link for 15 minutes it re-queues
`create-meeting` for such bookings (`requeuePendingMeetings`, which clears a finished job that would block the new one), so a lost job fixes
itself instead of only alerting.

**Alerts.** A condition that crosses its threshold is sent to `ERROR_WEBHOOK_URL` and emailed to `ADMIN_ALERT_EMAILS` (comma list, optional).
The same alert key is sent at most once per hour (an atomic Redis `SET NX EX`, in-memory when Redis is down), and one "recovered" note is sent
when it clears (only the run that actually clears the marker sends it, so overlapping runs send one). If every email for an alert fails,
its dedupe key is released so the next run retries. A condition that cannot be measured never raises or clears an alert, except that Redis
being configured but unreachable is itself a critical alert. The worker cannot report its own death, so
`GET /api/health/watchdog` is the watchdog (`GET /api/health` stays a plain liveness probe for containers): point an uptime monitor at it (every 1 to 5 minutes). It answers `503` when the heartbeat is stale or
Redis is configured but not answering (after one retry) and raises the same alerts; without such a poller a dead worker only shows on the admin page.

**Admin > System health** (`/admin/health`, with a count badge in the sidebar and on the overview): worker status and last heartbeat ("Worker is
not running" in red when stale), every monitored condition with its count, queue counts, the recently recovered payments (from the audit
log) and the failed jobs with their reasons. Failed jobs are kept (`removeOnFail: false`) until someone removes them.

## Deployment
Full guide: **`doc/08-deployment.md`** (architecture, hosting, every environment variable, release steps, webhook URLs,
backups and restore drill, key rotation, Razorpay and Google go-live checklists, alerts, incident runbook).

- **Containers:** `Dockerfile` (web, plus a `tools` target for migrations and one-off scripts), `Dockerfile.worker`, and
  `docker-compose.yml` for a local production-like run (`docker compose up --build`: web, worker, Postgres, Redis and a
  one-shot `prisma migrate deploy`). The worker is a long-running process and cannot run on Vercel functions. No secret is
  baked into an image.
- **Health:** `GET /api/health` (liveness, no dependencies) and `GET /api/ready` (readiness: Postgres, and Redis when
  `REDIS_URL` is set; 503 names the failing check). Both bypass the per-IP rate limit.
- **Start-up validation:** `lib/env.ts` checks the environment when the web app and the worker start. With
  `NODE_ENV=production` it refuses to start on a bad configuration (http `APP_URL`, short `APP_SECRET`, missing Redis or
  Razorpay keys, `EMAIL_PROVIDER=log`, `MESSAGING_DRY_RUN`, `WHATSAPP_DISABLED`, `READINESS_BYPASS`, `RATE_LIMIT_ENABLED=false`,
  or a value with leading/trailing whitespace) and lists every problem at once without printing a value. In development it
  only warns. Upgrading? `APP_SECRET` must now be 32+ characters in production: see "Upgrade notes" in the guide.
- **Encryption key rotation:** `npm run keys:rotate` re-encrypts Google tokens, payout details and WhatsApp tokens onto
  `TOKEN_ENCRYPTION_KEY` from `TOKEN_ENCRYPTION_KEY_PREVIOUS` (the services' own variables; run it with their environment).
  Dry run by default; `-- --apply --confirm-new-fingerprint=<8 hex>` writes, and refuses unless the fingerprint matches the one
  your services log at start-up. `npm run keys:verify` (decrypt-only) checks every value reads with the current key. The app
  reads with the current key, then the previous one, so a rolling deploy works. Back up the key: without it those values are
  unreadable.
- **Dependencies:** Node 22+ (`.nvmrc`); Dependabot and an advisory `npm audit` step in CI; see the audit notes in the guide.
