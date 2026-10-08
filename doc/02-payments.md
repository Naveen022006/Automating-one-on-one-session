# Phase 2 — Payments

## Goal
Customer pays; the server reliably marks the booking paid exactly once.

## Tasks
- [ ] `POST /api/checkout` — verify hold is valid, create provider order, store `payments` row (`created`)
- [ ] Frontend opens Razorpay/Stripe checkout
- [ ] `POST /api/webhooks/payment` — read raw body, **verify signature**
- [ ] Store each event id in `webhook_events` (unique) — skip if already seen
- [ ] On success: in one transaction set payment `captured`, booking `paid`
- [ ] Enqueue `create-meeting` job with the booking id
- [ ] Handle payment failure/expiry: release the slot

## Key rules
- Never trust the browser's "payment success" — only the webhook (or a server-side fetch of the order).
- Webhook handler must be idempotent; return 200 quickly and do heavy work in the queue.
- Extend the hold if payment is in progress when it would expire.

## Done when
Replaying the same webhook twice creates only one meeting job.
