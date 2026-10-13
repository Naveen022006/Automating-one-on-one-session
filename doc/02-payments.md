# Phase 2 — Payments

## Goal
Customer pays; the server reliably marks the booking paid exactly once.

## Tasks
- [x] `POST /api/checkout` — verify hold is valid, create provider order, store `payments` row (`created`). The body is
  `{ bookingId, token }`, `token` being the booking's poll token (from the hold answer or the pay page): the id alone is a 403.
  The hold is extended to the payment window only when the order is created; a repeat call reuses the order and leaves the hold.
- [x] Frontend opens Razorpay/Stripe checkout
- [x] `POST /api/webhooks/payment` — read raw body, **verify signature**
- [x] Store each event id in `webhook_events` (unique) — skip if already seen
- [x] On success: in one transaction set payment `captured`, booking `paid`
- [x] Enqueue `create-meeting` job with the booking id
- [x] Handle payment failure/expiry: release the slot

## Key rules
- Never trust the browser's "payment success" — only the webhook (or a server-side fetch of the order).
- Webhook handler must be idempotent; return 200 quickly and do heavy work in the queue.
- Extend the hold if payment is in progress when it would expire.

## Done when
Replaying the same webhook twice creates only one meeting job.
