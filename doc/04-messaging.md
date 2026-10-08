# Phase 4 — WhatsApp and SMS

## Goal
Customer receives the meeting link on WhatsApp, with SMS as a fallback.

## Tasks
- [ ] Meta Business account + WhatsApp Cloud API number _(external/manual: cannot be done in code)_
- [ ] Create and submit templates for approval: booking confirmation (with link), 24h reminder, 15min reminder, cancellation/reschedule _(external/manual: Meta template approval. Exact names and body variables: `lib/message-templates.ts`, Phase 7)_
- [ ] SMS provider account; complete DLT registration (sender ID + templates) for India _(external/manual; MSG91 and Twilio are implemented in `lib/sms.ts`, Phase 7)_
- [x] `lib/whatsapp.ts` and `lib/sms.ts` send functions
- [x] Worker job `send-message`: try WhatsApp -> on failure try SMS
- [x] `messages` table: booking, channel, template, status, provider id, error
- [x] Webhook endpoint for WhatsApp delivery statuses (sent/delivered/read/failed)

## Key rules
- Business-initiated WhatsApp messages must use approved templates.
- Only message numbers that opted in.
- Always show the link on the confirmation page and email too, so a message failure never blocks the customer.

## Done when
A paid booking sends a WhatsApp message; disabling WhatsApp triggers the SMS fallback.

## Implementation notes
- The `send-message` job is enqueued by the Phase 3 create-meeting job, which sets `booking.meetLink`,
  moves the booking to `SCHEDULED`, and only then calls `enqueueSendMessage(booking.id)`. So by the
  time the message job runs the Meet link is present. `lib/payment-webhook.ts` enqueues only the
  create-meeting job on `PAID`; it no longer enqueues `send-message` directly, so a booking is never
  messaged twice. `sendBookingMessage` still guards defensively against a missing `meetLink` (throwing
  a retryable error), but that is a fallback rather than the expected path.
- The meeting link is always surfaced on the confirmation page (`BookingFlow.tsx`) and the booking
  status endpoint (`/api/bookings/[id]`) so a message failure never blocks the customer. Because that
  endpoint is public and unauthenticated and the link is a join capability, `/api/bookings/[id]` only
  returns `meetLink` once the booking is in a terminal paid state (`PAID`/`SCHEDULED`/`COMPLETED`); a
  guessed/pre-payment booking id never yields a link. Booking ids are cuids and the link is also sent
  over WhatsApp/SMS, so this does not widen exposure. A proper session/ownership check is deferred to
  when an auth system lands.
- Webhook trust boundary: the WhatsApp POST delivery-status endpoint verifies Meta's
  `X-Hub-Signature-256` header (HMAC-SHA256 of the raw body with `WHATSAPP_APP_SECRET`) in constant
  time before applying any status update, mirroring the payment webhook. The GET verify-token
  handshake uses a constant-time compare too. Delivery status is treated as the source of truth and
  the stored `error` is only overwritten on `FAILED` transitions, so a later DELIVERED/READ callback
  cannot wipe diagnostic context from a prior FAILED.
