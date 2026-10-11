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
| QA-3 | low | every SPA page after an in-app navigation | The head tags the shell wrote for the page that was loaded first (canonical, description, Open Graph, `robots`) stay in the document when the user navigates inside the SPA (only `<title>` follows). Crawlers and link-preview bots load each URL fresh and get the right head, so only a JS-rendered second page view is affected. | not fixed (listed) |
| QA-4 | low | `/design` in a production build without `ENABLE_DESIGN_PAGE` | The router has no `design` route, so the SPA matches `/:slug` and asks `/api/public/profiles/design` (a 404 in the console) before showing the 404 view. The server already answers 404 with `noindex`. | not fixed (cosmetic) |
| QA-5 | low | `/reset-password?token=<fewer than 10 characters>` | The API validates the length first, so a truncated token shows "Please check the highlighted fields." with nothing highlighted instead of "This reset link is invalid or has expired". | not fixed (a real token is 43 characters) |
| QA-6 | low | `/pay/<token>` of an approval booking the customer later cancelled | Shows "This request was not accepted" (state `declined` is used for every CANCELLED booking). | not fixed (wording, old behaviour) |
