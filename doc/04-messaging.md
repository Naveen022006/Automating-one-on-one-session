# Phase 4 — WhatsApp and SMS

## Goal
Customer receives the meeting link on WhatsApp, with SMS as a fallback.

## Tasks
- [ ] Meta Business account + WhatsApp Cloud API number
- [ ] Create and submit templates for approval: booking confirmation (with link), 24h reminder, 15min reminder, cancellation/reschedule
- [ ] SMS provider account; complete DLT registration (sender ID + templates) for India
- [ ] `lib/whatsapp.ts` and `lib/sms.ts` send functions
- [ ] Worker job `send-message`: try WhatsApp -> on failure try SMS
- [ ] `messages` table: booking, channel, template, status, provider id, error
- [ ] Webhook endpoint for WhatsApp delivery statuses (sent/delivered/read/failed)

## Key rules
- Business-initiated WhatsApp messages must use approved templates.
- Only message numbers that opted in.
- Always show the link on the confirmation page and email too, so a message failure never blocks the customer.

## Done when
A paid booking sends a WhatsApp message; disabling WhatsApp triggers the SMS fallback.
