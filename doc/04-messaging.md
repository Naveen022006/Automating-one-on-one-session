# Phase 4 — WhatsApp and SMS

## Goal
Customer receives the meeting link on WhatsApp, with SMS as a fallback.

## Tasks
- [ ] Meta Business account + WhatsApp Cloud API number _(external/manual: cannot be done in code)_
- [ ] Create and submit templates for approval: booking confirmation (with link), 24h reminder, 15min reminder, cancellation/reschedule _(external/manual: Meta template approval)_
- [ ] SMS provider account; complete DLT registration (sender ID + templates) for India _(external/manual)_
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
  status endpoint (`/api/bookings/[id]`) so a message failure never blocks the customer.
