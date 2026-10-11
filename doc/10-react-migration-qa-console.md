# React SPA migration: QA of the signed-in half (influencer dashboard and admin console)

Branch `fix/qa-console`. Scope: the influencer dashboard (including the Google Calendar and WhatsApp connection screens,
exercised against the local provider simulator) and the admin console, all run together for the first time in PRODUCTION
mode with `SPA_GROUPS=all`. The customer-facing pages (public, auth, booking) are another engineer's job and are not covered.

How it was run: `npm run build`, then `next start -p 3191` with `SPA_GROUPS=all DATABASE_POOL_MAX=2 RATE_LIMIT_STORE=memory
ALLOW_INSECURE_LOCAL_RUN=true ADMIN_REQUIRE_2FA=false PAYOUT_FOUR_EYES=true` (the shared admins have no 2FA, so the production
default of forced 2FA was switched off for the shared-admin walk-through and switched on, with a throwaway admin, for the 2FA
checks). The connection screens ran under `npm run dev:mock` (`next dev` plus the mock on port 4110, `READINESS_BYPASS=false` so
the go-live rules were the production ones, NO worker): the mock refuses production by design, so the Google and WhatsApp
screens were not exercised on `next start`. Browser: the Browser pane, desktop width and 375 px. Data: the seeded `demo`
influencer (fixtures named `QAC<run>...`) and a throwaway influencer `qa-console-a-...`; every row created for the checks is
listed under "Clean-up" at the end.

## Findings

Severity: high = a screen or flow is broken or unsafe; medium = wrong or misleading behaviour a user would hit;
low = rough edge, cosmetic or defence in depth. Every fix has a test in `tests/qa-console.test.ts` (or the file named).

| Id | Sev | Where | Finding | Status |
|---|---|---|---|---|
| C10 | high | every dashboard and console page at 375 px | The page scrolled sideways: `.shell` used `grid-template-columns: 1fr`, a track that grows to the min-content width of its widest child. Payments has six nowrap tabs: Payments, Payouts and Bookings measured 832 to 866 px wide (the stacked card layout of the tables never fitted), Availability 552, Settings 440. Repro: any of those pages at 375 px, `document.documentElement.scrollWidth`. | fixed `b3c9f2d` (`minmax(0, 1fr)`); after it every dashboard and console route measured 375 px with nothing outside a scroller |
| C11 | medium | bottom navigation on a phone | The bar had five slots for nine sections: an influencer on a phone could not open Customers, Earnings, Payouts or Messages, and an administrator could not open Bookings, System health or Audit log (only by typing the URL). | fixed `b3c9f2d` + `a2d22de`: four slots plus a "More" list (closes on choice, Escape, outside press and route change; "More" is marked current when one of its sections is open) |
| C2 | medium | every action taken inside the booking drawer or a dialog | `ToastProvider`'s `.toasts` stack lives outside the modal `<dialog>`: while the Sessions drawer or a confirm dialog is open the stack is covered by the top layer and inert, so it is neither visible nor announced. At 375 px the drawer covers the screen: "Link sent again.", "Booking moved." and every error from inside it vanished (measured: `elementFromPoint` on the toast returned the drawer footer). | fixed `b3c9f2d`: every open Dialog and Drawer carries its own stack; verified at 375 px that the toast is the topmost element |
| C14 | medium | Settings, "Switch account" (Google) | A confirmed switch to another Google account overwrote the stored refresh token, so the OLD account's grant stayed authorised at Google with nobody able to use or revoke it (the mock showed it `active` after the switch; Disconnect does revoke). | fixed `c263bd5`: the old grant is read first and revoked after the new connection is saved (skipped for the same account and while another profile uses the old one); verified in the mock |
| C18 | medium | Settings, WhatsApp "Check template status" | With a token Meta no longer accepts, the server marked the connection as needing a reconnect but the card kept saying "Ready" until a reload, and the toast read "Meta rejected that access token. Check it is a permanent token..." (a sentence for the connect form; nobody pasted a token). | fixed `d383b91`: the card reloads after a refused refresh and the message says to use Reconnect |
| C13 | medium | return from Google (Settings) | Google returns to `/dashboard/settings?google=<outcome>`; the outcome banner sits inside the Google card, below the profile and address cards, so on a normal screen the influencer saw the top of the page and nothing that said "connected" or "access was not granted". | fixed `348ec80`: `outcomeTarget` keeps a `#fragment`, both Google routes put it on the redirect, Settings asks for `#google` (HashScroller scrolls once the data is in) |
| C1 | low | `GET /api/dashboard/google`, `/payout-account`, `/whatsapp`, `/bookings/:id`, `/api/auth/sessions` | Five older GET endpoints answered with NO `Cache-Control`; their 401/404 bodies and the earnings CSV (`no-store` only) were inconsistent with the new view endpoints (`private, no-store`). | fixed `b3c9f2d`: `next.config.ts` sets it for `/api/dashboard/*`, `/api/admin/*`, `/api/auth/*`; sweep re-run: every anonymous, influencer and admin answer carries it |
| C3 | low | onboarding step 7 | "The page goes live for customers as soon as you confirm your email." was wrong while Google Calendar (required) was still open, and contradicted the checklist above it. | fixed `b3c9f2d` ("Customers cannot see your page until you confirm your email.") |
| C4 | low | Settings, Signed-in devices | After "Change password" ("Other devices were signed out.") the device list still showed the revoked device and its "Sign out" answered "Session not found". | fixed `b3c9f2d`: the list reloads after the change and a vanished device is not an error |
| C5 | low | `loadBookableService` (`/api/slots`, `/api/slots/days`) | An influencer who hides a service (switch "Bookable" off) could no longer move that service's existing bookings: the reschedule picker showed every day disabled, no explanation (API 404). | fixed `b3c9f2d`: the owner can read the slots of their own hidden service, nobody else can |
| C6 | low | refund and reconcile error toasts | A Razorpay failure was shown as the raw (cut off) response body: `Razorpay refund failed (404): {  "message":"no Route matched..."}`; "Reconcile" showed `{"error":{"code":"BAD_REQUEST_ERROR","description":"The id provided does not exist","source":...`. | fixed `b3c9f2d`: `razorpayErrorText` shows the description |
| C8 | low | WhatsApp card, not connected | The badge "Required to message by WhatsApp" next to "Not connected" read as "required" while the page says "Recommended, not required". | fixed `d383b91` ("Recommended", as the go-live checklist) |
| C9 | low | admin Influencers search | The search box and the list were replaced by a skeleton while the next search loaded (no `keepPreviousData`, unlike every other list), focus was lost, nothing announced the result. | fixed `b3c9f2d`: `keepPreviousData`, `aria-busy`, a status line, the box is a `GetForm` |
| C12 | low | admin two-factor | One sentence for every wrong code: "Check the code in your authenticator app, or use a recovery code." While turning 2FA on no recovery codes exist yet, and at sign-in with a recovery code the app is the wrong place to look. | fixed `348ec80` ("That code is not correct. Check it and try again.") |
| C15 | low | dashboard attention list | "Google stopped accepting the connection: Refresh token rejected: Token has been expired or revoked.. Paid bookings..." (doubled full stop). | fixed `c263bd5` |
| C16 | low | WhatsApp manual connect form | Empty fields showed zod's defaults ("Too small: expected string to have >=5 characters", ">=20 characters"). | fixed `d383b91`: the schema says what to enter |
| C19 | low | WhatsApp card, templates not submitted | "Could not submit: booking-confirmation, reminder-24h, reminder-15m, reschedule, cancellation" (internal keys) above a table that says "Booking confirmation", "Reminder, 24 hours before". | fixed `e0ae789`: one shared label map |
| C7 | info | every post-mutation refresh | When the refetch after a mutation fails (500 from a connection-pool timeout, which happened repeatedly on the loaded shared database), the screen keeps the old data and says nothing, while the success toast already said "Saved" (design decision D21: a failed refetch keeps the stale data). Seen with "Copy to weekdays" in the onboarding wizard: the server had five weekdays, the screen one, until the next refetch. | not fixed (design); a toast such as "Saved, but the page could not refresh" would be the follow-up |
| C17 | info | WhatsApp templates, rejected | The reason is Meta's raw code (`INVALID_FORMAT`) next to "Rejected". | not fixed (the real codes were not available to map them) |

## What was walked and what held

- `node scripts/spa-smoke.mjs http://127.0.0.1:3191` with `SPA_GROUPS=all`: 208 passed, 0 failed (before and after the fixes).
- Authorization sweep (`/api/dashboard/*`, `/api/admin/*` GET, 29 URLs) signed out, as an influencer and as an administrator:
  signed out every one answers 401 (the two session endpoints answer 200 `authenticated:false`); the influencer cookie gets 401 on
  every admin route and the admin cookie 401 on every dashboard route; no data in any wrong-role answer. Every answer now carries
  `Cache-Control: private, no-store` (C1). The earnings CSV neutralises `= + - @` cells.
- Dashboard (production, `SPA_GROUPS=all`): direct load and in-app navigation of every route; one API call per page (two for
  Settings) and none while idle (87 s on Sessions, 61 s on the admin Health page). Sessions drawer: Resend link, Cancel (credits a
  refund-due flag and emails), Refund through the re-authentication dialog (wrong password message, then retry), Reschedule picker
  (time moved, customer emailed), Approve and Decline of requests, deep link `?booking=`; Customers search and Erase; Earnings range
  and CSV; Messages filters; Services create, edit (approval, questions with choices), hide and show; Availability weekly hours,
  copy to weekdays, blocked day; Payout details with validation and the security e-mail in the log; Settings profile, slug dialog,
  notifications, password change, devices, log out everywhere; onboarding all seven steps and the go-live checklist.
- Connections (dev + mock): see the next section.
- Admin console: login (wrong password x5 then the 15-minute lockout message), Overview, Influencers (search, detail: reveal is
  audited, fee, payout details "Needs correction" with reason), Payments (tabs, reconcile with made-up ids shows the failure
  toast), Payouts (one administrator creates, the other approves, "Mark as paid" with a UTR, counts follow), Bookings, System
  health (Refresh refetches `/api/admin/health`, the worker heartbeat is live), Audit log paging, Security, Settings (wrong
  current password, too-short new password, change). 2FA with `ADMIN_REQUIRE_2FA=true` and a throwaway administrator: the console
  is closed except Security, enrolment (secret, otpauth link, wrong code, confirm, recovery codes), sign-in with a TOTP code, with a
  recovery code, the 15-minute lock after wrong codes; enrolling ends the administrator's other (password-only) sessions, so the
  "verify" gate state is not reachable from a browser and stays covered by `tests/spa-admin-security.test.ts`.
- Keyboard: Enter on a Sessions row opens the drawer, focus starts on Close, Tab cycles inside it and never leaves, Escape closes
  and focus returns to the row. The route announcer announces the new title. `FocusOnNavigate` needs a visible tab (it waits for
  `requestAnimationFrame`), so focus moving to `main` after a route change could not be observed in the hidden Browser pane.
- Sizes of `web/dist` (gzip): entry 71 kB, shared chunk 52 kB, largest page chunk ServicesManager 27 kB; every other chunk under
  10 kB.

## Connection screens (provider simulator)

All of this ran against `npm run dev:mock` (no worker), on a throwaway influencer. The mock proves the app's side only
(`doc/11-provider-simulator.md` section 7.2): real consent screens (unverified-app warning, restricted `gmail.send`), real Meta
review times and outcomes, the real Embedded Signup dialog and its message format, real error texts other than 190/10/133005/133008
and webhook delivery through a public URL are NOT proven.

- Google, Settings and onboarding step 3: connect through the mock consent page with both permissions ("Connected as ... Gmail
  on"), with Gmail unticked ("connected-no-gmail" banner, "Gmail off", "Send from my Gmail instead"), Cancel ("denied"), Calendar
  unticked ("missing-permission", the unwanted grant is revoked in the mock). Disconnect and Switch dialogs without upcoming
  bookings (no stranded-events text) and with one (the text names the account; `DELETE` answers 409 `needsConfirmation` without
  `confirm`, `switch=1` without `confirm=1` redirects with `confirm-switch`, a different account without the switch flag is
  `switch-unconfirmed` and its grant is revoked). "Reconnect needed": the mock fault `google.refresh=invalid_grant` plus cancelling
  a booking that has an event flips the connection; the card ("Google stopped accepting the connection for ... Your booking page is
  offline until you reconnect"), the Overview checklist ("Needs action"), the attention list and the sidebar badge all say so, a
  stranger gets 404 for the booking page, the owner a preview with the blocker; reconnecting makes it live (200) again.
- WhatsApp manual form: empty (plain-language messages after C16), a 1-day token ("expires in 24 hour(s)"), a garbage token, a phone
  number that does not belong to the account (Meta's own sentence is passed through, `WhatsApp said: Unsupported get request...`),
  success. Template card: "In review" for all five, then "Approved" and "Ready" after the mock's signed webhooks; a name
  conflict ("Name already used" with the instructions), a rejection and a pause delivered as webhooks; "not submitted" with the
  fault `meta.templates=10` and the resubmission ("Submitted 5 template(s) to Meta."); the number already having a PIN (133005):
  the PIN field and "I don't have it, reset it for me", then a successful reconnect; a PIN-locked number (133008); revoked token
  and the "Reconnect needed" state with the Reconnect button that reopens the connect options; reconnect after Disconnect.
- Embedded Signup: the mock SDK loads and `FB.login` runs. The Browser pane opens `window.open` in the SAME tab, which loses the
  opener, so the dialog could not complete on its own. It was driven the way the SDK expects instead: `window.open` was replaced by
  a stub that captured the dialog URL and returned `window`, the real mock dialog was completed in a second tab (its page ran the
  mock's own finish handler) and the `postMessage` it would send was dispatched into the app tab with the dialog's origin and the
  session id. The component, `connect-embedded` and the PIN prompt ran for real; only the cross-window message hop is simulated.
  The component logic of that hop is also in `tests/whatsapp-connect.test.ts` (54 tests, pass).
- What the mock's inbox pages showed: the Gmail page listed the confirmation sent from `creator@mock-google.invalid` after the
  fault was cleared (and nothing while `google.gmail=403_accessNotConfigured` made the app fall back to the platform sender, with
  the Settings card then saying "Gmail not working"); the Meta page listed the five submitted templates per account and their
  states; the Webhooks page listed the signed template deliveries answered 200. The Google calendar page stayed empty: events are
  created by the worker's `create-meeting` job, which was not started (shared database); that path is covered by
  `tests/mock-providers-meeting-db.test.ts`.

## Environment notes (not defects)

- The Browser pane is shared with other agents and cookies are per HOST, not per port. Another engineer used `127.0.0.5` for the
  same reason; that alias cannot be used for the app under test: the proxy's Origin check compares the request's origin with
  `req.url` (which Next normalises to `localhost`) and `APP_URL`, so POSTs from `http://127.0.0.7:3191` answer 403 "Cross-site
  request blocked". `APP_URL` itself must be `localhost`, `127.0.0.1` or `[::1]` for `ALLOW_INSECURE_LOCAL_RUN`. This work used
  `127.0.0.1`.
- Same normalisation: with the app on `127.0.0.1`, every redirect a route handler builds from `req.nextUrl` (the Google connect and
  callback routes, the proxy's login redirect) lands on `localhost:3191`, a different cookie jar. A deployment on a real domain is
  not affected (plan deviation D19 explains the cause). The Google outcome banners were therefore checked by loading
  `?google=<outcome>` on the right host and by reading the `Location` header of each hop.
- The shared database answered slowly while other test suites ran (a trivial query took 1 to 6 s, single API calls 0.5 to 14 s,
  and pool timeouts caused 500s). Screens were watched until they settled; nothing was called slow unless the app itself did extra
  work.
- A hidden Browser pane cannot draw frames: screenshots sometimes time out and real key presses needed a retry.

## Clean-up

(filled in at the end of the run)
