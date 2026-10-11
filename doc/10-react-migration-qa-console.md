undefinedundefinedundefinedfixed (b3c9f2d) |undefinedundefinedundefinedfixed (b3c9f2d) |undefinedundefinedundefinedfixed (b3c9f2d) |undefinedundefinedundefinedfixed (b3c9f2d) |undefinedundefinedundefinedfixed (b3c9f2d) |undefinedundefinedundefinedfixed (b3c9f2d) |# React SPA migration: QA of the signed-in half (influencer dashboard and admin console)

Branch `fix/qa-console`. Scope: the influencer dashboard (including the Google Calendar and WhatsApp connection screens,
exercised against the local provider simulator) and the admin console, all run together for the first time in PRODUCTION
mode with `SPA_GROUPS=all`. The customer-facing pages (public, auth, booking) are another engineer's job and are not covered.

How it was run: `npm run build`, then `next start -p 3191` with `SPA_GROUPS=all DATABASE_POOL_MAX=2 RATE_LIMIT_STORE=memory
ALLOW_INSECURE_LOCAL_RUN=true ADMIN_REQUIRE_2FA=false PAYOUT_FOUR_EYES=true` (the shared admins have no 2FA, so the production
default of forced 2FA was switched off for the shared-admin walk-through, and switched on for the throwaway-admin 2FA checks);
the connection screens ran under `npm run dev:mock` (the mock refuses production by design, see "Environment notes").
Browser: the Browser pane, desktop width and 375 px. Data: the seeded `demo` influencer plus a throwaway influencer; every row
created for the checks had a `QAC...` or `qa-console-...` marker and was deleted afterwards (see the end of this file).

## Findings

Severity: high = a screen or flow is broken or unsafe; medium = wrong or misleading behaviour a user would hit;
low = rough edge, cosmetic or defence in depth.

| Id | Sev | Where | Finding | Status |
|---|---|---|---|---|
| C1 | low | `GET /api/dashboard/google`, `/payout-account`, `/whatsapp`, `/bookings/:id`, `/api/auth/sessions` | These five pre-existing GET endpoints answer with NO `Cache-Control` (the new view endpoints send `private, no-store`); their 401/404 bodies and the earnings CSV (`no-store` only) are inconsistent too. Repro: `curl -i` each with a session cookie. | open |
| C2 | medium | dashboard, any action taken inside the booking drawer or a dialog | `ToastProvider`'s `.toasts` container lives outside the modal `<dialog>`: while the Sessions drawer or a confirm dialog is open it is covered by the top layer and inert (not exposed to assistive technology either). At 375 px the drawer is full width, so "Link sent again.", "Booking moved." and every error toast are invisible and not announced. Repro: 375 px, open a booking, Resend link. | open |
| C3 | low | `components/app/OnboardingWizard.tsx` step 7 | "The page goes live for customers as soon as you confirm your email." is wrong when another required step (Google Calendar) is still open, and contradicts the checklist printed right above it. | open |
| C4 | low | Settings, Signed-in devices | After "Change password" (toast: "Other devices were signed out.") the device list is not reloaded: the revoked device is still listed and its "Sign out" button answers "Session not found". | open |
| C5 | low | `/api/slots/days` and `/api/slots` (`loadBookableService`) | An influencer who hides a service (switch "Bookable" off) can no longer move that service's existing bookings: the reschedule picker shows a calendar with every day disabled and no explanation (the API answers 404 "Service not found"). | open |
| C6 | low | refund error toast | A Razorpay refund failure is shown as the raw response body: `Razorpay did not accept the refund: Razorpay refund failed (404): {  "message":"no Route matched with those values"}`. | open |
| C7 | info | every post-mutation refresh | When the refetch after a mutation fails (500 from a pool timeout, which happened during this run), the screen keeps the old data without any signal while the success toast already said "Saved" (design decision D21 keeps stale data on a failed refetch). Seen with "Copy to weekdays" in the onboarding wizard: the server had the five weekdays, the screen showed one. | not fixed (design) |
| C9 | low | admin Influencers search | The search box and the whole list were replaced by a skeleton while the next search loaded (no keepPreviousData, unlike every other list page), focus was lost, and nothing announced the result. | fixed (b3c9f2d) |
| C10 | high | every dashboard and console page at 375 px | The page scrolled sideways: `.shell` used `grid-template-columns: 1fr`, a track that grows to the min-content width of its widest child, and Payments has six nowrap tabs (Payments, Payouts, Bookings measured 832 to 866 px wide, Availability 552, Settings 440). Repro: any of those pages at 375 px, `document.documentElement.scrollWidth`. | fixed (b3c9f2d) |
| C11 | medium | bottom navigation on a phone | The bar had five slots for nine sections: an influencer on a phone could not open Customers, Earnings, Payouts or Messages, and an administrator could not open Bookings, System health or Audit log (the only way was typing the URL). | fixed (b3c9f2d, layout of the More list: next commit) |
| C8 | low | WhatsApp card, not connected (Settings and onboarding step 5) | The badge "Required to message by WhatsApp" next to "Not connected" reads as "required", while the page says "Recommended, not required: without it they are messaged by SMS". | open |

## Environment notes (not defects)

- The Browser pane is shared with other agents and cookies are per HOST, not per port. `127.0.0.5` (another engineer's alias) or
  any other loopback alias cannot be used for the app under test: the proxy's Origin check compares the request's origin with
  `req.url` (which Next normalises to `localhost`) and `APP_URL`, so POSTs from `http://127.0.0.7:3191` answer 403 "Cross-site
  request blocked". `APP_URL` itself must be `localhost`, `127.0.0.1` or `[::1]` for `ALLOW_INSECURE_LOCAL_RUN`.
- The shared database answered slowly while other test suites ran (single API calls between 0.5 s and 14 s); screens were
  therefore watched until they settled, and "slow" was only called a defect where the app itself did extra work.
