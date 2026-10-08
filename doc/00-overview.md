# Session Automation — Overview

Automate paid 1:1 (and small group) sessions for influencers: customer pays on the website, gets a Google Meet link on WhatsApp/SMS automatically.

## End-to-end flow
1. Customer picks a slot -> slot is **held** for 10 minutes.
2. Customer pays (Razorpay/Stripe) -> booking is `pending_payment`.
3. Payment webhook arrives -> verify signature -> idempotency check -> booking `paid`.
4. Worker creates Google Calendar event with Meet link (influencer's OAuth account, customer as attendee).
5. Save link -> booking `scheduled` -> queue notification.
6. Send WhatsApp template; on failure fall back to SMS; on repeated failure alert influencer.
7. Reminders: 24 hours and 15 minutes before.
8. Reschedule/cancel updates the event and re-notifies.

## Booking status machine
`held -> pending_payment -> paid -> scheduled -> completed`
Side exits: `expired` (hold timed out), `cancelled`, `failed` (needs manual attention).

## Stack
- Next.js (App Router) + TypeScript — public booking page, dashboard, API routes
- Postgres + Prisma
- Redis + BullMQ — separate worker process
- Google Calendar API, WhatsApp Cloud API, SMS provider (MSG91/Twilio)
- Razorpay or Stripe

## Folder structure
```
/app
  /[influencer]/book        public booking page
  /dashboard                influencer dashboard
  /api
    /slots  /checkout  /bookings
    /webhooks/payment
    /google/callback
/lib
  db.ts  google.ts  payments.ts  whatsapp.ts  sms.ts  queue.ts
/worker
  index.ts  jobs/createMeeting.ts  jobs/sendMessage.ts  jobs/sendReminder.ts
/prisma/schema.prisma
```

## Tables
`influencers`, `google_tokens`, `services`, `availability_rules`, `bookings`, `payments`, `messages`, `webhook_events`

## Environment variables
```
DATABASE_URL=
REDIS_URL=
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
GOOGLE_REDIRECT_URI=
RAZORPAY_KEY_ID=
RAZORPAY_KEY_SECRET=
RAZORPAY_WEBHOOK_SECRET=
WHATSAPP_TOKEN=
WHATSAPP_PHONE_NUMBER_ID=
SMS_API_KEY=
APP_URL=
```

## Phases
1. `01-booking-and-slots.md`
2. `02-payments.md`
3. `03-google-meet.md`
4. `04-messaging.md`
5. `05-reminders-and-retries.md`
6. `06-groups-and-dashboard.md`

Start the WhatsApp template approval and DLT registration during Phase 1 — they take days.
