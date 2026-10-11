# React SPA migration: QA of the signed-in half (influencer dashboard and admin console)

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
| (filled in below as the work goes on) | | | | |

## Environment notes (not defects)

- The Browser pane is shared with other agents and cookies are per HOST, not per port. `127.0.0.5` (another engineer's alias) or
  any other loopback alias cannot be used for the app under test: the proxy's Origin check compares the request's origin with
  `req.url` (which Next normalises to `localhost`) and `APP_URL`, so POSTs from `http://127.0.0.7:3191` answer 403 "Cross-site
  request blocked". `APP_URL` itself must be `localhost`, `127.0.0.1` or `[::1]` for `ALLOW_INSECURE_LOCAL_RUN`.
- The shared database answered slowly while other test suites ran (single API calls between 0.5 s and 14 s); screens were
  therefore watched until they settled, and "slow" was only called a defect where the app itself did extra work.
