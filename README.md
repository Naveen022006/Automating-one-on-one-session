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

CI (`.github/workflows/ci.yml`) runs install, `prisma generate`, migrations, typecheck, tests and `next build`
against Postgres and Redis service containers.

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
4. Reveal the account (audit-logged), send the money yourself, then **Payouts > Mark as paid** with the bank reference (UTR).
   The influencer is emailed. **Cancel** releases the payments. A refund made after a payout was paid is flagged
   "refunded since, to recover".

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
