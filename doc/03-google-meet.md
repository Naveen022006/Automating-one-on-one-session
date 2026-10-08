# Phase 3 — Google Meet Links

## Goal
After payment, a Meet link is created automatically on the influencer's calendar.

## Tasks
- [ ] Google Cloud project: enable Calendar API, create OAuth client
- [ ] Influencer connect flow: `/api/google/connect` -> consent -> `/api/google/callback`
- [ ] Store refresh token encrypted in `google_tokens`
- [ ] Worker job `create-meeting`:
  - `events.insert` with `conferenceDataVersion=1` and `createRequest` (type `hangoutsMeet`)
  - Add customer email as attendee, `sendUpdates: "all"`
  - Save `event_id` and `meet_link` on the booking, status `scheduled`
- [ ] Enqueue `send-message`
- [ ] Handle token expiry/revocation: mark influencer as "reconnect needed", alert them

## Key rules
- Use the influencer's own OAuth — a service account cannot create Meet links for personal Gmail.
- Make the job idempotent: if the booking already has an `event_id`, do nothing.
- Free Gmail group calls are limited to 60 minutes.

## Done when
A paid test booking produces a calendar event with a working Meet link and the customer receives the Google invite.
