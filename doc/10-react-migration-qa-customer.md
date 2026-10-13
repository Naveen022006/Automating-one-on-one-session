# React SPA migration: QA of the customer-facing half (`fix/qa-customer`)

Production build, `SPA_GROUPS=all`, `next start` on port 3181 (`APP_URL=http://[::1]:3181`, `ALLOW_INSECURE_LOCAL_RUN=true`,
`READINESS_REQUIRED=payout` so the seeded `demo` page is live in production mode, `RATE_LIMIT_STORE=memory`, pool 2), driven
through the Browser pane at `http://[::1]:3181` (its own cookie jar). Notes for whoever repeats this:

- The proxy's CSRF check compares `Origin` with `APP_URL` and with the request URL, in which Next rewrites `127.x`/`::1` to
  `localhost`. A browser at `http://127.0.0.5:3181` (or `*.localhost`) therefore gets "Cross-site request blocked" on every POST
  unless `APP_URL` is exactly that origin; `ALLOW_INSECURE_LOCAL_RUN` only accepts `localhost`, `127.0.0.1` and `[::1]` as `APP_URL`.
  Not a defect (a real deployment has `APP_URL` = its public origin), but it costs time.
- With `NODE_ENV=production` the `log` e-mail provider prints only the header of a message (no body, so no link): verification,
  reset and approval links were minted with a small script that uses the same token helpers (`lib/auth/tokens`, `lib/self-service`).
- The paid webhook was a correctly signed `payment.captured` POSTed to `/api/webhooks/payment` (the card form of the real Razorpay
  modal is a cross-origin iframe the browser tool cannot type into). The real modal was opened on `/demo/book` and on `/pay/<token>`.
- Another QA engineer covered the dashboard, connections and the admin console at the same time (same database, same demo host).

## Findings log

| Id | Severity | Where | What | Status |
|---|---|---|---|---|
| QA-1 | medium | `/:slug`, `/:slug/book`, `/pay/:token`, `/manage/:token`, first paint of every route | The loading skeleton and the failure alert (`QueryGate`, router `hydrateFallbackElement`) were drawn bare in the top-left corner of the window: no margins, no brand header, no `main#main` (the skip link and the focus move after a navigation had no target while loading). A failed profile load also left the previous page's title in the tab. Reproduce: load `/demo` on a slow connection, or make `/api/public/profiles/demo` answer 500. | fixed: `PublicPageFrame`, `QueryGate framed`, container around the router fallback, error title; test in `tests/spa-booking-pages.test.ts` |
| QA-2 | medium | booking flow (`BookingFlow`, shared with the old page) | A failed "Hold this time" (for example the required WhatsApp tick above the fold on a phone) changed nothing visible and left focus on the button; and every step change (Continue, Change time, Hold, paid) dropped keyboard focus to the top of the document. | fixed: focus goes to the first invalid field, and to the new step's heading after a step change; the opt-in error is tied to its checkbox with `aria-describedby` |
| QA-3 | low | every SPA page after an in-app navigation | The head tags the shell wrote for the page that was loaded first (canonical, description, Open Graph, `robots`) stay in the document when the user navigates inside the SPA (only `<title>` follows). Crawlers and link-preview bots load each URL fresh and get the right head, so only a JS-rendered second page view is affected. | fixed: `RouteHead` (web/src/lib/head.tsx) rewrites description, canonical, robots and the share card from `clientHeadFor` (lib/spa/routes.ts) after each navigation; profile and booking pages get the conservative `noindex` head (the bio and preview state are known only to the server) |
| QA-4 | low | `/design` in a production build without `ENABLE_DESIGN_PAGE` | The router has no `design` route, so the SPA matches `/:slug` and asks `/api/public/profiles/design` (a 404 in the console) before showing the 404 view. The server already answers 404 with `noindex`. | fixed: without `__DESIGN_PAGE__` the router maps `/design` to the 404 view directly, so no profile lookup is made |
| QA-5 | low | `/reset-password?token=<fewer than 10 characters>` | The API validates the length first, so a truncated token shows "Please check the highlighted fields." with nothing highlighted instead of "This reset link is invalid or has expired". | fixed on `fix/reset-token-message`: reset-password and verify-email accept any non-empty token and answer with the token's own message; `tests/auth-token-messages.test.ts` |
| QA-7 | medium | `GET /robots.txt` in any build made without `APP_URL` (the Dockerfile sets none) | `app/robots.ts` was statically generated, so the build machine's `APP_URL` was frozen into it: a deployed image told crawlers `Sitemap: http://localhost:3000/sitemap.xml`. The page head and `sitemap.xml` use the runtime value. Reproduce: build with `APP_URL=http://localhost:3000`, start with another `APP_URL`, `curl /robots.txt` (the build log lists the route as static). | fixed: `export const dynamic = "force-dynamic"`; `tests/spa-robots.test.ts` |
| QA-8 | medium | landing page `/` at 375 px (old Next page too: shared CSS) | The page scrolled sideways (content 407 px wide in a 375 px window; the layout viewport widened and the page rendered zoomed out on a phone). Cause: the table inside the dashboard mock of the fourth `.feature` block raised its grid item's minimum width in the single-column layout. | fixed: `.feature > * { min-width: 0 }` in `app/styles/layouts.css`; all other customer routes measured at 375 px have no horizontal overflow |
| QA-9 | medium | any page or dynamic API URL with a broken percent escape (`/%E0%A4%A`, `/api/pay/%E0%A4%A`, `/api/public/profiles/%E0%A4%A`) or a NUL byte (`/api/public/profiles/%00`) | HTTP 500 with no log line (Next's param decoding), and for `%00` a Postgres error (`invalid byte sequence ... 0x00`) in the log. Any scanner could fill the error monitoring with these. | fixed: `proxy.ts` answers 400 before routing; case added to `tests/spa-proxy.test.ts` |
| QA-10 | medium | every full page load (login and register redirects, the "Reschedule or cancel" link and any absolute link, typed URLs, bookmarks), and `/#hash` typed in a tab that had loaded the site | React Router keeps scroll positions per `location.key`, and every freshly loaded document has the key `default`, so the next document opened scrolled to where the previous one had been (verified: `/terms` scrolled to 700 px, then `location.assign('/privacy')` opened at 700 px) and a saved position (even 0) beat the `#hash`. On a phone this puts the top of the manage page or the dashboard off screen right after the link was tapped. | fixed: `ScrollRestoration getKey={scrollRestorationKey}` (`web/src/lib/scroll.ts`, fresh loads are keyed by their URL; reload still restores, in-app entries keep their unique key); `tests/spa-scroll.test.ts` |
| QA-11 | low | register form (`components/auth/AuthForms.tsx`) | Same gap as QA-2: a failed submit (local checks, or an answer such as "address taken") left focus on the button, the "terms" error had no icon, no `role="alert"` and no link to its checkbox, and the live "address is taken" message did not mark the input invalid. | fixed: first invalid field is focused, the terms error is announced and tied to its checkbox, the slug input follows the live answer; wiring test in `tests/spa-form-focus.test.ts` |
| QA-12 | low | a tab left open across a deploy (`vite:preloadError`) | The single reload the handler makes goes to the page the tab was ON, so the click that failed (for example "Messages" in the sidebar) is lost and the user lands where they were. A second failure within a minute shows the error screen with "Try again" (a full reload), no loop. Simulated by hiding a chunk file. | fixed: the event does not name a page, but `router.state.navigation.location` is the click's target while the chunk loads, so `recoverFromPreloadError` (web/src/lib/preload-recovery.ts) assigns that location instead of reloading; with no navigation in flight it reloads as before |
| QA-13 | low | booking flow, step "Pay" | If the server already ended the hold (clock skew, or the expiry job) the "Pay" button answers "This hold has expired or the booking is already processed" while the countdown keeps running and the button stays; the customer has to wait for the countdown or reload. The answer is ambiguous (expired, or paid in another tab), so it was not turned into the "Your hold has ended" screen. | fixed on `fix/pay-after-hold-ended`: after a 409 the page reads the booking's status (`checkoutRefusalOutcome`, `web/src/lib/checkout-refusal.ts`) and shows "Your hold has ended", confirms a payment made in another tab, or shows the failed state; anything else keeps the server's message; `tests/checkout-refusal.test.ts` |
| QA-14 | low | booking flow, any refresh while a slot is held | The flow lives in memory only: a refresh or a closed tab between "Hold this time" and payment loses it, and the same customer cannot take that slot again until the hold ends (10 minutes, 20 once the checkout started); the 409 message tells them to pick another time. Parity with the old page. | not fixed (product decision: resuming a hold needs the booking id and poll token kept somewhere) |
| QA-6 | low | `/pay/<token>` of an approval booking the customer paid and then cancelled (the link stays valid for the payment window) | Showed "This request was not accepted ... You have not been charged", which is false: the customer paid and a refund is due. State `declined` was used for every CANCELLED booking. | fixed: new state `cancelled` when the booking has a captured or refunded payment ("This booking was cancelled", refund depends on the policy, see the cancellation email); an unpaid cancelled booking stays `declined`; tests in `tests/spa-booking.test.ts` and `tests/spa-booking-pages.test.ts` |

## What was run (production build, `SPA_GROUPS=all`)

- `node scripts/spa-smoke.mjs`: 208/208 on the first build of `origin/main`, 211/211 on the last build of this branch.
- Public and auth routes (`/`, `/terms`, `/privacy`, `/refund-policy`, `/contact`, `/login`, `/register`, `/forgot-password`,
  `/reset-password?token=x`, `/verify-email?token=x`, `/design`, an unknown path, `/a/b/c`, `/demo`, `/demo/book`,
  `/demo/book?service=<id>`, an unknown slug, `/pay/bad`, `/manage/bad`): status, `<title>`, description, canonical, Open Graph,
  JSON-LD (landing), `robots` meta and `X-Robots-Tag`, `Referrer-Policy` on the token pages (header and meta), checked with curl on
  the raw HTML and in the browser by direct load, in-app link, hard reload and Back/Forward. The skip link is the first Tab stop,
  focus lands on `main` after an in-app navigation, the route announcer says the new title, cross-page `#hash` scrolling works (and
  works on a direct load since QA-10), unknown slug and `/a/b/c` are real HTTP 404 with the Not found view, a forced 500 shows the
  error alert with "Try again" and recovers, a render crash (invalid time zone value pushed into the select) shows the error page.
  No CSP violation and no console error other than the expected 4xx/5xx of the probes, on any page, including the real Razorpay
  modal on `/demo/book` and on `/pay/<token>`.
- F1: landing, demo profile, book (service preselected, time zone switch, month navigation, details, hold, countdown), real
  `POST /api/checkout` (Razorpay test order), real Razorpay modal, signed `payment.captured` webhook, "Confirming" then "You're
  booked" by polling, `.ics`, manage link, reschedule, cancel ("You are due a full refund; the host has been notified": the refund
  of the made-up payment id cannot be issued automatically). Two holds on the same slot at the same moment: exactly one 201, one 409.
- F2: request on an approval service, approve in the dashboard (the demo login of the shared dev logins), `/pay/<token>`, real
  Razorpay modal, simulated payment, the page switches to "You're booked" by itself and shows "already booked" on reload; declined,
  expired, invalid and cancelled-after-payment states. F9: owner preview of a page that is not live (200, `noindex`, no Open Graph,
  "Still to do" list, also on `/book`), stranger 404 on the page, the booking page and the API.
- F3 first half and F4: register (slug availability: free, taken, reserved), onboarding redirect, the dashboard gate (`/dashboard/*`
  goes to `/onboarding` for an account that has not finished), verify e-mail (logged in and logged out), forgot password, reset
  password (bad and good token), the `?reset=1` notice, login with `?next=` (an external or `//host` target is ignored), wrong
  password, logout, log out everywhere in a second tab and the first tab's next request going to `/login?next=...`, expired
  session cookie on a dashboard URL, Back after logout lands on the login page.
- Session cookie attributes on login: `__Host-sa_session; Path=/; Max-Age=2592000; Secure; HttpOnly; SameSite=lax`.
- Accessibility by inspection (no axe-core): tab order and focus styles on login, labels on every input of login, register and the
  booking form, heading and landmark structure of the landing page, text contrast computed for every text node of `/`, `/login`
  and the booking form with errors (no failure), `aria-invalid`/`aria-describedby` wiring, step changes (QA-2).
- Performance: see below.

## Performance

| | |
|---|---|
| Entry JS | `index` 227 kB (71 kB gzip) and the shared `SiteChrome` chunk 166 kB (52 kB gzip), CSS 37.6 kB (8.1 kB gzip) |
| Route chunks (gzip) | Landing 3.6 kB, Profile 1.3, Book 6.5, Pay 2.4, Manage 2.8, Login 0.4; the 93 kB `ServicesManager` is dashboard only and lazy |
| Fonts | latin subsets only on the pages seen: Inter 48 kB, Newsreader 58 kB (`font-display: swap`) |
| API calls on load | landing 1 (`/api/auth/session`), login and register 1 (+1 slug check per pause in typing), profile 1, book 3 (profile, days, slots), pay 1, manage 1 |
| Idle | `/demo/book` open for 69 s: no further request (no focus or interval refetch) |
| Assets | `Cache-Control: public, max-age=31536000, immutable`, gzip |
| TTFB | shell of routes without a lookup 3-25 ms; `/demo` and `/demo/book` 0.5-1.4 s (the shell looks the profile up, then the page asks `/api/public/profiles/<slug>` again, about 0.5 s each against the shared remote database) |

## Not fixed, listed

QA-3, QA-4, QA-12, QA-13, QA-14 above (QA-5 was fixed later). Also noted, not defects of the migration: a page-load waterfall (HTML, entry JS, page chunk,
API) that a `modulepreload` for the route chunk or an inlined profile in the shell would shorten; the booking flow's calendar has a
roving tabindex but the stepper scrolls sideways inside its row at 375 px; on a phone the booking summary card comes before the
calendar.

## Not checked

- A real card payment (the Razorpay card form is a cross-origin iframe the browser tool cannot type into), a real Meet link (the
  shared worker is not ours to run; the confirmation page stays at "Creating your Google Meet link"), a successful automatic refund,
  e-mail delivery (the log provider prints headers only in production mode).
- Network throttling (the Browser tools offer none: loading states were seen at their natural 1-2 s and with a delayed fetch),
  a screen reader, axe-core, Safari and Firefox.
- The dashboard, connections and the admin console (covered by the other QA engineer).

## Cleanup

Everything created for the runs was deleted: six bookings with their payments and sessions, the temporary approval service on
`demo`, four `webhook_events`, and the test influencer account (`qa-customer-reg-...`, with its user, tokens and sessions); a query
for `qa-customer*` e-mails, `qacust*` slugs, `QA Approval ` services and `evt_qa_*` events returns nothing. The Razorpay test orders
and the BullMQ `create-meeting` jobs the webhooks queued remain (they refer to bookings that no longer exist). The two processes
started for the runs (`next start` on 3181) were stopped.

## Review follow-up (Opus review of this branch)

| Id | Severity | Where | What | Status |
|---|---|---|---|---|
| M1 | medium | `PublicPageFrame` (QA-1) and `FocusOnNavigate` | The loading frame had its own `main#main`, so after an in-app navigation (for example `/pay/<token>` in the declined state, "Choose another time" to `/demo/book`) focus went to the frame; when the data arrived the frame was replaced and the focus fell to `<body>`. | fixed: the frame's `main` carries `data-placeholder`; `web/src/lib/focus-main.ts` (`realMain`, `focusWaitMs`) makes FocusOnNavigate skip a placeholder and keep watching for the real `main` (10 s while a placeholder is on screen, 3 s otherwise); `tests/spa-focus-main.test.ts`, the placeholder markers in `tests/spa-booking-pages.test.ts` |
| M2 | medium | `lib/views/booking-pay.ts`, `PayView` | A FAILED booking with a CAPTURED payment (amount mismatch, paid after the hold ended and the slot was taken, paid after the session started, calendar rejection of a PAID booking) fell through to `expired` ("the time to pay has passed... request again"), inviting a second payment; and the "depends on the cancellation policy" text was wrong for a payment that landed after a cancellation. | fixed: `paid` is computed before the status branches. New state `not-completed` ("Payment received, but your booking could not be completed. You will be refunded. Please do not pay again.", no ids, no pay button). State `cancelled` now carries `refund`: `issued`, `on-its-way` (flagged, part-refunded, also a late capture) or `none` (the policy gives none), each with its own text. Unpaid CANCELLED is still `declined`, unpaid FAILED still `expired`. Same view function for the old page and the SPA. Cases in `tests/spa-booking.test.ts` and `tests/spa-booking-pages.test.ts` |
| M3 | low | `/api/slots`, `/api/slots/days`, hold, checkout and every route that read a JSON body | `serviceId=%00` (or `\u0000` in a body field) reached Postgres, which refuses a NUL byte: a 500. | fixed: `readJson`/`containsNul`/`isEntityId` in `lib/http.ts` (all 15 `req.json().catch(() => null)` sites and `parseJson` use `readJson`), `serviceId`/`bookingId` must look like an id, `proxy.ts` also refuses `%00` in a query string; `tests/spa-input-validation.test.ts`, `tests/spa-proxy.test.ts` |
| M4 | low | `BookingFlow` | The step-heading focus ran on the page load in development (React StrictMode keeps the "mounted" ref across its double effect). | fixed: `headingToFocus(previousStep, step, requested)` compares with the step seen last (`components/ui/focus.ts`); test simulates the double pass |
| M5 | low | `web/src/lib/scroll.ts` | The `initial:<url>` scroll key is stored in sessionStorage for the life of the tab and held manage and pay tokens and `?token=`. | fixed: the token segment and the `token` parameter are left out of the key; `tests/spa-scroll.test.ts` |
| M6 | low | `app/robots.ts` | `Disallow: /design`, `/admin`, `/dashboard`, `/onboarding` (and the reset and verify pages) are prefixes: real profiles such as `design-with-asha` or `admin-academy` were never crawled. | fixed: exact forms (`/x$`, `/x?`) plus `/x/`, in `lib/robots-rules.ts`; the test runs a real list of URLs through a robots.txt matcher |
| M7 | low | `tests/spa-form-focus.test.ts`, `tests/spa-scroll.test.ts` | Tests that could not fail (source text matching, `!startsWith("w")`). | fixed: the focus rules are tested as functions, plus what a server render of `BookingFlow` shows; the useless scroll assertion is gone; mutation checks (placeholder marker removed, "compare with the previous step" removed) make the tests fail |

Note: `git fetch origin` and `git merge origin/main` found nothing to merge: `origin/main` and the local `main` are both at `c2b56fd`
(the simulator merge), which this branch already contains.
