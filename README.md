# Session Automation

See `doc/` for the plan. Phases 1 (booking and slots), 2 (Razorpay payments) and 3 (Google Meet links) are implemented.
Phase 6 is in progress: group sessions now share one Google Meet event (one event per session, every paid attendee
added to it and given the same link); the dashboard and manual actions are still to come.

## Run locally
1. Start Postgres and Redis, and set `DATABASE_URL` / `REDIS_URL` in `.env` (see `.env.example`).
2. `npm install`
3. `npx prisma migrate dev` then `npm run db:seed`
4. `npm run dev` and open http://localhost:3000/demo/book
5. `npm run worker` in a second terminal. It expires stale holds and processes the `create-meeting` queue
   (`npm run expire-holds` is the same command).
6. `npm test` (the hold/concurrency/payment tests need the database; the slot tests do not)

## Google Meet setup (Phase 3)
Meet links are created on the **influencer's own** Google Calendar (a service account cannot create Meet links for personal Gmail).

1. In Google Cloud Console: create a project, enable the **Google Calendar API**, configure the OAuth consent screen,
   and create an **OAuth client ID** (type *Web application*).
   Add `GOOGLE_REDIRECT_URI` (e.g. `http://localhost:3000/api/google/callback`) as an authorised redirect URI.
   While the consent screen is in *Testing*, add the influencer's Gmail as a test user. Note that Google expires
   refresh tokens for Testing apps after 7 days, so publish the app before going live.
2. Fill in `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI`, and generate `TOKEN_ENCRYPTION_KEY`
   and `APP_SECRET` with `openssl rand -base64 32`.
3. Generate the influencer's connect link and send it to them:
   `npm run google:connect-link -- demo`
   They open it, approve calendar access, and land on a confirmation page. (There is no login yet, so the signed,
   expiring link is what authorises connecting a calendar. The Phase 6 dashboard will replace it.)
4. Pay for a test booking. The webhook enqueues `create-meeting`; the worker creates the event, the customer gets
   Google's invite, and the booking becomes `SCHEDULED` with `event_id` and `meet_link` saved.

If Google rejects the influencer's token (revoked, expired), the influencer is flagged "reconnect needed" and
alerted (a structured log line until Phase 4 adds real delivery). Paid bookings wait as `PAID` and are re-queued
automatically once they reconnect through a fresh `google:connect-link`.
