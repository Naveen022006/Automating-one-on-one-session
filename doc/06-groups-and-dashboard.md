# Phase 6 — Groups and Dashboard

## Goal
Support small group sessions and give influencers control.

## Tasks
- [x] Group services: capacity, one shared Meet event per session
- [x] Seat counting inside a transaction so the session never oversells
- [x] Add each paid attendee to the same Calendar event and send the same link
- [x] Dashboard: upcoming sessions, past sessions, earnings, message status
- [ ] Manage services and availability, block dates
- [ ] Manual actions: resend link, cancel, reschedule
- [ ] Customer self-service page via a signed link (reschedule/cancel)
- [x] Email receipt/confirmation

## Key rules
- A group session is one event with many bookings; create the event once, then add attendees.
- Respect the Meet time limit on free Gmail accounts (60 minutes for group calls).

## Dashboard (read-only)
- Opened via a signed, expiring link (`npm run dashboard:link -- <influencer-slug> [days-valid]`), mirroring
  the Google connect link. There is no login yet, so possession of the link authorises viewing; an
  invalid/expired `?t=` token returns 403 before any data is loaded.
- Shows upcoming sessions, past sessions, earnings (sum of CAPTURED payments, total and per service), and the
  latest message status per booking, plus the shared group meet link.
- Read-only in this phase. The manual actions (resend link, cancel, reschedule) and management/self-service
  flows are the remaining Phase 6 tasks; the client component already receives the signed token and booking
  ids as seams so those can be attached without restructuring.

## Email receipt/confirmation
- `lib/email.ts` `sendBookingEmail(bookingId, kind)` renders a confirmation/receipt and records a `Message`
  row. Delivery is still a **structured-log stub** (no real SMTP): email and WhatsApp/SMS delivery remain
  stubbed pending Phases 4 (messaging) and 5 (reminders). The `Message` model gives the dashboard real
  per-booking message status to display in the meantime.

## Done when
Five customers can book one group session, all get the same link, and the influencer sees them in the dashboard.
