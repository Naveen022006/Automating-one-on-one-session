# Phase 5 — Reminders and Retries

## Goal
Reminders go out on time, and failures are retried instead of silently lost.

## Tasks
- [x] When a booking becomes `scheduled`, enqueue delayed jobs: T-24h and T-15m
- [x] Skip reminders if the booking is cancelled or rescheduled (check status at run time)
- [x] Retry policy: exponential backoff, 5 attempts
- [x] After final failure: mark message `failed`, notify influencer, flag booking in dashboard
- [x] Reschedule: update Calendar event, cancel old reminder jobs, enqueue new ones, send update message
- [x] Cancel: delete event, notify customer, handle refund per policy
- [x] Basic logging/alerts for failed jobs

Verified in code (Phase 7 review): `lib/queue.ts` (`enqueueReminders`, deterministic `reminder-24h-<id>` /
`reminder-15m-<id>`, 5 attempts with exponential backoff), `lib/reminders.ts` (run-time status + start-time check),
`worker/index.ts` (final-failure handling), `lib/manage.ts` (reschedule replaces reminders; cancel drops them and
applies the per-service refund policy).

## Key rules
- Jobs read the latest booking state when they run; never trust data captured at enqueue time.
- Keep job ids deterministic (e.g. `reminder-24h-<bookingId>`) so they can be removed or replaced.

## Done when
A rescheduled booking sends only the new reminders, and a forced failure retries then alerts.
