# Session Automation

Paid 1:1 and small-group sessions for creators: the customer picks a time and pays with Razorpay, a Google Meet link
is created on the creator's calendar, and the link goes out on WhatsApp (SMS fallback) and email, with reminders.

All seven phases in `doc/` are implemented: booking and slots, Razorpay payments, Google Meet links, WhatsApp/SMS
messaging, reminders and retries, groups and dashboard, and Phase 7 (accounts, integrations, landing page, redesigned
UI, rate limiting). See `doc/07-product-ui-auth-and-integrations.md` section 11 for what Phase 7 contains.

## Run it locally
Needs Node 22.12 or newer (Vite 8; 22.23 or newer to run the tests), a Postgres and a Redis.
1. Copy `.env.example` to `.env` and set at least `DATABASE_URL`, `REDIS_URL`, `APP_URL` (`http://localhost:3000`), `APP_SECRET` and
   `TOKEN_ENCRYPTION_KEY` (`openssl rand -base64 32` for the last two).
2. `npm install`, then `npx prisma generate`
3. `npx prisma migrate dev` then `npm run db:seed`
4. **`npm run dev`** and open http://localhost:3000 (landing) or http://localhost:3000/demo (demo booking page). One command, one
   origin: it builds the React app (`web/`) with Vite in watch mode and starts `next dev` on port 3000, so the API, the webhooks
   and the pages are all on `APP_URL`, which is what the Razorpay webhook tunnel and the Google redirect URI point at. Edit anything
   under `web/src`, wait for the `[web] built in ...` line (about a second) and reload the page. The launcher stops both processes
   on Ctrl+C or when the console window is closed. `PORT=3100 npm run dev` (or `-- --port 3100`) uses another port; then set
   `APP_URL` to match. `NEXT_PUBLIC_*`, `APP_LOCALE` and `ENABLE_DESIGN_PAGE` are read by the build: restart after changing them.
5. Log in at `/login` as `demo@example.com` / `demo-sessions-2026` (seeded, development only), or register a new
   account at `/register`. With `EMAIL_PROVIDER=log`, verification and reset links are printed in the server console.
6. `npm run worker` in a second terminal: hold expiry, `create-meeting`, `send-message` and reminders, plus cleanup every
   10 minutes of expired sessions, tokens and rate-limit buckets. (`npm run dev` never starts a worker.)
7. `npm run typecheck` (both TypeScript projects) and `npm test` (database tests need a migrated Postgres at `DATABASE_URL`; the
   rest are pure; see `CLAUDE.md` for the flags and the connection-pool advice). For local messaging without provider accounts set
   `MESSAGING_DRY_RUN=true`.

**Hot module reload (`npm run dev:hmr`).** Starts the same two processes plus Vite's dev server on port **5173**, and that port
becomes the browser origin: open http://localhost:5173. Pages update without a rebuild wait. Caveats, all because the origin is not
port 3000: (1) the launcher starts Next with `APP_URL=http://localhost:5173` (it overrides `.env` for that process; e-mailed links and redirects
use it, and the Origin check of POSTs accepts the page's own origin as well as `APP_URL`, so sign-in works on either port); (2) the Google redirect URI and the Razorpay webhook tunnel in
`.env` still point at port 3000, so the return from Google lands on http://localhost:3000, which serves the last build of the app
(the session cookie is shared between ports of `localhost`, it just is not hot there); (3) `--vite-port 5174` moves Vite, and
`npm run dev:web` is the Vite half alone (`SPA_API_TARGET` names the Next it proxies `/api` and the metadata routes to) for when you
start Next yourself, for example two copies of the repository on different ports.

**Production-like check** (the CSP, the HTML shell, the hashed assets, the template check). Two terminals, because `npm start` does not
return. Terminal 1: `npm run build`, then `npm start` (Next on port 3000 serves the API, the built assets and the shell) with
`APP_URL=http://localhost:3000 ALLOW_INSECURE_LOCAL_RUN=true` set (production mode refuses an `http://` `APP_URL` otherwise) and
`READINESS_REQUIRED=payout` so the seeded demo page is live. Terminal 2: `node scripts/spa-smoke.mjs http://localhost:3000` (`--no-db` when
the server has no database). The development server applies a looser CSP, so CSP behaviour is only verified here.

CI (`.github/workflows/ci.yml`) runs install, `prisma generate`, migrations, typecheck, tests, `npm run build` and an advisory
`npm audit` against Postgres and Redis service containers, and builds the Docker images with a start-up and smoke test.

## Front end (React app)
The whole UI is a standalone React app in `web/` (Vite + React Router + TanStack Query). Next.js keeps the JSON API, the webhooks, the
metadata routes (`robots`, `sitemap`, the icon and the share image) and the worker; it renders no page of its own. `doc/12-front-end.md`
describes the structure for a newcomer; `doc/10-react-migration-plan.md` and `doc/10-react-migration-deviations.md` are the history of
the move from Next-rendered pages. One origin serves everything:

- `proxy.ts` sends every page path (the table is `lib/spa/routes.ts`) to the internal route `app/spa-shell`, which returns the
  Vite-built `web/dist/index.html` with this request's CSP nonce, the page's title, robots and canonical tags, and a real 404 status for
  an unknown profile. The hashed JavaScript, CSS and fonts are plain files in `public/assets`.
- Page data comes from JSON endpoints: `app/api/...`, backed by view functions in `lib/views/*` that build each answer field by field.
- Code, all under `web/src`: `router.tsx`, `pages/<group>/` (a page fetches and renders a view), `components/` (`views/`, `app/`, `admin/`,
  `ui/`), `lib/`, `styles/`. No `next/*` import exists in `web/`, and a Vite plugin (`web/vite-server-guard.ts`) fails the build if browser code
  imports server code. `NEXT_PUBLIC_*`, `APP_LOCALE` and `ENABLE_DESIGN_PAGE` are build inputs of the bundle; no other environment variable
  can reach it (the build fails if a secret value does). See `doc/08-deployment.md` section 3.2 for build outputs, cache headers, the
  start-up check and Vercel.

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
1. In Google Cloud Console: create a project, enable the **Google Calendar API** and (unless you set
   `GOOGLE_REQUEST_GMAIL_SEND=false`) the **Gmail API** (APIs & Services > Library; they are two separate switches),
   configure the OAuth consent screen, and create an **OAuth client ID** (type *Web application*). Add
   `GOOGLE_REDIRECT_URI` (e.g. `http://localhost:3000/api/google/callback`) as an authorised redirect URI. While the
   consent screen is in *Testing*, add the influencer's Gmail as a test user; refresh tokens of Testing apps expire after
   7 days, so publish the app (and complete verification for `calendar.events`) before going live.
2. Fill in `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI`.
3. The influencer clicks **Connect Google Calendar** in onboarding or Settings. The dashboard then shows
   "Connected as <email>", or "Reconnect needed" with Google's reason if the grant is revoked; paid bookings wait as
   `PAID` and are re-queued automatically after reconnecting. By default the booking page is offline while Google is not
   connected (see "Go-live readiness").
4. The worker refreshes every connected influencer's Google token once a day (and two minutes after it starts) and
   flags a grant Google has revoked or expired as "Reconnect needed" with one alert, so a page does not keep taking
   money until a paid booking happens to notice (`worker/google-health.ts`). Network errors and Google outages are only
   logged; they never disconnect anyone.
5. **Switch account** and **Disconnect** warn when upcoming bookings already have calendar events: those events and the
   customers' invites stay on the old Google account, so later reschedules and cancels cannot update them. Both need an
   explicit confirmation that the server enforces itself (`confirm=1` on `/api/google/connect`, `{ "confirm": true }` in the
   body of `DELETE /api/dashboard/google`). Disconnecting remembers which Google account the events are on
   (`influencers.disconnected_google_email`, cleared by the next connect), so connecting a different account afterwards is
   still treated as a switch; a connect or reconnect that lands on a different account than the one on record, without the
   confirmation, is refused and its grant revoked. A group session's people already booked are not moved to the new
   calendar; a later booking of that session starts a second Meet there.
6. **Group sessions share one Calendar event.** A cancel deletes it only when no other PAID/SCHEDULED booking of the
   session is left in the database (decided under the session row lock, not from Google's attendee list), and attendee
   edits are written with the event's etag (`If-Match`) and re-read on a conflict. Google never reuses a deleted event's id,
   so the next payer's event gets the next id of a deterministic sequence; `sessions.event_generation` stores where the
   sequence stands. If the shared event was deleted behind the app's back, bookings left on it are moved to the
   replacement (invited, new link, confirmation emailed) and the influencer gets one alert. The booking job records its
   event, link and generation, schedules the booking and moves those bookings in ONE short transaction under the session
   row lock, and refuses (a retried job) if a cancel moved the session on while it was talking to Google, so a slow job
   can never point the session back at a deleted event. A cancel keeps the attendee on the event when another live booking
   of the session uses the same email address.

Google's revoke ends the app's access for the **whole Google account**, so a refused or disconnected token is not revoked
while another influencer profile is connected with the same account (our copy is still deleted).

**Known limits.** `confirm=1` is not a secret: it only records that the influencer was warned (the dialog sends it), and
they still have to pick an account on Google's own consent screen, so it cannot be used to attach an account they do not
control. A cancel talks to Google before it cancels the reminders, issues the refund and notifies the customer, so a slow
or hanging Google call (15 s timeout per request) delays those steps by that long; they still all run, because a Google
error is captured and reported afterwards, never thrown in the middle.

## Design system
Tokens: `web/src/styles/tokens.css`. Components: `web/src/components/ui/`. Every component and state is shown at `/design`
(development only, or `ENABLE_DESIGN_PAGE=true`, which is a build input: set it for `npm run build` and for the server).

## Admin console
A separate plane for the platform owner at `/admin` (own accounts, own cookie, 12-hour sessions, never reachable
with an influencer login). Create an administrator from the command line (there is no public registration):

```
npm run admin:create -- --email you@company.com --name "Your Name"
```

It prints a generated password once (or set `ADMIN_PASSWORD`); add `--reset` to change an existing admin's password.
The console shows platform totals, every influencer with their connection status, every payment (with filters for
"needs refund" and "captured but booking not paid"), bookings, and an append-only audit log of admin activity. Further sections below cover
moderation, CSV exports, admin refunds and cancellations, booking search, each influencer's account activity and the finance Reports page.

### Test logins for a development machine
After `npm run db:seed`, `npm run dev:logins` creates a login for the demo influencer and two administrators with random
passwords, and writes them to `dev-logins.local.md` (gitignored; the passwords are never printed). Run it again for new
passwords, or with `-- --remove` to delete the logins. It refuses to run unless `APP_URL` is a local address, so it cannot
create known logins on a deployed copy.

### India only: IST, INR, +91
The product is for India only (details and every decision in `doc/14-india-localisation.md`). All times are shown in Indian Standard Time
(UTC+05:30, no daylight saving) with `IST` visible; nothing asks for a time zone. Prices are INR and shown with Indian grouping
(`₹1,25,000.00`). Customers give a 10-digit Indian mobile number (`98765 43210`, `+91 98765 43210` or `09876543210`), stored as
`+91XXXXXXXXXX`. Stored instants stay UTC. Reports, earnings and exports split days and months at midnight IST.

Hours that an influencer saved in another time zone before this change keep working unchanged. The Availability page lists them; the
influencer can re-enter them in IST, or the operator can run (dry run by default; it converts only what is exact: zones without daylight
saving whose shifted hours stay on the same weekday, and refuses the rest with the reason):

    npm run data:normalise-timezones                                           # dry run, changes nothing
    npm run data:normalise-timezones -- --apply --confirm=NORMALISE-TIMEZONES # convert the exact ones

### Cleaning dummy data from a development database
Tests and QA runs against a shared development database leave rows behind (test administrators such as
`routes-x-<timestamp>@example.com`, throwaway influencers such as `ap-<timestamp>` with their services, bookings, payments,
payouts and connections). `npm run data:cleanup-test` removes them. It is a **dry run by default**: it prints how many rows it
would delete per table, which influencers and administrators those are, and separately what it KEEPS (the protected ones, and
anything it cannot positively identify as test data, for example bookings on `demo` whose customer address does not look like
test data, shown as id prefix, status, date and e-mail domain only).

    npm run data:cleanup-test                                          # dry run, deletes nothing
    npm run data:cleanup-test -- --apply --confirm=DELETE-TEST-DATA    # delete, in one transaction

`--apply` is refused unless `NODE_ENV` is not `production`, `APP_URL` is a local address and the typed confirmation is given.
Never touched: the `demo` influencer (its login, services, availability, payout account), the administrators `admin@`,
`admin1@` and `admin2@example.com`, `admin_audit_logs` (append-only; the rows of a deleted administrator keep their copied
e-mail), queues and Redis, and every row the patterns do not match. The patterns (timestamped `@example.com` names, the test
slug prefixes, QA names) are documented in `lib/test-data-cleanup.ts` and pinned by `tests/cleanup-test-data.test.ts`. After
`--apply`, run the dry run again: every "would be deleted" count should be 0.

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

The **Gmail API must also be enabled** on the Google Cloud project (APIs & Services > Library > Gmail API), separately from
the Calendar API. Without it every send fails with 403 `accessNotConfigured` and every customer email falls back to the
platform address. That is visible in two places: the Google panel in Settings shows "Gmail not working" (derived from how
the latest customer email was sent, no extra data kept), and the web/worker log gets one `Gmail sending is not working
for influencer ...` warning per influencer per hour with Google's reason.

## Influencer WhatsApp numbers
Customers are messaged from the **influencer's own WhatsApp Business number**. In **Settings > WhatsApp** the influencer
connects it either with Meta **Embedded Signup** (needs `META_APP_ID`, `META_APP_SECRET`, `META_ES_CONFIG_ID` and a Meta app
approved as a Tech Provider) or by entering their WhatsApp Business Account id, phone number id and a permanent system-user
token. Credentials are verified against Meta before saving (the number must belong to the account) and the token is stored
AES-256-GCM encrypted and never shown again.

On connect we submit our five message templates to the influencer's account for approval. Meta only accepts lowercase
letters, digits and underscores in a template name, and a plain name could clash with a template the influencer already has,
so they go out as `sa_booking_confirmation`, `sa_reminder_24h`, `sa_reminder_15m`, `sa_reschedule` and `sa_cancellation`;
inside the app the keys stay `booking-confirmation`, `reminder-24h`, `reminder-15m`, `reschedule` and `cancellation`
(`lib/message-templates.ts` translates at the Graph boundary). A template that already has one of those names is adopted only
if it takes the same number of variables as ours (the wording is not compared, so rewording a message never disables approved
templates); otherwise the card says so (status "Name already used") and it is not used. Statuses are kept current from Meta's template
webhook, a "Check template status" button, and a worker job (`worker/whatsapp-sync.ts`) that asks Meta every 30 minutes
about connections that still have an unapproved template. The dashboard shows which are approved. A message whose template is
not approved yet, or for an influencer with no healthy connection, goes straight to SMS (no WhatsApp attempt is made or
recorded). A token Meta rejects, including a permission error, flags the connection once and alerts the influencer, and the
dashboard overview lists it until they reconnect (Reconnect in the settings card, no need to disconnect first). Set
`WHATSAPP_PLATFORM_FALLBACK=true` only for testing with the platform's own number.

- **Webhooks.** Both ways of connecting call `subscribed_apps` (best effort) and then read the list back: "subscribed" is
  recorded only when our own Meta app (`META_APP_ID`) is in it. A hand-pasted token usually belongs to the influencer's OWN Meta
  app, which subscribes theirs and sends us nothing; then the card says live updates are not available and the 30-minute sync
  keeps template statuses fresh. The result is saved and shown, and Check template status tries again.
- **Pasted tokens are checked.** We ask Meta's `debug_token` about the token, as our app when `META_APP_ID` and the app secret
  are configured and, when our app cannot inspect it (a token of the influencer's own app), by having the token inspect
  itself. We refuse one that is invalid, lacks `whatsapp_business_management` or `whatsapp_business_messaging`, or expires within
  7 days (the 24-hour token on the API Setup page); a token that expires later, or one neither way could check, connects with
  a note. Use a System User token that never expires.
- **Two-step PIN.** Embedded Signup registers every number with its own random 6-digit PIN. Meta keeps the PIN on the number, so
  it is saved (AES-GCM encrypted, bound to the phone number, listed in the key-rotation tool, in `whatsapp_registration_pins`)
  BEFORE the number is registered, and it is kept when the influencer disconnects or a connection fails to save; a reconnect
  registers with the same PIN. If Meta refuses a PIN we just made up, the number may carry a PIN an older version registered it
  with (the shared `WHATSAPP_REGISTRATION_PIN`), which is tried once; if that fails too, the number holds a PIN that is not
  ours to know, perhaps the owner's own, so it is NOT changed behind their back: they are asked for it (optional field in the
  connect form), told where to look in WhatsApp Manager, and offered "I don't have it, reset it for me". Only when they tick
  that, and only for a PIN we generated ourselves, do we set a new one with Meta's set-PIN call and register again. A PIN the
  influencer typed is never overwritten, ticked or not.
  `WHATSAPP_REGISTRATION_PIN` is a development default only and is ignored in production. A manual connection registers the
  number only if given a PIN.
- **The Meta app secret** is one value with two names: `WHATSAPP_APP_SECRET` (webhook signatures) and `META_APP_SECRET`
  (Embedded Signup, token checks). Set either; both uses read it.
- **Graph API version.** `WHATSAPP_GRAPH_VERSION` (default in `lib/whatsapp-graph-version.ts`) is used for every Meta call and for
  the Facebook SDK in the sign-up window. Meta retires versions on a schedule, so check
  <https://developers.facebook.com/docs/graph-api/changelog/versions> from time to time.

Embedded Signup could not be exercised without an approved Meta app. The newer Graph calls (the Meta template names, token
check, webhook subscription, PIN registration, the Graph version) are covered by tests with Graph mocked and still need a pass
against a real Meta account. The local mock (next section) exercises the app's side only.

## WhatsApp by QR code (optional, unofficial)
An influencer can instead link their **own** WhatsApp as a linked device (WhatsApp > Settings > Linked devices) by scanning a QR code
in **Settings > WhatsApp**, and the platform then sends their booking messages (confirmation, the two reminders, reschedule,
cancellation) to their customers from that device. The official connection above stays the default and the safer option.

**The risks, plainly.** This is **unofficial**. WhatsApp's terms do not allow third-party clients, so a linked number **can be
restricted or banned at any time, without notice**, and neither we nor the influencer can prevent or reverse that. The protocol is
not public and can change, which breaks sending until the library is updated. Nothing in this mode tries to avoid detection: it
sends slowly, one message at a time, up to a daily cap, and only about a booking the customer made, and that is a courtesy to the
number, not a protection. The influencer must tick a written risk statement before linking (the version is stored with the
consent) and is told to use a number they can afford to lose. This mode never lowers the fallbacks: a message that cannot go out
through the linked number goes through the official connection (when active), then SMS or e-mail. Design and deviations:
`doc/14-whatsapp-qr-deviations.md`; settings and operation: `doc/08-deployment.md` section 4.

**What the influencer sees** (only when the mode is on): two independent sections, both always visible, "Official WhatsApp Business API
(Meta)" and "Link with QR code (unofficial)", with the note "When a QR link is active, booking messages are sent from it first;
otherwise the official connection, then SMS and e-mail. To stop using the QR link, disconnect it." (There is no stored preference: an
active QR link is used first, and disconnecting it is how to stop.) The QR screen shows the risk text in an alert, a required consent checkbox, then **Show QR code**: the code
(the page asks for the status every 2 seconds, and a new code replaces the old one when it runs out), the steps to scan it, and a Cancel. Once linked it shows the masked
number, the device, messages sent today against the cap, **Send a test message to my own number** and **Disconnect**. Separate
screens for reconnecting, paused (with the reason) and "the phone removed the device". Administrators see a card on the Influencer
page with the same facts and a **Force disconnect** that needs a reason (5 to 300 characters, kept in the audit log). With the mode
off, none of this exists on any screen.

**Turn it on**
1. `WHATSAPP_QR_ENABLED=true` on **both** the web app and the worker (the web app hides the option and the worker opens no
   connection unless both see it). Needs `REDIS_URL` and **one worker** (`npm run worker`): only the worker opens connections. A second worker
   (a rolling deploy that starts the new one first) takes no sockets: the worker that holds the lease in Redis (`wa-web:manager:lease`,
   renewed every 2 s, 20 s long) is the only one that connects, the other stays idle and says so once, and takes over once the lease is
   released (clean shutdown) or has run out (crash). Without Redis (development) an in-process lease does the same job for one process.
2. Optional limits, same environment: `WHATSAPP_QR_DAILY_CAP` (messages per number per Indian calendar day, default 150),
   `WHATSAPP_QR_MIN_GAP_MS` (fixed gap between two messages from a number, default 4000, at most 14000), `WHATSAPP_QR_MAX_SESSIONS` (numbers the
   worker keeps connected, default 10), `WHATSAPP_QR_KEEP_AUTH_WHEN_DISABLED` (keep the stored logins when the switch is turned off).
   The table is in `doc/08-deployment.md`.
3. Turning the switch **off** is the kill switch: at the next worker start every linked number is disconnected and its stored login
   deleted. Restarting the worker (a deploy) reconnects the linked numbers without a new scan.

**Requirements.** Redis (the QR code and the daily counters are shared between the web app and the worker through it; without it a
single process can only be used for tests), one worker, and memory: each linked number is a live connection plus an in-memory copy of
its login. We have not measured it on a real host; plan for a few tens of megabytes per number and watch the worker's memory before
raising `WHATSAPP_QR_MAX_SESSIONS`. The login of each device is stored encrypted (AES-256-GCM, `TOKEN_ENCRYPTION_KEY`, covered by
`keys:rotate`), the QR payload lives in Redis for about a minute and is never logged or stored in Postgres, and customers' replies and
chats are never read or stored.

**Try it locally without a phone.** `WHATSAPP_QR_ENABLED=true WHATSAPP_QR_FAKE=true` (the simulator is refused in production and with
a non-local `APP_URL`) with a local Redis and `npm run worker`: the screen shows a **Test mode: no real WhatsApp is used** badge, a
test code that cannot be scanned, the number "connects" about 12 seconds later as a made-up number, and messages are only logged.
`npm run dev` and `npm run dev:mock` start no worker, so linking cannot start there (the screen says the background worker is not
running); start the worker yourself (only one) against a Redis that is yours alone.

**Manual check for the owner, once, before real use** (a spare phone number you can lose, nothing here has been run against real
WhatsApp):
1. Switch the mode on, sign in as an influencer, Settings > WhatsApp > Link with QR code, tick the box, Show QR code, scan it.
   The screen should change to "Linked" with a masked number.
2. Press **Send a test message to my own number** and confirm it arrives on that phone.
3. Restart the worker. Shortly after, the dashboard should still say Linked (no new scan), and a test message should still go out.
4. On the phone, remove the device (WhatsApp > Linked devices > the device > Log out). The dashboard should change to "The linked
   device was removed", and a booking confirmation made afterwards should go by the official connection, SMS or e-mail.
5. Link again, set `WHATSAPP_QR_DAILY_CAP=2`, restart the worker, make three test bookings: the third message must not come from the
   linked number but fall back, and the dashboard should show 2 of 2 sent today.
6. Press **Disconnect**, confirm the device disappears from the phone's Linked devices list (remove it by hand if it does not), and
   that Settings shows "Not linked".
Record the date and the library version (`@whiskeysockets/baileys`) you checked.

**Licence note.** The mode uses `@whiskeysockets/baileys` (MIT), which depends on `libsignal` (**GPL-3.0**) and
`whatsapp-rust-bridge` (MIT), plus `uqr` (MIT) for the QR image. A GPL dependency is acceptable here because the platform is a
hosted service that is **not distributed** to users; if you ever distribute the server code or an image containing it (for
example to a customer to self-host), the GPL-3.0 terms of that dependency apply and you must review them first.

## Try the integrations without Google or Meta accounts
`npm run dev:mock` runs a **local mock of Google (OAuth consent, Calendar with Meet links, Gmail) and Meta (the Graph API the
app calls, the Embedded Signup window, signed webhooks)** next to the app, so you can connect an influencer and follow a booking
all the way to a Meet link and a WhatsApp message on one machine. It is a development tool: its code is in
`scripts/mock-providers/`, it listens on `127.0.0.1` only, it refuses to start in production, and every fake credential and account
in it starts with `MOCK-NOT-REAL-` or ends in `@mock-google.invalid`. (What you type into the demo, such as customer names, emails
and phone numbers, is stored as typed in the mock's state file and in your database, so use test data.) Full specification and
security rules: `doc/11-provider-simulator.md`.

**How it works.** The app's own code runs unchanged (the same clients, OAuth cookies and callback, worker jobs, webhook route
and settings screens). The only difference is the host it talks to: `lib/provider-endpoints.ts` is the one place that decides
where Google and Meta calls go, and `MOCK_PROVIDERS_URL` switches it to the mock. That switch is honoured only when `NODE_ENV`
is unset, `development` or `test`, no serverless platform is detected, `APP_URL` is `localhost` / `127.0.0.1` / `[::1]` and the
mock URL is a plain `http://127.0.0.1:<port>`; otherwise it is ignored with a warning, and with `NODE_ENV=production` the app
refuses to start while it is set. `npm run dev:mock` passes the variable and matching fake credentials to the processes it
starts only: **they are never written to `.env`, so do not put them there** (tests that assert the real hosts would fail).

**What you need first.** Postgres and Redis running, a migrated and seeded **development** database (`npx prisma migrate dev`,
`npm run db:seed`; fake connections and the demo's bookings are written to whatever `DATABASE_URL` points at), `.env` with
`DATABASE_URL`, `REDIS_URL`, `APP_SECRET` and `TOKEN_ENCRYPTION_KEY`, and **Razorpay test keys** (`rzp_test_...`) with any
`RAZORPAY_WEBHOOK_SECRET`. Razorpay is not mocked; locally the paid order is picked up by the worker's payment recovery (orders at
least 3 minutes old, checked every 2 minutes), so a booking turns PAID a few minutes after the test payment without any tunnel.

**The worker is off by default, on purpose.** The worker's health sweeps walk *every* influencer's Google and WhatsApp
connection in the database and ask the provider about each one. Pointed at the mock, which rejects every token it did not issue,
they would mark every other influencer's connection broken and take their booking pages offline within minutes. The worker also
takes whatever is queued on its Redis, and any other worker on that Redis (yours, for instance) would take the demo's jobs and
send the mock's tokens to the real Google and Meta. So `npm run dev:mock` starts only the mock, `next dev` and the watch build of the React app (like `npm run dev`), which is enough
for walk-through steps 1 to 5 (connecting, booking). For the steps that need the worker (the Meet link, the confirmation
messages, hold expiry, payment recovery):

1. **Stop your own `npm run worker`** (and make sure nobody else's worker uses the Redis below).
2. Use a **Postgres and a Redis dedicated to the demo, on this machine**, for example
   `docker run -p 5432:5432 -e POSTGRES_PASSWORD=dev postgres:16-alpine` and `docker run -p 6379:6379 redis:7-alpine`, then
   `npx prisma migrate deploy` and `npm run db:seed` against them.
3. Give the launcher their URLs (in `.env`, or in the shell, which wins) and run `npm run dev:mock -- --with-worker`.

With `--with-worker` the launcher refuses to start anything unless `DATABASE_URL` and `REDIS_URL` are both `localhost`,
`127.0.0.1` or `[::1]` **and** no other worker heartbeat is live; it says why (host names only, never credentials).
`--allow-shared-stores` overrides that check at your own risk (see `npm run dev:mock -- --help` and the doc for the consequences).

**Run it.**
```
npm run dev:mock                                   # mock server (4010), next dev (3000) and the app build; no worker
npm run dev:mock -- --with-worker                  # also the worker; refused unless the database and Redis are local and no other worker runs
npm run dev:mock -- --app-url http://localhost:3171   # another app port (next dev runs on it)
npm run dev:mock -- --app-url http://localhost:5173 --next-port 3000   # with Vite's dev server (npm run dev:web) in front
npm run dev:mock -- --reset --port 4110            # forget all fake state, another mock port
npm run mock:providers                              # the mock alone; -- --print-env prints the fake variables for a manual terminal
```
Open the control page at http://127.0.0.1:4010/__mock: it tells the story of what happened, in order, and has a page each for
Google (grants, calendar events, Meet links, the invitations Google *would* email), Gmail, Meta (accounts, numbers, templates,
tokens), WhatsApp messages with their status timeline, SMS, webhooks, the request log and **Faults** (switch on an expired
token, a rate limit, a slow Meet link, a revoked grant, a lost webhook... to see how the app copes).

**Walk-through (about 30 minutes).**
1. Log in as `demo@example.com`. In Settings, **Connect Google Calendar**: the mock consent page opens (red banner, both
   permissions ticked, an account chooser). Allow. Settings shows "Connected as creator@mock-google.invalid". Variations from the
   not-connected state: Cancel, untick Calendar (the app revokes the grant), untick Gmail.
2. In Settings, WhatsApp, **Connect with WhatsApp**: the mock Embedded Signup window opens; choose the first account and number
   and Finish. About 15 s later the templates turn Approved (a timer plays Meta's review; real review takes minutes to a day)
   and the card says Ready. Also try **Enter details manually** with the "Manual connect kit" on the Meta page, the number that
   has a PIN the app does not know (the "reset it for me" option), and Cancel inside the window.
3. Book the 1:1 at `/demo` with your own name, email and phone and WhatsApp opt-in, and pay with Razorpay's test card. With the
   worker running (the dedicated local stores above), within about 5 minutes it creates the event: the mock Google page shows it with a `/meet/mock-...` link, Gmail shows the
   confirmation, WhatsApp shows `sa_booking_confirmation` with its sent, delivered and read statuses, and the Sessions board
   shows the link. Use the manage link from the email to reschedule and cancel.
4. Break things on the Faults page and the other pages: revoke the Google grant or the WhatsApp token, make Gmail fail, delay
   Google past the app's timeout, stop the webhooks.

**What this does not prove.** The mock is written from the same understanding of Google and Meta as the app, so where that is
wrong both are wrong together. The real providers differ in these ways, among others: Google's unverified-app screen, test-user
limits and the verification and security assessment for the restricted `gmail.send` scope (Testing-mode refresh tokens die after 7
days); real Meet creation latency; Google really emailing the invitations; Meta's real Embedded Signup dialog, its message format
and Tech Provider approval; template review time and outcomes; most error codes other than 190, 10, 133005 and 133008;
messaging limits and quality ratings; webhook retries for days, batching and ordering (and Meta cannot reach `localhost`, a real
webhook needs a public HTTPS URL); DLT and the real SMS gateways. **App-side flows are verified against the mock; the provider
side stays unverified until it has had a pass against real accounts** (the checklist is in `doc/11-provider-simulator.md`,
section 7.5). The control page repeats this list.

## Go-live readiness
A booking page only takes bookings (and money) once the influencer has what the product needs. The same rules drive the
dashboard checklist, the public page and the booking/slot APIs (`lib/readiness.ts`):

- **Always required:** verified email, one active service, weekly hours.
- **Required by default:** Google Calendar (Meet links are created on it) and payout details (added; verification happens
  before the first payout).
- **Recommended, not blocking:** their own WhatsApp number and sending email from their Gmail. Without them customers get SMS
  and the platform's email address.

Change what blocks with `READINESS_REQUIRED` (comma list of `google,gmail,whatsapp,payout,approval`; `approval` is the platform-review gate, off by default, see "Suspending, reinstating and approving influencers"). Until a page is live only its
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

## Suspending, reinstating and approving influencers
The platform is the merchant of record, so an administrator can take a booking page offline. In **Admin > Influencers > (influencer)**
the status panel has three actions (`lib/admin/moderation.ts`, `POST /api/admin/influencers/:id/status`, MFA-gated). Each change and its
audit row (`influencer.suspended`, `influencer.reinstated`, `influencer.approved`) are written in ONE transaction, each is a conditional
update (a second click or a second administrator gets a 409, never a second audit row), and the influencer is e-mailed after the commit,
best effort.

- **Suspend** (needs a reason of 5 to 500 characters, shown to the influencer, never who did it). `buildPublicInfluencerWhere` (`lib/readiness.ts`) adds
  `suspendedAt = null`, so the public page, the slot and hold endpoints and the sitemap treat the page as not live (a stranger gets a 404,
  the owner a preview naming the suspension). Checkout refuses new payments, even for a hold made before the suspension (`startCheckout`
  locks the influencer row first, so a suspension in flight either commits first or waits). The pay page of such a booking shows no Pay
  button. The influencer cannot approve a booking request into a payable hold (declining stays allowed). Creating a payout is refused.
- **What suspension deliberately leaves alone.** Nothing is cancelled or refunded automatically: existing paid bookings stay `SCHEDULED`,
  and a payment already started at Razorpay is still captured and applied by the webhook. Customers can still **cancel** from their manage
  link but cannot **reschedule** (the slot endpoints offer nothing for a suspended host; the page says so). The influencer can still sign
  in. To unwind upcoming sessions, cancel them from Admin > Bookings (below).
- **Payouts for a suspended influencer** need an explicit acknowledgement. Approving or marking an existing payout paid is refused with
  `409 { code: "influencer-suspended" }` unless the administrator confirms ("pay anyway") and gives a reason of 5 to 300 characters; the
  confirmation and reason are written into the `payout.approved` / `payout.paid` audit entry. Cancelling a payout stays allowed.
- **Reinstate** puts the page back (it is live again only if everything else is still satisfied).
- **Approval gate.** Add `approval` to `READINESS_REQUIRED` (for example `READINESS_REQUIRED=google,payout,approval`) and a page goes live
  only after an administrator approves it; until then the influencer's checklist shows "Platform review". The gate is **off by default**.
  While it is off, finishing onboarding approves the page automatically (`approved_by_email = 'system:gate-off'`) and an administrator can
  approve any page in advance, so turning the gate on later does not take a live page offline; only pages that finish onboarding afterwards
  wait. A page is listed under **Awaiting approval** only when it has finished onboarding. The approval e-mail is sent only while the gate
  is on and never to a suspended account. `READINESS_BYPASS=true` (development) switches the gate off like the connections, but never
  bypasses a suspension.
- **One-time safeguard before turning the gate on in a deployment that already has live pages.** The migration approved every page that was
  onboarded at migration time (`system:grandfathered`). Pages that finished onboarding since, with the gate off, were approved by the
  rule above, but check there is no unapproved live page first, and approve it or run the statement in
  `doc/13-marketplace-essentials.md` (WP-A, item 3) once. There is no bulk-approve endpoint on purpose.

## Admin exports, refunds, cancellations and booking search
- **CSV exports** (`lib/admin/exports.ts`, `GET /api/admin/exports/payments|bookings|payouts|audit?from=YYYY-MM-DD&to=YYYY-MM-DD`). The
  Payments, Bookings, Payouts and Audit pages each have a download control. A file holds the rows **created** in the range (both days
  included, UTC; default the 1st of the month to today; at most 366 days). The columns are chosen one by one (no phone numbers, intake
  answers, Meet links, tokens or full bank numbers; an erased customer reads "(erased)"). **Formula protection:** a cell that starts with
  `=`, `+`, `-`, `@`, a tab, a line break or a full-width form of those gets a leading apostrophe (`csvCell` in `lib/dashboard.ts`), and the
  file starts with a UTF-8 byte-order mark so Excel reads non-Latin names. **Row cap:** more than 20,000 rows is refused with a 400
  ("Choose a shorter range"), never cut short. **Audit:** the `admin.export` entry (kind, range, row count) is written BEFORE the file is
  returned; if it cannot be written, no data leaves. MFA-gated, rate limited (`admin-export`, 30 per hour per IP).
- **Refund a captured payment** (Admin > Payments, `POST /api/admin/payments/:id/refund`, `lib/admin/refund.ts`). In plain words: the
  refund is always **what is left of the payment**, worked out on the server (the page's amount travels only as a check; if it differs the
  request is refused with `409 amount-changed`). It needs a reason and a confirmation. Only captured payments can be refunded, and not one
  that is already refunded in full or has a refund in progress. While the booking is a paid or scheduled session that has **not started**,
  cancel the booking first (the exception is a real duplicate payment: the booking has another captured payment and this one is flagged).
  A payment inside a **pending payout** cannot be refunded; cancel that payout first. The audit entry `payment.refund_requested` is written
  and awaited before Razorpay is called, the outcome follows (`payment.refunded`, `payment.refund_submitted`, `payment.refund_pending`,
  `payment.refund_failed`, `payment.refund_refused`, `payment.refund_unconfirmed`), and the refund itself goes through the same
  claim-then-Razorpay code as every other refund (`lib/refunds.ts`), so two clicks or two administrators cannot refund twice. Nothing is
  refunded automatically.
- **Cancel a booking for a customer** (Admin > Bookings, `POST /api/admin/bookings/:id/cancel`, `lib/admin/cancel.ts`). Allowed for a
  paid or scheduled booking whose session has not started, and for a failed one. It runs the same `cancelBooking` the influencer uses
  (Calendar event, reminders, the customer's cancellation notice, and the refund decision: the payment is flagged for refund, or refunded
  at once when `AUTO_REFUND_ON_CANCEL=true`), with a reason (5 to 500 characters), and tells the influencer it was the platform. The customer is
  told the platform will refund; the administrator then refunds the flagged payment from Payments. Audited as `booking.cancel_requested`
  (before) and `booking.cancelled_by_admin` (after). Both actions are rate limited (`admin-money`, 60 per hour per IP).
- **Booking search** (Admin > Bookings, `?q=`): up to 120 characters, matches the booking id exactly (when it has the shape of one) or part
  of the customer's e-mail or name, not case sensitive.

## Influencer account activity
A security and dispute trail of what happened on an influencer account, shown to the influencer under **Settings > Account activity** and
to an administrator on the influencer's page (`GET /api/dashboard/activity`, `GET /api/admin/influencers/:id/activity`; 25 rows a page,
newest first, at most 400 pages, optional `?action=` filter). Columns: When, What, Device ("Chrome on Windows"), IP.

- **Recorded** (`ACTIVITY_ACTIONS` in `lib/activity-actions.ts`): account creation, sign-ins and failed sign-ins, e-mail verification,
  password change and reset, sign-out everywhere and of one device, password confirmation, profile and page-address changes, service
  created or changed (price and visibility), availability changes, booking cancel and reschedule, booking request approve and decline,
  refunds, customer data erased, payout-details changes, Google and WhatsApp connect and disconnect, onboarding completed, earnings
  exported.
- **Never recorded:** a customer's name, e-mail or phone, a password, a token, a UPI id or a full account number (only the last four digits
  of a bank account). Each action has an allowlist of detail keys (`ACTIVITY_DETAIL_KEYS`) enforced in code; the sentence is built on the
  server from it, and the raw user agent is never sent to the browser. Not logged at all: forgot-password and resend-verification requests,
  and a failed re-authentication or password change.
- **Best effort.** `recordActivity` (`lib/activity.ts`) is called after the action succeeded, outside its transaction, and never throws or
  changes the response: a failed or slow write (capped at 2 s) leaves one warning line in the log and the action carries on. (The admin
  audit log keeps the stricter rule: it is awaited before money moves.)
- **Coalescing.** Repeats of `auth.login_failed`, `auth.reauthenticated`, `profile.updated`, `availability.changed` and `earnings.exported`
  from the same influencer, actor and IP within 15 minutes are one row whose count rises ("3 times"), so a loop of requests cannot bury the
  entries that matter. Security and money entries (passwords, payout details, sign-ins, refunds, price changes, erasures, cancellations)
  are never merged.
- **Retention: 365 days** (`ACTIVITY_RETENTION_DAYS`, a constant, not a setting). The worker's housekeeping (`sweepExpiredAuthRows`, every
  ~10 minutes) deletes older rows.

## Customer portal and receipts
Customers have no accounts, so a lost confirmation e-mail used to mean a lost manage link. **`/bookings`** ("Find your booking" in the site
footer) fixes that:

1. The customer enters the e-mail address they booked with (`POST /api/customer/access`). The page always answers the same thing ("if we
   have bookings under this address we sent a link") with the same status (202) and the same response time, whether or not the address
   has bookings.
2. If it has non-erased bookings, the platform's own mail provider (never a host's Gmail) sends a link `/bookings/<token>`. The token is
   random, valid for **one hour**, stored only as its SHA-256 (`customer_access_tokens`) and the page carries `Referrer-Policy:
   no-referrer`. It is a different mechanism from the signed `/manage/<token>` links. Expired rows are deleted by the worker's
   housekeeping.
3. `/bookings/:token` lists the address's paid bookings across all hosts, newest first (at most 200), with the status in words, the manage
   link of upcoming sessions, and a receipt. The customer can:
   - **download everything held** under the address as one JSON file (bookings, their answers, payments, messages; no tokens, Meet links or
     Razorpay order ids);
   - **erase their data** through the same function as the host's Erase button (`eraseCustomerData`, `lib/privacy.ts`): name, e-mail,
     phone, time zone and answers are erased; payment rows stay for accounting; upcoming live sessions and pending approval requests are
     kept until they are cancelled (the dialog says how many of each). The customer is e-mailed a confirmation, and one system audit entry
     (`customer.erased`, without the address) is written, only when something changed.
4. **Rate limits** (`lib/rate-limit/policies.ts`): asking for a link 5 per hour per IP; at most 3 e-mails per hour per address (a
   hashed key, and only addresses with bookings use it up); a **global cap** on all portal e-mail per hour, `CUSTOMER_PORTAL_MAIL_CAP_PER_HOUR`
   (default 300, `0` stops all portal mail). Over a limit the answer is the same silent 202. Export 10 per hour and erase 5 per hour per IP;
   viewing the page 60 per 10 minutes per IP. Trade-off: someone can use up a real customer's 3 e-mails for an hour, which delays their link
   but cannot reveal anything.
5. **Receipts** (`lib/receipts.ts`, `ReceiptCard`) show on the portal and on the manage page of a paid booking: booking reference, the
   customer's own name, host, service, session time, date paid, amount, any refunded amount, status (Paid / Partly refunded / Refunded) and
   the Razorpay payment id. **It is a receipt, not a tax invoice**: it carries no tax registration number, tax breakdown or invoice
   number (GST invoices are deferred, see `doc/13-product-build-plan.md` section 5). The "paid on" date is when checkout began. "Print
   receipt" uses the browser's print dialog (`web/src/styles/print.css` leaves only the receipt on paper; "Save as PDF" makes a PDF).

## Admin finance reports
**Admin > Reports** (`/admin/reports`, `GET /api/admin/reports?from=&to=`, MFA-gated, `lib/admin/reports.ts`): read-only, nine aggregate
SQL queries, each currency on its own (never added together). The range defaults to the 1st of this month up to today (UTC) and may be up
to 366 days; an invalid range is a 400. Figures for the period:
- **Gross**: payments captured (including those since refunded), **dated by the day checkout began** (the order was created), UTC. The
  schema stores no capture time, so a payment captured later by the recovery job stays on the day it began.
- **Refunds**: refunds recorded in the period that are pending or processed. **Net of refunds** = Gross - Refunds.
- **Platform fees** and **Paid out**: the stored fee and net amount of payouts marked paid in the period (as computed when the payout was
  created; nothing is recomputed).
- A **By month** table (the 12 months ending with the month of the end date).

Balances "right now" (all-time, whatever the range):
- **Held for influencers**: captured money, not flagged for refund and not in a sent payout, on a paid, scheduled or completed booking (or in
  a payout still to be sent), less refunds, before the fee. **In pending payouts**: the net, after the fee, of payouts not yet sent.
- **Owed to customers**: payments flagged for refund, not in a sent payout, not yet refunded.
- **To recover**: refunds made after an influencer's payout was marked paid (the same as "Refunded since" on Payouts, summed).
- Shown only when not zero: **Not payable** (captured money on a booking that can never be paid out), **Flagged, already paid out**, and
  **Refunds that did not complete**.

## Reminder repair
Delayed reminder jobs live only in Redis, so a Redis that lost its data (or an enqueue that failed during an outage) leaves a paid,
upcoming booking with no reminder. `worker/reminder-reconcile.ts` runs `reconcileReminders` (`lib/reminders.ts`) **every 10 minutes and once
60 seconds after the worker starts** (off without `REDIS_URL`; single flight; safe on several workers). It looks at `SCHEDULED` bookings
starting within the next 25 hours, in pages of 250 and at most 2000 per run (a run that hits the cap resumes where it stopped), and
re-creates a missing or wrong-time reminder job. It leaves alone a reminder already delivered, one whose fire time was already past when the
booking was made or rescheduled, and a job a worker is running. After 3 Redis failures in a row it gives up and the next tick retries.
**Stale reminders are skipped:** a late job does not send "starts in 15 minutes" once the session has started, nor "tomorrow" with less than
12 hours left (`staleReminderReason`); the skip is logged and writes no message row. Rescheduling re-arms both reminders.

## Demo data for the marketplace features
`npm run db:seed:features` (after `npm run db:seed`) creates rows the features need to be seen working: an onboarded, **unapproved**
influencer `/review-demo` (verified payout details, no usable login) for the approval demo, and on `/demo` five bookings for
`customer.seedfeat@example.com` (three past, one upcoming 20 days ahead, one cancelled with a payment flagged for refund), a paid payout
and a refund made after it (shows "To recover"). Run it again safely (nothing is duplicated); `npm run db:seed:features -- --remove`
deletes everything it created and nothing else. Every row is recognisable (ids `seedfeat_*`, provider ids `*_SEEDFEAT_*`); it refuses to
run unless `APP_URL` is local and `NODE_ENV` is not production, the customer's phone is not dialable and Meet links are placeholders. For the
approval demo run the server with `READINESS_REQUIRED=payout,approval READINESS_BYPASS=false`. `npm run data:cleanup-test` (see "Cleaning
dummy data" above) is a different tool: it removes test rows left by tests and QA and does not remove the `seedfeat_*` rows.

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
