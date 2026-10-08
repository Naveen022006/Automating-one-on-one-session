# Session Automation

See `doc/` for the plan. Phases 1 (booking and slots), 2 (Razorpay payments), 3 (Google Meet links) and 6
(groups and dashboard) are implemented. Group sessions share one Google Meet event (one event per session, every
paid attendee added to it and given the same link), and the influencer dashboard plus customer self-service are
in place (see the Phase 6 section below).

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

## Dashboard and self-service (Phase 6)
There is no login yet, so each flow is reached by a signed, expiring link (`lib/signing.ts`), each with a
distinct purpose string so a link for one use can never be replayed for another.

1. **Influencer dashboard.** Generate the link and send it to the influencer:
   `npm run dashboard:link -- demo [days-valid]`
   It opens upcoming/past sessions, earnings (sum of captured payments, total and per service), and the latest
   message status per booking. From there the influencer can manage services, weekly availability and blocked
   days, and run per-booking manual actions:
   - **Resend link** re-sends the confirmation (and records a `Message`), without creating a new event.
   - **Cancel** marks the booking `CANCELLED`, updates the Calendar event (a 1:1 event is deleted; a group
     attendee is removed from the shared event, which is deleted only once the last attendee leaves), re-notifies
     the customer, and flags the payment `needsRefund` if money was captured.
   - **Reschedule** moves the session and patches the Calendar event start/end (`sendUpdates=all`), then
     re-notifies.
   An invalid/expired `?t=` token returns 403 before any data loads. Mutating routes under `/api/dashboard/`
   verify the token and that the target belongs to that influencer (403/404 otherwise).
2. **Blocked days.** A day the influencer blocks produces no bookable slots in `/api/slots` and is refused by the
   hold endpoint.
3. **Customer self-service.** The confirmation email contains a `/manage/<token>` link (signed with the
   `customer-self-service` purpose, distinct from the dashboard link). The customer can reschedule (pick a new
   slot) or cancel their own booking; an invalid/expired link shows a friendly 403. These routes verify the
   self-service token (never the dashboard token) and call the same cancel/reschedule logic.
