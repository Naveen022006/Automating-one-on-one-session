# 15. Influencer-owned Google credentials and the no-platform-e-mail mode

Status: inventory first (this commit), implementation in the commits after it. The owner's decisions:

1. There is no platform-wide Google app. Every influencer creates their OWN Google Cloud OAuth client, pastes its Client ID and
   Client Secret on their Settings page, and connects Calendar (and optionally Gmail) with it.
2. The platform sends no e-mail of its own for now (no Resend or Postmark). Customer e-mails go only through the influencer's own
   connected Gmail. Production must be allowed to run with no platform e-mail provider.

Section 1 lists every place that touches Google client credentials, section 2 every place that sends or promises e-mail, each with
the decision. Sections 3 onward are filled in as the work lands (design, deviations, setup guide, what was not checked).

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

## 3. Admin tools so nobody is locked out without e-mail

`POST /api/admin/influencers/[id]/verify-email` and `POST /api/admin/influencers/[id]/reset-link` (details in the sections added with
the implementation).
