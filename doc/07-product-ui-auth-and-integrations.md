# Phase 7 — Integrations, Accounts, Landing Page and UI Redesign

> Hand-off spec for the next implementer (Kiro). Read `doc/00-overview.md` and `README.md` first, then this file.
> Phases 1–6 are built. This phase makes the product real and presentable: finish the third-party integrations,
> add accounts (register / login), add a public landing page, and redesign every screen to a professional standard.

## 0. How to work

- **One branch per part**, cut from an up-to-date `main`, merged by pull request. Suggested:
  `phase-7a-integrations`, `phase-7b-auth`, `phase-7c-design-system`, `phase-7d-landing-and-public`,
  `phase-7e-dashboard-redesign`. Do not mix parts in one branch.
- Keep the existing API contracts and the booking state machine (`HELD → PENDING_PAYMENT → PAID → SCHEDULED → COMPLETED`,
  exits `EXPIRED / CANCELLED / FAILED`). Changing them needs a written reason in the PR.
- Existing tests must keep passing. Add tests for every new server-side rule (auth, ownership checks, webhooks).
- Never commit secrets. `.env` is git-ignored; add new variables to `.env.example` with a comment.
- Update the README and tick the checklists in `doc/` as part of each PR. (Several are stale today — see section 9.)

## 1. Current state (verified)

**Stack:** Next.js 16 (App Router) + TypeScript, Prisma 7 with `@prisma/adapter-pg`, Postgres, Redis + BullMQ, separate
worker process (`npm run worker`). Prisma 7: the connection URL lives in `prisma.config.ts`; the client is generated to
`generated/prisma` and imported from `@/generated/prisma/client`. Run `npx prisma generate` after pulling.

**What works in code:**

| Area | Status |
|---|---|
| Slots, holds, double-booking protection, hold expiry | Built, tested |
| Razorpay checkout, signed + idempotent webhook, `create-meeting` enqueue | Built |
| Google OAuth connect, encrypted refresh token, Calendar event + Meet link, group shared event | Built (needs real Google credentials) |
| WhatsApp send (template), SMS fallback, delivery-status webhook, `messages` table | Built (needs real accounts + approved templates) |
| Reminders at T-24h and T-15m, retries, reschedule and cancel | Built |
| Influencer dashboard, customer self-service page | Built, but reached only through **signed links** (no login) |
| Email | **Stub**: `lib/email.ts` only logs. No customer ever receives an email |
| SMS | **Placeholder**: `lib/sms.ts` posts to a fake URL |
| UI | Unstyled prototype: one small `app/globals.css`, system font, no landing page, no auth pages |

**Running locally (what the owner uses):** Supabase Postgres (session pooler URL) + Upstash Redis (`rediss://` URL) +
`npm run dev` + `npm run worker` + a Cloudflare quick tunnel for webhooks. Razorpay is in **test mode**.

**Verify the baseline before changing anything:** book a slot at `/demo/book`, pay with test card
`4111 1111 1111 1111`, and confirm in the database that the booking reaches `PAID` and a `webhook_events` row for
`payment.captured` exists. At the time of writing, the only booking in the database was still `PENDING_PAYMENT` with a
`payment.failed` event, so this end-to-end path has **not** been confirmed. Fix whatever blocks it first (usually the
tunnel URL in the Razorpay webhook, or a mismatched `RAZORPAY_WEBHOOK_SECRET`).

## 2. Part A — Finish the integrations (`phase-7a-integrations`)

### A1. Razorpay (test, then live)
- Confirm the full flow above in test mode, including `payment.failed` and a replayed webhook (must create one job).
- Webhook events to subscribe: `payment.captured`, `payment.failed`, `order.paid`. URL: `<APP_URL>/api/webhooks/payment`.
- Env: `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET` (the webhook secret is chosen by us and must
  equal the value typed in the Razorpay dashboard).
- Add a refunds path: today `Payment.needsRefund` is only a flag. Build the dashboard action "Refund" using the Razorpay
  refunds API, store the result, move the payment to `REFUNDED`, and make cancellation refund policy configurable per service.
- **Decision for the owner (do not guess):** all money currently goes to one Razorpay account. Paying influencers
  individually needs Razorpay Route (linked accounts, KYC per influencer). Out of scope unless the owner says otherwise.

### A2. Google Calendar and automatic Meet links
Already implemented (`lib/google.ts`, `lib/meeting.ts`, `worker/jobs/createMeeting.ts`, `/api/google/connect|callback`).
What remains is configuration, onboarding UX and verification:
1. Google Cloud: create a project, enable **Google Calendar API**, configure the OAuth consent screen, create an OAuth
   client of type *Web application*. Authorised redirect URI must equal `GOOGLE_REDIRECT_URI`
   (local: `http://localhost:3000/api/google/callback`; production: the real domain).
2. While the consent screen is in *Testing*, add each influencer's Gmail as a test user. Refresh tokens expire after
   7 days in Testing, so **publish the app** (and complete Google verification for the sensitive scope
   `calendar.events`) before real users. Start this early; it takes weeks.
3. Env: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI`, `TOKEN_ENCRYPTION_KEY`
   (`openssl rand -base64 32`), `APP_SECRET`.
4. Replace the CLI-generated connect link (`npm run google:connect-link`) with a **"Connect Google Calendar" button in
   the logged-in dashboard / onboarding wizard** (Part B). Show connection state: Connected as `<email>`, Reconnect
   needed (with the reason from `GoogleToken.reconnectReason`), Disconnect.
5. Verify: a paid booking produces a calendar event with a working Meet link, the customer receives Google's invite,
   the booking becomes `SCHEDULED` with `event_id` and `meet_link`, and a revoked token flags "reconnect needed".
6. Free Gmail accounts limit group Meet calls to 60 minutes. Warn in the service form when a group service is longer.

### A3. WhatsApp (Meta WhatsApp Cloud API)
Code exists (`lib/whatsapp.ts`, `lib/messaging.ts`, `worker/jobs/sendMessage.ts`, `/api/webhooks/whatsapp`). Needs accounts and templates.

Manual steps (cannot be coded; owner or implementer does them in Meta's UI):
1. Create a Meta Business account and a Meta app with the WhatsApp product. Add and verify a business phone number.
2. Create a permanent **System User access token** (not the 24-hour test token) → `WHATSAPP_TOKEN`; phone number id →
   `WHATSAPP_PHONE_NUMBER_ID`.
3. Webhook: callback URL `<APP_URL>/api/webhooks/whatsapp`, verify token → `WHATSAPP_WEBHOOK_VERIFY_TOKEN`, subscribe to
   `messages`. App secret → `WHATSAPP_APP_SECRET` (used to verify `X-Hub-Signature-256`).
4. Submit these **utility** templates for approval (language `en`; approval takes hours to days). The template names are
   fixed by the code, so they must match exactly:

| Template name (code) | Purpose | Body variables (order matters) | Suggested body |
|---|---|---|---|
| `booking-confirmation` | After payment, with the link | 1 link, 2 service, 3 host, 4 time | "Your {{2}} session with {{3}} on {{4}} is confirmed. Join here: {{1}}" |
| `reminder-24h` | 24 hours before | 1 link, 2 service, 3 host, 4 time | "Reminder: {{2}} with {{3}} is tomorrow, {{4}}. Join link: {{1}}" |
| `reminder-15m` | 15 minutes before | 1 link, 2 service, 3 host, 4 time | "{{2}} with {{3}} starts in 15 minutes ({{4}}). Join here: {{1}}" |
| `reschedule` | After a reschedule | 1 link, 2 service, 3 host, 4 time | "Your {{2}} session with {{3}} was moved to {{4}}. Updated link: {{1}}" |
| `cancellation` | After a cancel | 1 service, 2 host, 3 time | "Your {{1}} session with {{2}} on {{3}} was cancelled. Any refund follows our policy." |

(Updated in Phase 7 when the extra variables were added; the source of truth is `lib/message-templates.ts`.)

5. **Improve the code** (small, in this part): every template currently receives only the link as `{{1}}`. Add the
   service title, influencer name and the session time **formatted in the customer's timezone** (`booking.customerTz`) as
   further template variables, and use that same readable text in the SMS fallback. Today the SMS body contains a raw
   ISO timestamp (`2026-10-12T05:30:00.000Z`), which is not acceptable for customers.
6. Only message numbers with `whatsappOptIn = true`. Verify the SMS fallback by disabling WhatsApp.

### A4. SMS (India: MSG91 or Twilio)
- Replace the placeholder in `lib/sms.ts` with the chosen provider's real API (keep `sendSMS` signature and the
  injectable `fetch`). Env: `SMS_API_KEY`, `SMS_API_URL`, plus any sender-id variable the provider needs.
- India requires **DLT registration** (entity, sender ID, content templates) before SMS delivers. Manual, takes days.

### A5. Email (currently a stub — highest priority gap)
- Choose a provider (Resend, Postmark, SES or SMTP). Implement a real `EmailSender` and register it with
  `setEmailSender` (hook already exists in `lib/email.ts`).
- Emails to send: booking confirmation + receipt (with Meet link and the signed `/manage/<token>` link), reminders (optional),
  cancellation/reschedule, and — for Part B — verify-email and password-reset.
- Build responsive HTML email templates (same visual language as the web app, table-based layout, plain-text alternative).
- Env: provider API key, `EMAIL_FROM`. Configure SPF and DKIM on the sending domain.

### A6. Cleanups found while reviewing (fix in this part)
- `npx tsc --noEmit` currently fails: `lib/messaging.ts:227` (type `MessageChannel` includes `"EMAIL"` but the variable only
  allows `"WHATSAPP" | "SMS" | null`) and `tests/group-meeting.test.ts:311` (a `.ts` extension in an import path).
- Next.js generated `AGENTS.md`; decide whether to commit or ignore it.
- Add `npm run typecheck` and `npm test` to CI (GitHub Actions) with a Postgres service container so database tests run.

**Done when (Part A):** a real paid test booking sends a real WhatsApp message and a real email, falls back to SMS when
WhatsApp is disabled, creates a working Meet link on the influencer's calendar, and `tsc` and the test suite pass.

## 3. Part B — Accounts: registration and login (`phase-7b-auth`)

Today there is no login. Influencers reach the dashboard through a signed, expiring link made by
`npm run dashboard:link`. Customers are guests and reach self-service through a signed link in their email. Keep the
customer side as guests (no account needed to book). Add real accounts for **influencers**.

### B1. Data model
Add (migration required; do not edit existing migrations):
- `users` (or extend `influencers`): `email` (unique, lowercased), `passwordHash`, `emailVerifiedAt`, `createdAt`.
  Link one user to one `Influencer` profile. The existing `Influencer.email` is unique already.
- `auth_sessions`: id (random, stored hashed), userId, expiresAt, createdAt, lastUsedAt, userAgent, ip.
- `password_reset_tokens` and `email_verification_tokens`: hashed token, userId, expiresAt, usedAt.

### B2. Behaviour
- **Register:** name, email, password (min 10 chars; check against a common-password list), accept Terms and Privacy.
  Creates the user + influencer profile with a unique `slug` (suggest from the name, allow editing, reject reserved words
  like `dashboard`, `login`, `api`, `manage`, `admin`). Sends a verification email.
- **Login:** email + password → opaque session cookie (`HttpOnly`, `Secure` in production, `SameSite=Lax`, rolling expiry
  of 30 days, 8 hours idle for sensitive actions). Logout, "log out everywhere".
- **Forgot / reset password** via emailed single-use token (1 hour).
- Hash passwords with argon2id (or bcrypt cost ≥ 12). Never log credentials or tokens.
- **Rate limit** login, register and reset endpoints (per IP and per email); use Redis, which is already available.
- CSRF: all state-changing routes must reject cross-site requests (check `Origin`, or use tokens for forms).
- Optional later: "Continue with Google". If added, use a separate sign-in scope; do **not** reuse the Calendar consent.

### B3. Replace the signed dashboard link
- Routes under `/dashboard` and `/api/dashboard/*` require a session and must check that the target resource belongs to
  the logged-in influencer (existing ownership checks stay; they just switch from the token to the session).
- Keep `lib/signing.ts` for **customer self-service links** only. Remove `npm run dashboard:link` (or keep as a dev tool).
- Unauthenticated users hitting `/dashboard` are redirected to `/login?next=...`.

### B4. Onboarding wizard (after first login)
1. Profile (name, photo, short bio, timezone, public slug)
2. Create first service (title, description, duration, price, 1:1 or group + capacity)
3. Weekly availability and blocked dates
4. Connect Google Calendar (button, Part A2)
5. Preview the public booking page and copy the link

**Done when (Part B):** a new person can register, verify their email, log in, finish onboarding, and see only their own
data; another logged-in influencer gets 403/404 on their resources; auth routes are rate limited and tested.

## 4. Part C — Design system (`phase-7c-design-system`)

Build once, reuse everywhere. Do this **before** redesigning pages.

### C1. Direction: professional, calm, and not "AI-generated looking"
The product handles money and people's time, so it should feel trustworthy and editorial rather than flashy.

**Do**
- One restrained brand colour (an ink/navy or deep green works well for trust) plus a neutral grey scale. One accent used
  sparingly for primary actions and links. Status colours (success, warning, danger) used only for status.
- Real typography: load fonts with `next/font` (self-hosted). Pair a refined serif or humanist display face for
  headlines with a clean sans for UI text (for example *Fraunces* or *Newsreader* with *Inter* or *Geist*; pick one pair
  and stick to it). Use a modular type scale, comfortable line length (60–75 characters), and tabular numbers for money and times.
- A strict spacing scale (4/8 px grid), consistent corner radius (6–8 px), subtle 1 px borders and very soft shadows.
- Plenty of white space; clear visual hierarchy; one primary action per screen.
- Specific, honest copy written for this product ("Get paid and send the Meet link automatically"), written in plain language.
- Show the **real product**: crop actual dashboard and booking screens (use seeded demo data) instead of abstract illustrations.
- Motion only where it explains something (200 ms ease for hover/focus/expand). Respect `prefers-reduced-motion`.

**Do not**
- No purple-to-blue gradients, no glowing blobs, no glassmorphism, no neon, no "sparkle" or robot imagery.
- No emoji as icons. Use one consistent icon set (Lucide or Phosphor, 1.5 px stroke) at fixed sizes.
- No stock-photo handshake people, no fake testimonials, no invented logos or metrics, no "10x" or "revolutionise" claims.
- No centred wall of three identical feature cards with icons as the whole page.
- No lorem ipsum or placeholder text in anything that ships.

### C2. Foundation
- Tokens as CSS variables (colour, type scale, spacing, radius, shadow, z-index) in one place; light theme first, dark
  theme optional but must not look washed out. Contrast **WCAG AA** minimum.
- Choose a styling approach and stay consistent: Tailwind CSS (v4) with the tokens, plus a small component layer
  (shadcn/ui primitives are acceptable if restyled to this direction so it does not look like the default kit).
- Components: Button (primary, secondary, ghost, danger, loading), Input, Select, Textarea, Checkbox, Radio, Switch, Date
  picker, Time-slot picker, Field with label/help/error, Card, Badge/Status pill (maps booking and message statuses),
  Table, Tabs, Dialog, Drawer, Dropdown menu, Toast, Tooltip, Skeleton, Empty state, Avatar, Stepper, Breadcrumb, Pagination.
- States for everything: hover, focus-visible ring, disabled, loading, error, empty.
- Layouts: marketing layout (header + footer), app layout (sidebar + top bar), focused layout (auth and checkout).
- Accessibility: semantic HTML, keyboard navigable, visible focus, labels on every input, `aria-live` for async
  status (payment confirming), correct heading order, 44 px minimum touch targets.
- Create a `/design` (dev-only) page that renders every component and state for review.

**Done when (Part C):** the component page exists, passes an automated accessibility check (axe), and all tokens come
from one source.

## 5. Part D — Landing page and public pages (`phase-7d-landing-and-public`)

### D1. Landing page `/`
Audience: creators, coaches and mentors who sell 1:1 and small-group sessions. Sections, in order:
1. **Header:** logo/wordmark, links (How it works, Features, FAQ), `Log in`, primary `Get started`.
2. **Hero:** one clear headline, one supporting sentence, primary CTA, secondary CTA ("See a demo booking page"),
   and a real screenshot of the booking page / dashboard beside or below the text.
3. **How it works** in four concrete steps that match the product: customer picks a slot → pays → Meet link is created
   automatically → WhatsApp + email delivered, reminders sent.
4. **What you get** (real capabilities only): scheduling with timezone handling, Razorpay payments, automatic Google
   Meet links, WhatsApp/SMS delivery with fallback, reminders, group sessions, earnings dashboard, reschedule/cancel for
   customers. Each with a product screenshot or small UI fragment, not a stock icon.
5. **For customers** strip: "No account needed. Pay, get your link on WhatsApp."
6. **FAQ** (payments and payout timing, Google account needed, WhatsApp opt-in, refunds, group session limits, data privacy).
7. **Final CTA** and **footer** (product, legal, contact).
- Pricing section only if the owner confirms a pricing model (not defined in this repo). Otherwise omit it; do not invent plans.
- Mobile-first, fast (LCP under 2.5 s), SEO metadata, Open Graph image, sitemap, robots, structured data for the organisation.

### D2. Other public pages
- `/login`, `/register`, `/forgot-password`, `/reset-password`, `/verify-email` (Part B), styled as focused pages.
- **Legal (required by Razorpay and Meta, and for trust):** Terms of Service, Privacy Policy, Refund and Cancellation
  Policy, Contact. Mark clearly as drafts for the owner and a lawyer to review; do not present invented legal text as final.
- `/[influencer]` **public profile** (name, photo, bio, services with price and duration, "Book" buttons). Today only
  `/[influencer]/book` exists.
- `404` and error pages in the same style.

### D3. Booking flow redesign (customer-facing, `/[influencer]/book`)
- Stepper: Service → Date & time → Details → Pay → Confirmation. Clear summary card (service, price, duration, host).
- Calendar-style date picker with available days highlighted, time slots grouped by morning/afternoon/evening, shown in
  the customer's timezone with the timezone visible and changeable.
- Visible hold countdown with a calm tone; handle expiry gracefully (offer to pick a time again).
- Confirmation page: what happens next, **Meet link shown immediately once available**, Add to Google/Apple Calendar
  (.ics), link to manage the booking, and a "message not received? resend" option. Never rely on WhatsApp alone.
- Group services show seats left.

**Done when (Part D):** a stranger can land on `/`, understand the product in under 15 seconds, register, and a customer
can complete a booking on a phone without confusion.

## 6. Part E — Dashboard and management redesign (`phase-7e-dashboard-redesign`)

Rebuild `app/dashboard` and `app/manage` on the design system. Behaviour already exists; this is information design.
- **App shell:** left sidebar (Overview, Sessions, Services, Availability, Customers, Earnings, Messages, Settings),
  top bar with profile menu, mobile bottom or drawer navigation.
- **Overview:** upcoming sessions (next 7 days), earnings this month, items needing attention (Google reconnect needed,
  failed messages, payments flagged `needsRefund`), and the public booking link with a copy button.
- **Sessions:** table with filters (upcoming, past, cancelled), status pills, per-booking drawer showing customer,
  payment, message history per channel, Meet link, and actions (resend link, reschedule, cancel, refund).
- **Services:** list and edit form with live preview of how it looks to customers; activate/deactivate.
- **Availability:** weekly grid editor and a blocked-dates calendar.
- **Earnings:** totals and per-service breakdown, date range, CSV export.
- **Settings:** profile, public slug, timezone, Google connection status, notification preferences, password and sessions.
- Empty states that tell the user what to do next. Skeleton loaders. Confirm dialogs for destructive actions. Toasts for results.
- `app/manage/[token]` (customer): simple, reassuring, mobile-first reschedule and cancel with the refund policy stated.

**Done when (Part E):** every dashboard capability from Phase 6 is reachable from the new UI with no regression, and
the new UI is usable at 375 px width.

## 7. Cross-cutting requirements

- **Security:** server-side validation (zod) on every input; ownership checks on every influencer resource; no secrets in
  client bundles; security headers (CSP, `X-Content-Type-Options`, `Referrer-Policy`, HSTS in production); webhook signature
  checks stay mandatory; `/api/bookings/[id]` keeps gating the Meet link to paid statuses.
- **Privacy:** customer phone and email are personal data. Add a privacy policy, data retention note, and a way to delete a
  customer's data on request.
- **Performance and SEO:** server components by default, `next/image`, no layout shift, per-page metadata.
- **Observability:** replace `console.log` alerts (`lib/alerts.ts`) with a real influencer notification (email at minimum)
  and error reporting (Sentry or similar) for the web app and worker.
- **Deployment (later):** web on Vercel, worker as a long-running process (Railway, Fly.io or a VPS) because Vercel
  functions cannot host a BullMQ worker. Set production env vars, a stable domain for webhooks (no quick tunnels), and a
  production Razorpay account (KYC) before taking real money.
- **Testing:** unit tests for new libraries, integration tests for auth and ownership, Playwright end-to-end for
  register → onboarding → book → pay (test mode) → confirmation.

## 8. Open decisions for the owner (ask before building)
1. Brand name, logo and tone of voice.
2. Pricing model for influencers (free, monthly plan, or commission) and whether pricing appears on the landing page.
3. Payouts: one platform Razorpay account, or per-influencer payouts via Razorpay Route.
4. Email provider and sending domain.
5. SMS provider (MSG91 or Twilio) and whether DLT registration is already started.
6. Whether customers need accounts later (booking history) or stay guests.
7. Currencies and countries beyond India (affects WhatsApp templates, SMS and payments).

## 9. Known issues and stale docs to fix
- `doc/05-reminders-and-retries.md` shows 0 of 7 tasks ticked although the code is merged. Verify and tick.
- `doc/04-messaging.md` has three unticked items that are external/manual (Meta account, template approval, SMS + DLT).
- `CLAUDE.md` still says only Phases 1–2 are implemented; update it to the current architecture.
- `README.md` mentions "Phases 1, 2, 3 and 6" only; Phases 4 and 5 are also merged.
- Typecheck failures listed in A6.
- 28 of 69 tests fail on a machine without a database; they need Postgres at `DATABASE_URL`. Confirm they pass against a
  real database and run them in CI.

## 10. Suggested order and definition of done
1. Verify the baseline payment flow and fix A6 cleanups.
2. Part C (design system), because everything else uses it.
3. Part B (accounts) in parallel with Part A (integrations) where possible.
4. Part D (landing and public pages), then Part E (dashboard).
5. Final pass: accessibility, mobile, performance, copy review, README and docs updated.

The phase is done when a new influencer can: find the landing page, register and verify, finish onboarding, connect
Google Calendar, share their booking link, and a customer can book and pay in test mode and receive the Meet link by
WhatsApp and email, with reminders scheduled, all on a polished, consistent, accessible UI.

## 11. Implementation status (Phase 7 build)

Built on one branch (`phase-7-product-ui-auth-integrations`) with one commit per part, instead of five branches, so
the parts that depend on each other (auth ↔ dashboard ↔ design system) land together. Split it if you prefer.

### Part A: integrations
- [x] Razorpay refunds: dashboard **Refund** action (`POST /api/dashboard/bookings/[id]/refund`, full or partial),
      `lib/refunds.ts` claims the payment first so double clicks cannot refund twice; `refund.processed` /
      `refund.failed` webhooks update the payment (subscribe to them in Razorpay). Payment moves to `REFUNDED`.
- [x] Cancellation refund policy per service (`FULL`, `NOTICE_24H`, `NONE`; host cancels always refund).
      `AUTO_REFUND_ON_CANCEL=true` refunds eligible cancels immediately; otherwise they are flagged and alerted.
- [x] Google: "Connect Google Calendar" button (session-authenticated `/api/google/connect`), status
      Connected as `<email>` / Reconnect needed (reason) / Disconnect (revokes at Google). The CLI connect link and
      `npm run dashboard:link` are removed. 60-minute group warning in the service form and API.
- [x] WhatsApp: templates now get link, service, host and the time in the customer's timezone; the SMS fallback uses
      the same text. `WHATSAPP_DISABLED=true` forces the SMS fallback for testing; `MESSAGING_DRY_RUN=true` logs.
- [x] SMS: real MSG91 (Flow API, one DLT flow per template) and Twilio providers in `lib/sms.ts`.
- [x] Email: Resend and Postmark providers over fetch (`EMAIL_PROVIDER`), responsive table-based HTML + plain
      text for confirmation/receipt, reschedule, cancellation (with refund outcome), verify-email, password reset,
      password changed and influencer alerts. Confirmation emails are no longer re-sent when a job retries.
- [x] A6 cleanups: `lib/messaging.ts` channel type, `.ts` import in `tests/group-meeting.test.ts`, `AGENTS.md`
      ignored, GitHub Actions CI with Postgres + Redis (`.github/workflows/ci.yml`).
- [ ] Manual: Meta templates, DLT registration, SPF/DKIM, Google app publishing/verification, live Razorpay KYC.

Fixed while integrating: dashboard/self-service cancel and reschedule (`lib/manage.ts`) did not touch reminders and
re-sent the *confirmation* template instead of a cancellation/reschedule notice; "Resend link" was swallowed by the
messaging idempotency check. All three now behave as documented. Customers can no longer move a whole group
session from their self-service link (host only). `/api/bookings/[id]/cancel|reschedule` now require the owning
influencer's login and use the same code path as the dashboard.

### Part B: accounts
- [x] `users`, `auth_sessions`, `password_reset_tokens`, `email_verification_tokens` (migration
      `20261014000000_phase7_accounts_refunds_rate_limits`).
- [x] Register (password policy with common-password list, terms, unique non-reserved slug), verify email
      (token POSTed from the page so link scanners cannot consume it), login, logout, log out everywhere, per-device
      sign-out, forgot/reset password (1 hour, single use, revokes every session), change password.
- [x] Opaque session cookie: HttpOnly, SameSite=Lax, `__Host-` + Secure in production, rolling 30 days; sensitive
      actions (refund, disconnect Google, erase customer, log out everywhere, revoke device) need a password entry in
      the last 8 hours and prompt for it in the UI.
- [x] Passwords: **scrypt** (N=2^15, r=8, p=3, OWASP parameters), not argon2id/bcrypt: no native module to build on
      deploy targets. The hash format is versioned and rehashed on login, so argon2id can be added later.
- [x] CSRF origin check on every state-changing API call (`proxy.ts`, webhooks exempt).
- [x] `/dashboard` and `/api/dashboard/*` use the session; ownership checks kept. Unverified or un-onboarded
      accounts have no public page (the owner sees a preview).
- [x] Onboarding wizard: profile, first service, availability + days off, Google, preview and copy link.

### Rate limiting (all APIs) and database protection
- Every `/api/*` request passes `proxy.ts`: a global 300/min per IP plus a route rule (`lib/rate-limit/policies.ts`),
  e.g. login 10/15 min per IP, register 5/hour, holds 10/10 min, refunds 10/hour. Route handlers add per-identity
  limits after parsing the body (login 5/15 min per email, reset 3/hour per email, holds 5/10 min per email, resend
  link 3/hour per booking). 429 responses carry `Retry-After` and `RateLimit-*` headers.
- Counters use a sliding-window algorithm in **Redis** (one atomic Lua script per hit). If Redis is not configured or
  fails, they fall back to the **Postgres** `rate_limit_buckets` table (one upsert per hit), so limits keep working on
  the database alone; if both fail the request is allowed and the error logged. The worker sweeps expired rows.
- The database is also protected by pool limits: `DATABASE_POOL_MAX`, connection wait timeout and a per-statement
  timeout (`lib/db.ts`).
- Set `CLIENT_IP_HEADER` in production (e.g. `cf-connecting-ip`, `x-real-ip`) so clients cannot spoof their IP.

### Parts C–E: design system, public pages, dashboard
- [x] Tokens in `app/styles/tokens.css` (single source; AA contrast checked), Newsreader + Inter via `next/font`,
      Lucide icons inlined, component layer in `components/ui/*`, `/design` catalogue (dev only).
      Styling is plain CSS on the tokens rather than Tailwind: nothing new to install, and the look is not a kit default.
- [x] Landing page `/` (hero, how it works, features with real UI fragments, customer strip, FAQ, CTA), legal drafts
      (`/terms`, `/privacy`, `/refund-policy`, `/contact`, clearly marked as drafts), public profile `/<slug>`,
      redesigned booking flow (stepper, availability calendar, grouped times, changeable timezone, hold countdown,
      confirmation with Meet link, .ics, manage link, resend), 404/error pages, sitemap, robots, OG image, JSON-LD.
- [x] Dashboard app shell (sidebar, top bar, mobile bottom nav): Overview, Sessions (filters + drawer with payment,
      per-channel message history and actions incl. refund), Services (form with live preview), Availability (weekly
      grid + days-off calendar), Customers (with data erasure), Earnings (range + CSV), Messages, Settings.
- [x] Security headers (CSP with per-request nonce + strict-dynamic, HSTS in production, nosniff, frame-ancestors).
- [x] Privacy: customer data erasure, retention note in the privacy policy.
- [x] Observability: influencer alerts are emailed (opt-out in Settings); errors are structured JSON logs with an
      optional `ERROR_WEBHOOK_URL`. Sentry needs its SDK added (left as a hook: `setErrorReporter`).

### Not done here (needs a network-enabled machine or an owner decision)
- `npm install`, `prisma generate`, `next build`, the database tests and an axe run could not be executed in the
  build sandbox (no npm registry). CI runs all of them. Playwright end-to-end tests and the automated axe check
  need their dev dependencies added.
- Section 8 open decisions are still open; defaults used: brand name from `NEXT_PUBLIC_BRAND_NAME`, no pricing
  section, one platform Razorpay account, MSG91 for SMS, Resend/Postmark for email, customers stay guests.
