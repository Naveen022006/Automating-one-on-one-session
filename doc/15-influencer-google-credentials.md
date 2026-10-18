# 15. Influencer-owned Google credentials and the no-platform-e-mail mode

Status: implemented (branch feat/influencer-google-credentials). The owner's decisions:

1. There is no platform-wide Google app. Every influencer creates their OWN Google Cloud OAuth client, pastes its Client ID and
   Client Secret on their Settings page, and connects Calendar (and optionally Gmail) with it.
2. The platform sends no e-mail of its own for now (no Resend or Postmark). Customer e-mails go only through the influencer's own
   connected Gmail. Production must be allowed to run with no platform e-mail provider.

Section 1 lists every place that touches Google client credentials, section 2 every place that sends or promises e-mail, each with
the decision. Sections 3 onward describe what was built, the deviations, the setup guide and what was not checked.

## 1. Inventory: Google client credentials, tokens, scopes

`GOOGLE_*` below means the three environment variables `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI`.

| # | Place | What it does today | Decision |
|---|-------|--------------------|----------|
| G1 | `lib/google.ts` `env()` + `buildAuthUrl` | Reads `GOOGLE_CLIENT_ID` and `GOOGLE_REDIRECT_URI` for the consent URL. | Takes resolved credentials (`getGoogleCredentials`). Redirect URI defaults to `${APP_URL}/api/google/callback`. |
| G2 | `lib/google.ts` `refreshAccessToken` | Reads the env pair, exchanges a refresh token. `invalid_client` is "transient" (our configuration). | Resolves by influencer plus the grant's `clientKind`. For an own client `invalid_client` means the influencer's client is gone or its secret changed: reconnect needed, with a plain reason. For the platform client it stays transient. |
| G3 | `lib/google.ts` `exchangeCode` | Reads the env triple for the code exchange. | Takes the credentials of the influencer named in the signed state. |
| G4 | `lib/google.ts` `revokeToken` | Posts the token to Google's revoke endpoint. Needs no client credentials (Google identifies the token). | Unchanged. Documented here so the "revoke uses the grant's client" requirement is explicit: nothing to resolve. |
| G5 | `lib/google.ts` Calendar methods (`insertEvent`, `getEvent`, `addAttendee`, `updateEvent`, `removeAttendee`, `deleteEvent`) | Use an access token only. | Unchanged; the access token comes from a refresh that now uses the grant's client. |
| G6 | `lib/meeting.ts` (create-meeting job, group join, cancel cleanup) | `getRefreshToken` then `google.refreshAccessToken(token)`. `GoogleReconnectError` marks the connection and alerts. | `getRefreshToken` also returns `clientKind`; refresh is called with `{ influencerId, clientKind }`. A missing own client throws `GoogleReconnectError` ("Your Google client was removed or is no longer valid"), the existing path flags it. |
| G7 | `lib/manage.ts` (cancel, reschedule, add attendee) | Same pattern as G6. | Same change as G6. |
| G8 | `lib/customer-email.ts` (Gmail send) | `getRefreshToken` then `google.refreshAccessToken`, `sendGmail`. Falls back to the platform e-mail provider on any failure. | Same refresh change. The fallback no longer exists when the platform provider is `none`: the e-mail is skipped and recorded. |
| G9 | `lib/gmail.ts` | Sends with an access token only. | Unchanged. |
| G10 | `worker/google-health.ts` (daily check, `startGoogleHealth`) | `google.refreshAccessToken` for every ACTIVE token. Refuses to start when `GOOGLE_CLIENT_ID/SECRET` are unset. | The check loads each grant with its `clientKind`; the "env pair unset" early return goes. A dead own client is a "dead" verdict (reconnect needed, alert), a platform client problem stays "unknown". |
| G11 | `lib/google-tokens.ts` | `saveGoogleToken`, `getRefreshToken`, `getActiveGrant`, `markReconnectNeeded`, `deleteGoogleToken`, status. | `google_tokens.client_kind` (`own` or `platform`, default `platform` for existing rows) is written on connect and returned by the readers. |
| G12 | `app/api/google/connect/route.ts` | Builds the consent URL with the platform client. | Resolves the credentials of the signed-in influencer; no usable client in mode `own` is a refusal with a clear outcome (`no-client`), never a fallback to another client. The state token records the client kind. |
| G13 | `app/api/google/callback/route.ts` | Exchanges the code with the platform client; revokes a refused grant. | Finds the influencer from the signed state, uses THAT influencer's client for the exchange, stores `clientKind` with the token. Never another influencer's client. |
| G14 | `app/api/dashboard/google/route.ts` | GET status, DELETE disconnect (revokes). | GET gains the client card data; POST actions `save-client` and `remove-client`; DELETE unchanged in meaning. |
| G15 | `lib/google-health*.ts` | Not present as `lib/` files; the health logic is `worker/google-health.ts` (G10). | See G10. |
| G16 | `lib/key-rotation-db.ts` `ENCRYPTED_COLUMNS` | Lists every `*_enc` column. | Adds `influencer_google_clients.client_secret_enc` with AAD `google-client:<influencerId>`. The coverage test in `tests/key-rotation.test.ts` enforces it. |
| G17 | `lib/test-data-cleanup.ts` | Enumerates tables hanging off influencers. | Adds `influencer_google_clients` (the FK cascades, but the dry-run counts and the table list are explicit). |
| G18 | `lib/env.ts` | Warns in production when the env pair is unset. | New `GOOGLE_CLIENT_MODE` (`own` default, `platform`, `either`). In mode `own` no warning about the env pair. In `platform` and `either` the pair is required (`either` only warns). The redirect-host warning stays. |
| G19 | `lib/readiness.ts`, `lib/readiness-checks.ts`, `lib/views/dashboard-*` | "google" item: Connect Google Calendar. | Item text becomes the three steps (create your client, paste it, connect). The rule is unchanged (an ACTIVE grant is required). |
| G20 | `web/src/components/app/GoogleConnect.tsx` (Settings and Onboarding) | Connect button, Gmail toggle, banners (one says "not configured: GOOGLE_CLIENT_ID..."). | Replaced by the three-step card. The "not configured" banner becomes "Save your Google client first". |
| G21 | `scripts/mock-providers/google.ts`, `fixtures.ts` | Accepts exactly the fixture client pair. | Accepts ANY client pair the influencer gives (recorded), `invalid_client` for a secret exactly `bad-secret`, `invalid_grant` for a bogus code with a good pair. The fixtures pair keeps working for `platform` mode. |
| G22 | `.env.example`, `README.md`, `doc/07`, `doc/08`, `doc/11`, `doc/00-overview.md` | Describe the platform client. | Updated: the three variables become optional (mode `platform` or `either`), the influencer guide is in the app and in this document. |
| G23 | `web/src/components/views/public/PrivacyView.tsx` | Says an encrypted Google refresh token is kept. | Adds the client ID, the encrypted client secret, and that disconnect deletes the tokens and removing the client deletes the secret. |

New code for the same job: `lib/google-credentials.ts` (resolution), `lib/google-client-check.ts` (`verifyGoogleClient`), a model
`InfluencerGoogleClient` (`influencer_google_clients`).

## 2. Inventory: e-mail the platform sends or promises

`sendAccountEmail` (lib/email.ts) is the one function behind every platform e-mail; `sendEmail` is the raw transport; the customer
path is `sendBookingEmail` / `sendCustomerEmail` / `sendCustomerRendered`. With `EMAIL_PROVIDER=none` all platform sends become a
logged no-op (one log line with the tag, never the content or the address) that returns "not sent".

### 2a. Callers of `sendAccountEmail`

| # | Caller | E-mail | What happens with provider `none` |
|---|--------|--------|-----------------------------------|
| E1 | `lib/auth/accounts.ts` `issueVerification` (register, resend) | Verification link | Token is still created; not sent. Registration succeeds. The pending page says the administrator verifies new accounts. Admin "Mark e-mail verified" button (new). |
| E2 | `lib/auth/accounts.ts` `requestPasswordReset` | Reset link | Token is created and invalidated as today; nothing sent. The forgot-password page says to ask the administrator for a reset link. Admin "Create reset link" button (new). |
| E3 | `lib/auth/accounts.ts` `resetPassword`, `changePassword` | "Your password was changed" | Skipped silently. |
| E4 | `app/api/dashboard/payout-account/route.ts` | "Payout details saved" | Skipped; the page already shows the state. |
| E5 | `app/api/admin/influencers/[id]/payout-account/route.ts` | "Payout details reviewed" | Skipped. The admin panel text says the message is e-mailed only when e-mail is on. |
| E6 | `app/api/admin/payouts/[id]/route.ts` | "Payout marked paid / rejected" | Skipped. Admin UI wording follows `emailEnabled`. |
| E7 | `lib/admin/moderation.ts` | Suspend, reinstate, approve notices; returns `emailed` | `emailed` is false; the admin toast no longer claims "was emailed". |
| E8 | `lib/admin/security-notices.ts` | Admin 2FA changed, recovery codes regenerated, lockout | Skipped. The lockout is still reported by `reportNotice`. The security page says notices are not e-mailed. |
| E9 | `lib/alerts.ts` `alertInfluencer` default sender | Reconnect Google, meeting failed, refund needed, booking request, ... | Still logged and shown on the dashboard (attention count). The Settings toggle "Email me when something needs attention" says e-mail is off on this site. |
| E10 | `lib/health-alerts.ts` | System health e-mail to `ADMIN_ALERT_EMAILS` | Skipped; the error webhook and the log remain. The Health page text follows `emailEnabled`. |
| E11 | `lib/customer-portal.ts` `requestPortalLink`, `erasePortalData` | "Find your bookings" link, erasure confirmation | The link cannot be sent. The Find-your-bookings page says so (no promise of an e-mail) and points to the booking messages; the endpoint keeps answering the same 202 (no enumeration). Erasure still happens; its confirmation is skipped. |

### 2b. Customer e-mail (`sendBookingEmail`, `sendCustomerRendered`, via `sendCustomerEmail`)

Confirmation, receipt, cancellation, reschedule, booking request received/approved/declined (callers: `lib/meeting.ts`,
`lib/manage.ts`, `lib/booking-approval.ts`, the resend endpoints). Today: the influencer's Gmail first, the platform provider as the
fallback with the influencer as Reply-To. Decision: with provider `none` there is no fallback. The e-mail goes through the
influencer's Gmail when connected and allowed, otherwise it is skipped, and the `Message` row says so (status FAILED with the reason
"No e-mail channel: connect Gmail or ..."), never SENT. WhatsApp and SMS are unaffected. The Gmail path uses the influencer's
client (G8).

### 2c. Pages and endpoints that tell the user "we e-mailed you"

| # | Where | Decision |
|---|-------|----------|
| U1 | `VerifyEmailView.tsx` ("We sent a link to ..."), `ResendVerification` | With `emailEnabled` false: "Your administrator verifies new accounts", no resend button. |
| U2 | `SettingsForms.tsx` e-mail verification line ("We sent a link"), Resend link button | Same wording; no button. |
| U3 | `ForgotPasswordView.tsx`, `AuthForms.tsx` `ForgotPassword` ("Check your email") | "Ask your administrator for a password reset link." The form is replaced by that text. The API still answers the same JSON. |
| U4 | `app/api/auth/resend-verification`, `forgot-password` | Unchanged status codes; the message says what is true. |
| U5 | `FindBookingsView.tsx`, `CustomerPortalView.tsx` ("We sent a confirmation to your e-mail") | Wording follows `emailEnabled` (portal) and drops the promise (erasure). |
| U6 | `BookingFlow.tsx` ("We emailed a copy of your request", "we email you a link to pay"), `PayView.tsx` | Customer e-mail depends on the host's Gmail, so the claims are softened to "you also get this on WhatsApp or SMS / on your booking page" where the e-mail is not certain. |
| U7 | `SessionsBoard.tsx` toast "The customer was emailed a link to pay" | Softened. |
| U8 | Admin: `InfluencerStatusPanel`, `PayoutActions`, `PayoutPanel`, `HealthView` ("They are emailed") | Wording follows `emailEnabled` from the admin session view. |
| U9 | `GoogleConnect.tsx`, `lib/readiness.ts` ("customer emails come from our address with your email as Reply-To") | There is no "our address" any more: without Gmail permission customers get WhatsApp or SMS only and no e-mail. |
| U10 | `lib/email/providers.ts` start-up log | New `none` provider and its single start-up warning; `log` stays refused in production. |

`emailEnabled` is a hand-picked boolean in `GET /api/auth/session` (both variants) and `GET /api/admin/session`, and in the dashboard
settings view. The provider name never leaves the server.

## 3. What was built

### 3.1 Data (migration `20261112000000_influencer_google_clients`, additive)

- Table `influencer_google_clients` (`InfluencerGoogleClient`): `influencer_id` unique (FK, cascade), `client_id` (plain text, it is not a
  secret), `client_secret_enc` (AES-256-GCM through `lib/crypto.ts`, AAD `google-client:<influencerId>`, so a ciphertext copied onto another
  influencer cannot be read), `checked_at` (when Google last accepted the pair), timestamps.
- Column `google_tokens.client_kind` (`own` | `platform`, default `platform`, so every existing grant keeps using the shared pair).
- The secret column is covered by key rotation (`lib/key-rotation-db.ts`, the coverage test enforces it) and by `lib/test-data-cleanup.ts`.

### 3.2 Which client a call uses (`lib/google-credentials.ts`)

One function, `getGoogleCredentials(influencerId, kind?)`. With a `kind` (a grant that exists) it returns exactly that client and ignores the mode:
`own` needs the influencer's saved client, `platform` needs the env pair. Without a `kind` (a NEW connection) `GOOGLE_CLIENT_MODE` decides:

| mode | own client saved | shared pair set | result |
|---|---|---|---|
| `own` (default, also empty or unknown) | yes | any | own |
| `own` | no | any | nothing: "Save your own Google client first" |
| `platform` | any | yes | the shared pair |
| `either` | yes | any | own |
| `either` | no | yes | the shared pair |

A failure is a value, never a fallback: a grant whose own client is gone is "reconnect needed" with the reason "Your Google client was removed or is
no longer valid. Save your Google client again, then reconnect."; an own client that Google answers `invalid_client` for is the same (they deleted
it in Google Cloud or changed its secret). For the shared pair `invalid_client` and a missing pair stay "transient" (the operator's problem), as before.
`GOOGLE_REDIRECT_URI` defaults to `${APP_URL}/api/google/callback`.

Where the kind travels: `google_tokens.client_kind` is written by the callback and read by `getRefreshToken` / `getActiveGrant`;
`GoogleClient.refreshAccessToken(refreshToken, { influencerId, clientKind })` is called by `lib/meeting.ts`, `lib/manage.ts`, `lib/customer-email.ts`
(Gmail) and `worker/google-health.ts`. The signed OAuth state carries `k` so the callback exchanges the code with the client the consent screen was
shown for (a state without `k`, signed before this release, means the shared pair). Revoking a token needs no client credentials, so
`revokeToken` is unchanged.

### 3.3 Checking a pasted pair (`lib/google-client-check.ts`)

Format first (client ID `^[0-9]+-[A-Za-z0-9_]+\.apps\.googleusercontent\.com$`, secret 20 to 80 characters of `[A-Za-z0-9_-]`, `GOCSPX-` accepted),
then one POST to Google's token endpoint with a deliberately invalid code: `invalid_client` means the pair is wrong (the message says to check that
both belong to the same OAuth client, without spaces, type Web application), `invalid_grant` means Google accepted the pair. A network error, a
timeout (10 s), a 5xx or a 429 is "could not check, nothing was saved". Only an accepted pair is saved.

### 3.4 Endpoints

- `GET /api/dashboard/google-client` -> `{ client, connection }`. `client` is `{ mode, hasOwnClient, clientId, clientSecretSaved, checkedAt,
  redirectUri, origin, requiredScopes, canConnect, grantClient }`; `connection` is the existing Google state. The same `client` object is also
  `googleClient` in the Settings and Onboarding views. `clientSecretSaved` is a boolean; the secret is never selected by any view.
- `POST /api/dashboard/google-client` `{ action: "save-client", clientId, clientSecret }` and `{ action: "remove-client", confirm? }`. Both need a
  recent password entry (`requireRecentAuth`, like Disconnect). Rate limits: route rule `dashboard-google-client` (10 per hour per session) and the
  identity rule `google-client-check` (12 per hour per influencer, across devices).
  - save: refused in mode `platform` (409). A different client ID than the one a grant was made with flags the grant "reconnect needed"
    ("You changed your Google client, so Google needs to be connected again.") and revokes its old token; the same ID with a new secret keeps the
    connection. Activity entry `google.client_saved` (masked tail of the ID, `replaced`).
  - remove: 404 when there is none. A connection made with this client is removed with it, with the same rule as Disconnect (409 `needsConfirmation`
    while upcoming bookings have calendar events, then `confirm: true`); a connection made with the shared pair is left alone. Activity entries
    `google.client_removed` and, when a connection went, `google.disconnected`.
- `GET /api/google/connect` uses the signed-in influencer's client. With no usable client it redirects back with `?google=no-client` (or
  `not-configured` in mode `platform`) and starts no OAuth round trip. `GET /api/google/callback` adds the outcomes `no-client` and `client-rejected`.
- The activity log never stores the secret or the whole client ID.

### 3.5 No platform e-mail (`EMAIL_PROVIDER=none`)

- `lib/email/providers.ts`: `noneTransport` throws `EmailDisabledError`; `platformEmailEnabled()` is the one boolean pages may know.
- `sendAccountEmail` catches it, writes ONE log line (`[email:<tag>] not sent ...`, tag only: no address, subject or body) and returns `false`.
  Every caller either ignores the result (notices) or reports it (`moderateInfluencer` returns `emailed: false`; `approveRequest` returns
  `emailed` and hands the host the pay link when the customer could not be e-mailed, so an approval is never silently stuck).
- Verification, password reset and the customer-portal link create nothing when nobody can receive them: otherwise a "forgot password" click would
  cancel the one link an administrator handed over (only the newest reset link is valid). Registration still works; the new user is unverified.
- Customer e-mail: Gmail of the influencer (their grant's own client) or not at all. A booking e-mail with no Gmail route leaves no message row; one
  that Gmail failed to send leaves a FAILED row starting `Gmail could not send:`, which the Google card reads to show "Gmail not working".
  WhatsApp and SMS are untouched.
- Health alerts skip the e-mail stage (webhook and log only) instead of "failing" every run.
- Pages: `emailEnabled` in `GET /api/auth/session` and `GET /api/admin/session` (both variants), the Settings and Onboarding views, the admin
  influencer, status and security views. The pages that promised an e-mail (verification pending, resend button, forgot-password, find-your-bookings,
  the verify banner, the alert switch, admin 2FA text) tell the truth; while the answer is on its way they offer nothing (no form that turns into
  "ask your administrator").

### 3.6 Admin tools (`lib/admin/account-help.ts`, buttons on the admin influencer page)

- `POST /api/admin/influencers/[id]/verify-email`: marks the login address verified and retires outstanding verification links, in one transaction
  with the audit row `influencer.email_verified`. 401 signed out, 403 password-only session of an administrator with 2FA, 404 unknown or malformed
  id, 409 already verified or no sign-in account.
- `POST /api/admin/influencers/[id]/reset-link`: creates a one-time reset link through the existing flow (`createPasswordResetLink`, one hour, a
  newer link cancels older ones) and returns the full URL once (`{ ok, url, expiresAt }`, `private, no-store`). It is stored only as a hash, is in
  neither the audit row (`influencer.reset_link_created`, detail `expiresAt` only) nor any log line, and the page shows it once in a dialog.
  The same gates and 404/409 as above. Both routes share the rule `admin-account-help` (30 per hour per address).

### 3.7 The simulator (`scripts/mock-providers/google.ts`)

Accepts any client pair an influencer pastes and records the client ID (never the secret). A client ID shaped like a real one (or the fixture) is
known, anything else is `invalid_client` (not found); a secret of `bad-secret` (or starting `bad-secret-`, which passes the 20-character format
check) is `invalid_client`; a made-up code with an accepted pair is `invalid_grant`; codes and refresh tokens only work with the client they were issued
to. `npm run dev:mock` sets `GOOGLE_CLIENT_MODE=own`.

## 4. Deviations from the brief, with reasons

1. **Connect with no client is a redirect, not a 409.** `/api/google/connect` is a browser navigation: a JSON 409 page would be a dead end. It redirects back
   to the page with `?google=no-client` (the existing pattern for `not-configured`), and starts nothing. The UI does not even offer the link.
2. **The card endpoints are `/api/dashboard/google-client`, not an extension of `/api/dashboard/google`.** The old route's disconnect test mocks the
   token module with a fixed export list; a separate route leaves `GET`/`DELETE /api/dashboard/google` byte for byte as they were.
3. **The credential functions keep their old call shapes.** `buildAuthUrl`, `exchangeCode` and `refreshAccessToken` take the influencer's credentials or
   grant as an optional last argument; without it they use the shared pair from the environment (what many existing tests do). Every production caller passes it.
4. **Existing grants with `client_kind = platform` keep working in mode `own`** while the shared pair is still configured: the grant was issued by that client.
   Remove the pair from the environment and they become unrefreshable (transient, shown by the health log) until the influencer reconnects with their own.
5. **The `bad-secret` rule also covers `bad-secret-...`** because the app's own format check (20 characters) would refuse the 10-character `bad-secret` before Google
   (or the simulator) is ever asked.
6. **Removing or replacing a client needs a recent password entry** (`requireRecentAuth`), stricter than the brief's `requireApiAuth`: it takes a secret in or a
   connection down, like Disconnect.
7. **Approving a booking request returns the pay link when the customer could not be e-mailed** (not in the brief): the approval flow used to depend on e-mail
   only, so with no Gmail and no platform e-mail an approved customer would wait for a link that never comes.
8. **Existing assertions that changed** (each with a comment in the test): the session endpoints' key sets and the settings, onboarding, admin influencer,
   moderation-status and admin-security key sets gained `emailEnabled` / `googleClient` / `googleClientSaved`; the Google health test that said "no
   `GOOGLE_CLIENT_ID` means no scheduling" now says the check runs; the env "advisory warnings" test expects the shared-pair warning in mode `platform`; the
   find-your-bookings page test holds a session answer; `tests/google-connect.test.ts` sets `GOOGLE_CLIENT_MODE=platform` for its database-free route tests;
   `spa-smoke.mjs` expects `emailEnabled` in the session answers.

## 5. How an influencer sets it up, end to end

1. Register. With no platform e-mail, an administrator verifies the account (admin influencer page, "Mark email verified").
2. Settings, Google Calendar card (or onboarding step 4). Step 1 is a numbered guide: create a Cloud project; enable the Google Calendar API (and the Gmail API
   for e-mail from their Gmail); OAuth consent screen, External, app name, their e-mail; scopes `calendar.events`, `gmail.send` (optional), `openid`, `email`; add
   themselves as a test user; **Publish app** ("In production": no verification is needed for personal use, they see an "unverified app" warning once, and the weekly
   expiry of Testing mode is gone); Credentials, OAuth client ID, Web application, with the site origin and the exact redirect URI (both with copy buttons).
3. Step 2: paste the Client ID and Client Secret, **Save and check**. Google's answer is shown precisely; only an accepted pair is saved, encrypted.
4. Step 3: tick or untick "allow sending customers' e-mails from my Gmail", **Connect Google Calendar**, allow it on Google's screen.
5. Replace and Remove sit on step 2, each with a confirmation that says what stops working.

## 6. What the owner sets on the VM

```
GOOGLE_CLIENT_MODE=own        # or leave empty; GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET can be removed
EMAIL_PROVIDER=none           # RESEND_API_KEY, POSTMARK_SERVER_TOKEN, EMAIL_FROM are not needed
APP_URL=https://<your domain> # the redirect URI every influencer adds is <APP_URL>/api/google/callback
```

Run `npx prisma migrate deploy` (the migration is additive). Start-up prints one warning that the platform sends no e-mail, and nothing about Google.
Expect: new accounts wait for "Mark email verified"; a forgotten password needs "Create password reset link"; customers get e-mail only from hosts who
connected Gmail (everyone else is reached by WhatsApp or SMS and on the booking pages).

## 7. Not checked

- Nothing here was run against real Google: no real consent screen, no real "unverified app" warning, no real Meet link, no real Gmail send. The simulator proves the
  app's side only (doc/11). The exact wording of Google Cloud's consoles changes: the guide names the pages the way Google did at the time of writing.
- One test run of `tests/email-none.test.ts` reached Google's real token endpoint once, with made-up credentials, before the test installed its fake fetch early
  enough (an import order mistake, fixed in the same commit); Google answered `invalid_client` and nothing was granted or stored.
- Not tested in a browser: the Onboarding wizard step itself (the card is the same component as in Settings and is covered by the view tests), Safari and Firefox.

