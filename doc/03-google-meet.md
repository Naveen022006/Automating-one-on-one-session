# Phase 3 — Google Meet Links

## Goal
After payment, a Meet link is created automatically on the influencer's calendar.

## Tasks
- [x] Google Cloud project: enable Calendar API, create OAuth client (setup steps in `README.md`; this is a manual console step)
- [x] Influencer connect flow: `/api/google/connect` -> consent -> `/api/google/callback`
- [x] Store refresh token encrypted in `google_tokens`
- [x] Worker job `create-meeting`:
  - [x] `events.insert` with `conferenceDataVersion=1` and `createRequest` (type `hangoutsMeet`)
  - [x] Add customer email as attendee, `sendUpdates: "all"`
  - [x] Save `event_id` and `meet_link` on the booking, status `scheduled`
- [x] Enqueue `send-message` (queue `messages`; the consumer is Phase 4)
- [x] Handle token expiry/revocation: mark influencer as "reconnect needed", alert them

## Key rules
- Use the influencer's own OAuth — a service account cannot create Meet links for personal Gmail.
- Make the job idempotent: if the booking already has an `event_id`, do nothing.
- Free Gmail group calls are limited to 60 minutes.

## Done when
A paid test booking produces a calendar event with a working Meet link and the customer receives the Google invite.

## Implementation notes
- **Idempotency beyond `event_id`.** The Calendar event id is `sha256("booking:<id>")` and the Meet `requestId` is
  the booking id. If a worker dies after Google created the event but before we saved it, the retry gets `409` and
  reads the existing event instead of creating a second one (and a second invite).
- **Connect link is signed.** There is no login until Phase 6, so `/api/google/connect` only works with a signed,
  expiring link (`npm run google:connect-link -- <slug>`). OAuth `state` is signed and bound to a cookie nonce (CSRF).
- **Failure handling.**
  | Situation | Result |
  |---|---|
  | Refresh token rejected (`invalid_grant`), Calendar 401, missing scope | Influencer flagged `RECONNECT_NEEDED`, alerted once, job stops without retrying, booking stays `PAID`. Re-queued automatically when they reconnect. |
  | Influencer never connected Google | Same, booking stays `PAID` with `last_error` set. |
  | Google 5xx / 429 / rate limit / Meet link still pending / network | Retried by BullMQ (5 attempts, exponential backoff). If all fail: `last_error` recorded, influencer alerted, booking stays `PAID`; the worker re-queues it on next start. |
  | Google rejects the request (e.g. invalid attendee), or the event was deleted | Booking -> `FAILED` (needs manual attention), influencer alerted. |
- **Alerts are a log line for now.** `lib/alerts.ts` exposes `setAlertSender`; Phase 4 plugs in WhatsApp/SMS/email.
- **Group services.** Phase 3 created one event per booking. **Phase 6 (implemented)** makes group sessions share one
  event per session: the id is `sha256("session:<id>")`, the first paid attendee's job creates the event (electing one
  creator via an atomic `sessions.event_id` null-guard, so concurrent payers cannot both create it), and every later
  attendee is added to that same event via `GoogleClient.addAttendee` (GET then PATCH with `sendUpdates=all`, deduped by
  email). The shared `event_id`/`meet_link` are stored on the session and copied onto each booking. 1:1 services are
  unchanged (one event per booking).
