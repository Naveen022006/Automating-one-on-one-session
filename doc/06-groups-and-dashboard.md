# Phase 6 — Groups and Dashboard

## Goal
Support small group sessions and give influencers control.

## Tasks
- [x] Group services: capacity, one shared Meet event per session
- [x] Seat counting inside a transaction so the session never oversells
- [x] Add each paid attendee to the same Calendar event and send the same link
- [x] Dashboard: upcoming sessions, past sessions, earnings, message status
- [x] Manage services and availability, block dates
- [x] Manual actions: resend link, cancel, reschedule
- [x] Customer self-service page via a signed link (reschedule/cancel)
- [x] Email receipt/confirmation

## Key rules
- A group session is one event with many bookings; create the event once, then add attendees.
- Respect the Meet time limit on free Gmail accounts (60 minutes for group calls).

## Dashboard (read-only)
- Opened via a signed, expiring link (`npm run dashboard:link -- <influencer-slug> [days-valid]`), mirroring
  the Google connect link. There is no login yet, so possession of the link authorises viewing; an
  invalid/expired `?t=` token returns 403 before any data is loaded.
- Shows upcoming sessions, past sessions, earnings (sum of CAPTURED payments, total and per service), and the
  latest message status **per channel** per booking (so a later queued WhatsApp row never hides an earlier
  failed email on the same booking), plus the shared group meet link.
- The client component also carries the signed token so the influencer management and manual actions below can
  call back without re-minting it.

## Manage services, availability and blocked dates
- The dashboard renders forms (built on the read-only seams) to add/edit/deactivate services, add/delete weekly
  availability rules, and block/unblock calendar days. They post to signed-token-gated routes under
  `/api/dashboard/`:
  - `POST|PATCH /api/dashboard/services` — create / update / (de)activate a service.
  - `POST|PATCH|DELETE /api/dashboard/availability` — create / update / delete a weekly `AvailabilityRule`.
  - `POST|DELETE /api/dashboard/blocked-dates` — block / unblock a day.
- Every mutating route verifies the **dashboard** token (same purpose as the dashboard page) and that the
  targeted service/rule/date belongs to that influencer, returning 403 (bad token) or 404 (not theirs). Bodies
  are validated with zod, matching `app/api/checkout` and `app/api/bookings/hold`.
- Editing a service cannot retroactively break the seat invariant the hold path relies on: the services PATCH
  route rejects (409) lowering `capacity` below the seats already sold on a live session, and rejects changing
  the service `type` while it still has sessions with live bookings.
- A `BlockedDate` (influencer + calendar day, stored at UTC midnight) produces **no** slots: `generateSlots` /
  `isSlotStart` take a set of blocked `YYYY-MM-DD` days (kept pure and unit-tested), and both `/api/slots` and
  the hold validation load the influencer's blocked days and pass them in, so a blocked day cannot be booked.

## Manual actions (influencer) and customer self-service
- Per booking the dashboard offers **Resend link**, **Cancel** and **Reschedule**, posting to
  `POST /api/dashboard/bookings/[id]` (dashboard-token gated; the booking must belong to the influencer).
- The same operations are exposed to the customer through a **separate** signed link. A booking confirmation
  email includes a self-service link (`/manage/<token>`) signed with a DISTINCT purpose
  (`customer-self-service`), so it can never be replayed as a dashboard token. `app/manage/[token]` verifies the
  token (invalid/expired → friendly 403), shows the booking, and offers Reschedule (new slot via `/api/slots`)
  and Cancel; its API routes verify the self-service token and call the same domain functions.
- The domain functions live in `lib/manage.ts`:
  - `resendBookingLink` — re-send the confirmation (email + queued message); no new event.
  - `cancelBooking` — set `CANCELLED`, update the Calendar event (**1:1** → delete it; **GROUP** → remove only
    that attendee from the shared event, deleting it only when the last attendee leaves, preserving the
    shared-event invariant), re-notify, and flag the payment `needsRefund` if it was `CAPTURED`.
  - `rescheduleBooking` — validate the new time the same way the hold path does (it must be a real slot start
    from the influencer's availability rules and not on a blocked day; `validateRescheduleTime` is pure and
    unit-tested), move the session to the new time under a `FOR UPDATE` lock that re-checks the session still
    fits the service capacity, PATCH the Calendar event start/end (`updateEvent`, `sendUpdates=all`), then
    re-notify. For a GROUP this moves the whole shared session, so each live attendee is re-notified with their
    own self-service link (one confirmation email per booking, by design).
- `lib/google.ts` gained `updateEvent` (events.patch new times), `removeAttendee` (drop one attendee from the
  shared event) and `deleteEvent`, all reusing `classifyCalendarError`. Calendar failures are best-effort: the
  DB change lands, the influencer is alerted, and a reconnect-needed failure returns `202` with a warning.

## Email receipt/confirmation
- `lib/email.ts` `sendBookingEmail(bookingId, kind)` renders a confirmation/receipt and records a `Message`
  row. It is sent on the normal paid → scheduled path (`enqueueConfirmation` in `lib/meeting.ts`), not only
  from resend/reschedule, so every customer who books and pays organically receives the confirmation email
  carrying their signed self-service link. Delivery is still a **structured-log stub** (no real SMTP): email
  and WhatsApp/SMS delivery remain stubbed pending Phases 4 (messaging) and 5 (reminders). The `Message` model
  gives the dashboard real per-booking message status to display in the meantime.

## Done when
Five customers can book one group session, all get the same link, and the influencer sees them in the dashboard.

This now holds in code: a GROUP service with `capacity >= 5` lets up to five customers each hold and pay for a
seat on one `Session` (seat counting is transactional in `lib/holds.ts`); `lib/meeting.ts` creates one shared
Calendar event per session and adds every paid attendee to it, so all five receive the same `meet_link`; and the
dashboard (`npm run dashboard:link -- <slug>`) lists that session with all five bookings, their message status
and the shared link. Influencers can additionally manage services/availability, block days, and resend/cancel/
reschedule bookings; customers can self-serve reschedule/cancel via their signed link.
