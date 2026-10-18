# Phase 1 — Booking and Slots

## Goal
A customer can see available slots for an influencer's service and hold one.

## Tasks
- [x] Set up Next.js + TypeScript, Prisma, Postgres
- [x] Schema: `influencers`, `services` (title, duration, price, type 1:1/group, capacity), `availability_rules` (weekday, start, end, timezone), `bookings`
- [x] `GET /api/slots?serviceId&date` — generate slots from rules, remove booked/held ones
- [x] `POST /api/bookings/hold` — create booking `held` with `hold_expires_at = now + 10 min`
- [x] Booking page `/[influencer]/book`: service -> date -> slot -> customer details
- [x] Collect: name, email, WhatsApp number (E.164), WhatsApp opt-in checkbox
- [x] Cron/worker job to expire stale holds

## Key rules
- Store all times in UTC, show them in Indian Standard Time (IST). The product is India-only: there is no time zone to choose (doc/14-india-localisation.md).
- Prevent double booking with a DB unique constraint on `(service_id, start_time)` for 1:1, or a transaction that checks capacity for groups.
- Validate phone numbers server-side: Indian mobile numbers only, stored as `+91XXXXXXXXXX`.

## Done when
Two browsers cannot hold the same slot, and a hold expires after 10 minutes.
