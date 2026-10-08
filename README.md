# Session Automation

See `doc/` for the plan. Phase 1 (booking and slots) is implemented.

## Run locally
1. Start Postgres and set `DATABASE_URL` in `.env` (see `.env.example`).
2. `npm install`
3. `npx prisma migrate dev` then `npm run db:seed`
4. `npm run dev` and open http://localhost:3000/demo/book
5. `npm run expire-holds` in a second terminal (marks stale holds EXPIRED; availability is correct without it)
6. `npm test` (the hold/concurrency tests need the database; the slot tests do not)
