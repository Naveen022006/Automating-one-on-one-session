# Phase 5 — Reminders and Retries

## Goal
Reminders go out on time, and failures are retried instead of silently lost.

## Tasks
- [ ] When a booking becomes `scheduled`, enqueue delayed jobs: T-24h and T-15m
- [ ] Skip reminders if the booking is cancelled or rescheduled (check status at run time)
- [ ] Retry policy: exponential backoff, 5 attempts
- [ ] After final failure: mark message `failed`, notify influencer, flag booking in dashboard
- [ ] Reschedule: update Calendar event, cancel old reminder jobs, enqueue new ones, send update message
- [ ] Cancel: delete event, notify customer, handle refund per policy
- [ ] Basic logging/alerts for failed jobs

## Key rules
- Jobs read the latest booking state when they run; never trust data captured at enqueue time.
- Keep job ids deterministic (e.g. `reminder-24h-<bookingId>`) so they can be removed or replaced.

## Done when
A rescheduled booking sends only the new reminders, and a forced failure retries then alerts.
