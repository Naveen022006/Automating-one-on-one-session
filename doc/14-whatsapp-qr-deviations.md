# QR-code WhatsApp mode, foundation (`wa/01-foundation`): decisions, facts checked, deviations

Dated 2026-10-18. This records what was built for the **optional** "link WhatsApp by QR code" sending mode (foundation: contract, data,
worker manager, transports, send queue, web-side commands), the facts that were checked while installing the libraries, and every place
the build differs from the brief. The mode is **unofficial** (WhatsApp's terms do not allow third-party clients; a linked number can be
restricted or banned without notice; the protocol can change and break it). It is off unless `WHATSAPP_QR_ENABLED=true`, the official
Cloud API connection stays the default, and nothing here reduces the SMS and e-mail fallbacks. Operation and settings are in
`doc/08-deployment.md` section 4 and the README.

## 1. Libraries: facts checked

| Fact | Result |
|---|---|
| `@whiskeysockets/baileys` | exactly `7.0.0-rc14`, MIT, ESM (`"type": "module"`), Node >= 20, published 2026-07-29 (80 days old on 2026-10-18). Added with `--save-exact` |
| `uqr` | exactly `0.1.3`, MIT, zero dependencies, ESM, published 2026-04-03. Added with `--save-exact` |
| Transitive packages | 58 added in total, all from the npm registry: no `git+` or other non-registry URL anywhere in `package-lock.json`, so `npm ci` works in the slim build image (no git). Notable: `libsignal@6.0.0` (**GPL-3.0**), `whatsapp-rust-bridge@0.5.4` (MIT, a WASM helper, no native build), `pino`, `ws`, `protobufjs`, `music-metadata`, `@hapi/boom`, `p-queue` |
| Install scripts | Only `@whiskeysockets/baileys` has a `preinstall` (`engine-requirements.js`, which only checks the Node major version). Nothing compiles native code |
| `sharp` | Listed as a **non-optional peer dependency** (`"sharp": "*"`; `jimp`, `audio-decode`, `link-preview-js` are optional). npm 7+ therefore treats it as a production dependency of the tree (the lockfile flags of `sharp` and `@img/*` changed from optional to required; no other entry changed). It is used **only** in `lib/Utils/messages-media.js`, through `import('sharp').catch(() => {})`, for image thumbnails. Text-only sending, QR login and connecting never reach it |

### The `sharp` question and `Dockerfile.worker`

`Dockerfile.worker` deletes `node_modules/sharp` and `@img` (and `next`, `react`, `typescript`) from the worker image. Checked, in a copy
of the Dockerfile's steps run on this machine (`npm ci`, `prisma generate`, `npm prune --omit=dev`, the esbuild import-graph check, the
same `rm -rf`): the library loads, `initAuthCreds()` works, `BaileysTransport` is created and ended, and a plain-text message content
is built, all with `sharp` absent. The graph check still passes (the only new external in the worker graph is the dynamic
`import("@whiskeysockets/baileys")`). **No change was needed to make it work**; the only edit is one added `RUN` line that imports the
library after the strip, so a future library version that starts needing `sharp` for text fails the **build** instead of failing when someone
links a number. The web image is unchanged (`next build` never reaches the adapter: `tests/whatsapp-web-guard.test.ts` pins that the
only importer of `baileys-transport.ts` is `worker/whatsapp-web.ts`, by dynamic import).

`docker build -f Dockerfile.worker` itself was **not run**: the Docker daemon was not running here (`dockerDesktopLinuxEngine` pipe
missing). The steps above were run by hand instead, on Windows binaries; the only thing that differs on Linux is the platform
package of `sharp`, which is deleted anyway.

### Licence

`libsignal` is GPL-3.0. A hosted service that does not distribute its code to its users is not "conveying" it, which is the
position this project takes; the note is in the README ("Licence note") and here. If the code or an image containing it is ever
distributed (for example to a customer who self-hosts), the GPL terms of that dependency apply and need review first. The other new packages are MIT/BSD/ISC/Apache.

## 2. What was built

- `lib/whatsapp-web/types.ts`: the contract (pure, `import type` from the browser): `WhatsAppWebStatus`, `WhatsAppWebView`,
  `WhatsAppWebRequest`, `RISK_TEXT`, `CONSENT_VERSION`.
- `lib/whatsapp-web/transport.ts`: `WhatsAppWebTransport` (pure types), `baileys-transport.ts` (the only file that knows Baileys; dynamic
  `import()` inside functions), `fake-transport.ts` (scriptable; the `WHATSAPP_QR_FAKE` simulator).
- `lib/whatsapp-web/auth-state.ts` (+ `session-repo.ts`): the login as ONE AES-256-GCM blob per influencer, AAD `wa-web:<influencerId>`,
  in-memory working copy with coalesced writes (1 s), flush on close, wipe, listed in `lib/key-rotation-db.ts`.
- `lib/whatsapp-web/send-queue.ts`: per-number FIFO, fixed gap, daily cap (Redis, IST date), existence check, booking guard, circuit breaker.
- `worker/whatsapp-web-manager.ts` (pure, injectable) and `worker/whatsapp-web.ts` (wiring, started from `worker/index.ts`).
- `lib/whatsapp-web/commands.ts`: view + start/cancel/disconnect for the web endpoints; `lib/whatsapp-web/send.ts`: the call messaging uses.
- Schema: `whatsapp_web_sessions` + enum `WhatsAppWebStatus` (migration `20261109000000_whatsapp_web_sessions`, produced with
  `prisma migrate diff`, applied with `migrate deploy`; additive).
- Env, rate-limit rules, `.env.example`, deployment doc, key rotation, the Vite guard, two alert kinds.

## 3. Deviations from the brief (and why)

1. **`sendWhatsAppWebText` is a working delegate, not a throwing stub.** The brief asked for a typed stub that throws "not implemented".
   It now returns the refusal results (`qr-disabled`, `manager-not-running`) and calls the registered sender (`setActiveSender`, set by
   `worker/whatsapp-web.ts`). Reason: a stub that throws would have been replaced by every consumer anyway, and the registry is needed for
   the manager to be reachable from `lib/messaging.ts` without importing the worker. The signature is exactly the one in the brief. Added next to it:
   `isWhatsAppWebReady(influencerId)`, `setActiveSender`, `SELF_TEST_BOOKING_ID`, the `WhatsAppWebSender` interface.
2. **A test message to the influencer's own number is the one allowed send without a booking.** The brief's request body has
   `{ action: "test" }`, but also forbids messaging anyone without a real booking. The queue's booking guard would refuse a test, so
   `bookingId: SELF_TEST_BOOKING_ID` ("self-test") is accepted **only** when `toE164` equals the number linked on that device; any other
   number is refused (`no-booking`). It still goes through the queue (gap, cap, breaker).
3. **A third close reason, `"restricted"`.** The brief names logged-out vs transient. WhatsApp's `forbidden` (403) means the number is
   refused; retrying only makes that worse, so it suspends the number (status `SUSPENDED`, e-mail to the influencer) instead of reconnecting.
   Other transient codes: `restart-required` reconnects at once (it is part of linking), `replaced` (another session took the login) waits at least a minute.
4. **`lastError` is two columns** (`last_error_code`, `last_error_text`), not one: the view needs `{ code, text }` and the code is also
   what logs and tests assert on.
5. **Sessions that stop on purpose keep or lose the login differently.** `LOGGED_OUT` (the phone removed the device) wipes it; `SUSPENDED`
   (restriction, three failed sends, unreadable login) **keeps** it, so "start" can resume without a new scan; disconnect/cancel, the kill
   switch (unless `WHATSAPP_QR_KEEP_AUTH_WHEN_DISABLED`) and influencer deletion wipe it. An unreadable stored login (key changed) is
   never deleted automatically: it suspends the number with code `auth-unreadable`.
6. **Pairing window.** A link nobody scans within 5 minutes is cancelled (`qr-expired`, `wantLinked` off), so a forgotten page does not keep
   asking WhatsApp for new codes for ever. Not in the brief.
7. **Heartbeat key `wa-web:manager:alive`** (Redis, 15 s TTL, written every reconcile while enabled). The view reports
   `lastError.code = "worker-not-running"` when someone asked to link, a shared store is configured, and no heartbeat exists. Without
   `REDIS_URL` the in-memory store is per process, so no such claim is made.
8. **The Redis fallback is process-local.** With `REDIS_URL` unset the QR payload and counters live in the process's memory, which only
   helps tests and a single-process run: the web app and the worker are different processes, so a real deployment needs Redis (it already
   does for the job queues). `npm run dev` (no worker) cannot link a number even with the simulator; use a local Redis and `npm run worker`.
9. **The kill switch acts at worker start, not on a live flag change** (env is read once per process; the manager still honours a flipped
   config in tests). With no live socket it cannot ask WhatsApp to unlink the device, so the phone keeps listing it until the influencer
   removes it (the risk text says so). A socket that is open when the switch is applied is logged out properly.
10. **`RISK_TEXT` and `CONSENT_VERSION` are not imported by the browser.** Nothing under `lib/whatsapp-web/` is on the Vite allowlist (pinned
    by a test), so the UI must show `view.riskText` and send back `view.consentVersion`; `types.ts` may be imported with `import type` only.
    The guard also forbids importing `@whiskeysockets/*`, `libsignal` and `uqr` from browser code.
11. **Daily counter semantics.** The count is taken before the send (so two readers cannot both take the last place) and given back when
    the message is refused or fails; only messages that were really handed to WhatsApp use up the day.
12. **`lib/alerts.ts` got two kinds** (`whatsapp-qr-logged-out`, `whatsapp-qr-suspended`) for the "existing account-email path"; their
    action link is the existing `/dashboard/settings#whatsapp` anchor.
13. **`lib/test-data-cleanup.ts` is unchanged.** It enumerates tables it must delete by hand; `whatsapp_web_sessions` goes with its
    influencer through the foreign key (`ON DELETE CASCADE`), like `influencer_activity_logs`, and `tests/whatsapp-web-auth-state.test.ts`
    pins that. `tests/key-rotation.test.ts` is unchanged too: its auto-discovery found the new `*Enc` column and the list entry satisfies it;
    the rotation of the column is tested in `tests/whatsapp-web-auth-state.test.ts`.
14. **Browser identification is the library's default** (no `browser` option is passed). `deviceLabel` shows what the library announces
    ("Chrome (Mac OS)"). No presence, typing or read-receipt call exists in the adapter; `markOnlineOnConnect: false` is the library's
    documented option so the phone keeps notifying as usual.
15. **Delivery state.** The adapter reports the delivery state of messages **we** sent (matched by id) to the manager, which forwards
    it to an optional `onDelivery(influencerId, { providerMessageId, status })` dependency. `worker/whatsapp-web.ts` does not pass a handler yet:
    wiring it to `Message` rows is the messaging layer's job.
16. **Nothing was verified against real WhatsApp.** There is no phone and no network use in any test; the adapter is tested against a
    stand-in with the library's shapes, plus one test that loads the real pinned library (no socket) and checks the names and status codes the
    adapter relies on. The first real link needs a manual pass.

## 4. Interfaces for the next work packages

- Web endpoints call `getWhatsAppWebView(influencerId)`, `requestLink(influencerId, { consent, consentVersion })`, `cancelLink`,
  `disconnectLink` from `lib/whatsapp-web/commands.ts` (influencer id from the session; each returns a `CommandResult`). The "test" action is
  a send with `bookingId: SELF_TEST_BOOKING_ID` to the linked number (see 2 above); the view only shows the masked number, so the endpoint
  reads the full one from `whatsapp_web_sessions.phone_e164`.
- Messaging (worker process): `isWhatsAppWebReady(influencerId)` then `sendWhatsAppWebText({ influencerId, toE164, text, bookingId, key })`,
  from `lib/whatsapp-web/send.ts`. `{ ok: false }` means fall back to the official connection, SMS or e-mail; `retryable` says whether "later" is reasonable.
- Rate-limit rules already exist for `GET/POST /api/dashboard/whatsapp-web` and `/api/admin/whatsapp-web*`.

## 5. Messaging path, endpoints, admin (`wa/02-messaging-api`)

**Message path (`lib/messaging.ts`).** For each customer message the order is: the influencer's linked number (when `WHATSAPP_QR_ENABLED`, the
manager reports the socket open, the stored status is LINKED with `wantLinked`, the destination is E.164 and the template is one of the five
booking events or, since `doc/16-request-whatsapp-flow.md`, one of the four booking-request messages), then the official connection, then SMS. Any `{ ok: false }` (retryable or not) falls through to the next channel in the same
run; there is no second QR attempt in the same run. Texts are in `lib/whatsapp-web/messages.ts` (pure; the time string is the SMS context's own,
so the IST change in `feat/india-only` flows in; no STOP promise, ends with the host's name; the manage link on confirmation, 24 h reminder and
reschedule, like the e-mails). `MESSAGING_DRY_RUN=true` disables the default QR sender.

- **Channel column.** `MessageChannel` got `WHATSAPP_WEB` (migration `20261110000000_message_channel_whatsapp_web`, one `ALTER TYPE ... ADD VALUE`, checked
  with `prisma migrate diff`, applied with `migrate deploy`). The `["WHATSAPP", "SMS"]` lists in `lib/messaging.ts` (dedupe, `sendBookingMessage`,
  `rearmMessage`), `lib/health.ts` (failed confirmations) and `lib/dashboard-data.ts` (message list) include it. The browser label maps in
  `web/src/components/app/SessionsBoard.tsx` and `MessagesView.tsx` fall back to the raw value `WHATSAPP_WEB` until a label is added there.
- **No double send.** The row for (booking, `WHATSAPP_WEB`, template) is written `PENDING` with `error = "in-flight"` BEFORE the send and holds the
  outcome after. A retry that finds the in-flight mark (the process died between handing over and recording) does NOT use the linked number
  again; it goes to the next channel (a duplicate on another channel in that rare window is accepted over losing the message). The queue key is
  `bookingId:template:<row.updatedAt ms or 0>`: stable across retries, different after a deliberate `rearmMessage` (so the queue's own
  "already sent" memory cannot swallow a resend).
- **Delivery receipts** (`lib/whatsapp-web/delivery.ts`, wired by `worker/whatsapp-web-messaging.ts` through `ManagerDeps.onDelivery`): matched by provider
  id AND the influencer who owns the booking, forward-only (same rule as the official callbacks), looked for again 3 times (2, 10, 30 s) when the row
  is not written yet. A `failed` receipt sets `FAILED` with a plain text; it does not trigger a second send.
- **Activity entries** (new actions `whatsapp_web.consent|linked|disconnected|suspended`, detail keys `version` | `phone` (masked tail) |
  `phone`,`reason` | `code`): consent and the influencer's disconnect from the endpoint; linked, suspended and logged-out from the worker, by wrapping the
  session repository (`observeSessionRepo`: first link only, not reconnects); admin removal from the admin action. The e-mail to the influencer
  is the foundation's `notify` (one per suspension or logout, a no-op without an e-mail provider).
- `tests/activity-log.test.ts` had its sample table extended with the four new actions (it pins the set).

**Influencer endpoint `/api/dashboard/whatsapp-web`.** `GET` answers the `WhatsAppWebView` itself (flat, not wrapped). `POST` answers the fresh view; the
`test` action answers the view plus `test: { state: "sent" | "pending" | "failed", message }` (`WhatsAppWebTestAnswer`, `lib/whatsapp-web/api-types.ts`).
Refusals are `{ error, code }`: 400 `consent-required`, 409 `consent-outdated | disabled | not-pending | not-linked`, 429 `cooldown`
(`Retry-After: 60`), 503 `unavailable`; a signed-out caller always gets 401 first. **Deviation: `start` uses `requireRecentAuth()`** (401 with
`reauth: true` after 8 h, like connecting the official number), because a stolen session could otherwise attach its own phone to somebody
else's customers; the SPA must prompt for the password on that 401. Everything else uses `requireApiAuth()`.

**Test message.** The web app has no socket, so the endpoint queues one job on a new BullMQ queue `whatsapp-web-test` (`lib/whatsapp-web/test-queue.ts`);
the worker (`worker/whatsapp-web-messaging.ts`) sends to the number read from the influencer's own session row (never from the request) with
`SELF_TEST_BOOKING_ID`, stores the answer in the shared store, and the request waits up to 12 s for it (else `pending`: the message may still
arrive). One a minute per influencer (the cooldown is taken only for a request that is really queued, and released if the queue is unreachable).

**Admin.** `GET /api/admin/whatsapp-web?influencerId=` and `GET /api/admin/whatsapp-web/:influencerId` answer `AdminWhatsAppWebView`; `GET
/api/admin/whatsapp-web` (no id) answers `AdminWhatsAppWebSummary` (counts by state). `POST /api/admin/whatsapp-web/:influencerId`
`{ action: "disconnect", reason }` (5 to 300 characters) force-disconnects: `wantLinked = false` and the stored login deleted in the same
transaction as the `whatsapp_web.force_disconnect` audit row; 404 unknown or malformed id, 409 when nothing is linked (a repeat writes no second row). The
existing influencer detail view and the admin health view are NOT changed (their key sets are pinned): the admin card reads the new endpoint.
Types: `lib/whatsapp-web/api-types.ts`.

## 6. Review fixes (`wa/04-review-fixes`)

Findings of the review of the whole feature and what was done (items W2 to W13; W1 was the merge of the `wa/02` tip into `wa/03`).

- **W2, messages that wait.** Every send now carries its kind (the template) and a deadline (`lib/whatsapp-web/deadline.ts`): a 15-minute
  reminder until the session starts, a 24-hour reminder until 12 h are left (the same rule as `staleReminderReason`), the rest 30 minutes after
  they were queued. The queue checks the deadline again immediately before the send and asks the booking guard again after any wait; a
  message past its time is dropped as `expired` and a booking that was cancelled, failed, expired or erased while it waited as
  `not-sendable` (the guard knows the kind: a cancellation notice is for a cancelled booking, nothing else is). `lib/messaging.ts` skips a late reminder and a
  `not-sendable` message on EVERY channel (no row is left), and sends a late confirmation, reschedule or cancellation notice the next way. A request whose
  expected wait (queue ahead x the fixed gap) is over 20 s (`MAX_EXPECTED_WAIT_MS`) is refused at once as `busy` (retryable), so a group
  session's 100 reminders cannot hold the worker's job slots for minutes; the same for a request that cannot be sent before its deadline
  (`expired`). One linked number can hold at most `MAX_JOBS_PER_SESSION` (2) worker jobs at a time; the rest are `busy` before they wait. The effect on a
  100-seat reminder: about 6 go from the linked number, the others by the official connection or SMS at once.
- **W7, a timeout is UNKNOWN.** A send with no answer in 30 s is `unknown-delivery`: not a failure, not counted towards the breaker, its
  place in the day's count stays taken, and it is NOT sent another way (it could arrive twice). The row is `SENT` with `error = "unknown-delivery"`
  and no provider id (so every dedupe stops it, including the reminder repair job); the Messages views show it as "Not confirmed".
- **W4, one worker.** A lease in the shared store (`wa-web:manager:lease`, `SET NX PX`, value = the worker's id, 20 s, renewed every pass,
  released on shutdown). A worker without it opens no socket and logs once. A holder that cannot renew it because another worker has it closes every socket WITHOUT
  writing the login (`EncryptedAuthState.abandon()`); one that merely stalled past the lease and finds nobody took it takes it back. A store that
  does not answer keeps what is open until the lease would have run out and starts nothing new. The kill-switch pass needs no lease. Without
  `REDIS_URL` the in-memory store makes it an in-process guard. Consequence: during a rolling deploy the messages sent by the idle worker's jobs
  find no sockets and go the official way.
- **W5.** `worker/process-guards.ts`: `unhandledRejection` is one log line (the error's name) and the worker keeps running;
  `uncaughtExceptionMonitor` logs while Node's default (exit) stays. `lib/whatsapp-web/safe.ts` wraps every event callback of the library and the key
  store in the Baileys adapter, so a throw or rejection becomes a log line (`describeError`: the name and a numeric status, never a message).
- **W6, customers' numbers in the stored login.** The per-contact keys are named after the contact's address (phone number). The text of
  `RISK_TEXT` and the Privacy page say so, and `CONSENT_VERSION` is now `wa-web-2026-11-2` (a consent given before must be given again). `lib/privacy.ts`
  (`eraseCustomerData`, used by the dashboard and the portal) publishes the erased numbers (those without another live booking) into a Redis list
  (`wa-web:prune:<influencerId>`, 7 days); the manager takes them every 10 s per connected number and removes the keys inside the same coalesced
  write (`EncryptedAuthState.mutateKeys`; the web process never writes the login). At session start and every 6 h it also forgets each contact
  with no non-erased booking (`keepContacts`), keeping the account's own addresses. The ONE function that knows the library's key naming is
  `keyOwner` in `lib/whatsapp-web/prune.ts`; it was read from baileys 7.0.0-rc14 and a test reads the library's source to pin it: recheck it on every upgrade.
  A session that is not connected (suspended) keeps its login until it is connected again or disconnected.
- **W8.** A login that could not be deleted is not reported as gone: `teardown` writes the new status only after the delete worked (a logout by the
  phone is still recorded), `wipeIdle` really clears, and `listManageable` also lists rows that still hold a login (`SessionRow.hasLogin`).
- **W9.** `requestLink` writes only `wantLinked` and the consent. The one status change left is conditional (`SUSPENDED`/`LOGGED_OUT` to
  `NOT_LINKED`), so a start after a pause or logout still begins afresh while a live socket is never touched.
- **W10.** The daily counter's refund uses the key it was counted on (a wait across midnight, India time, no longer refunds the wrong day).
- **W11.** A linked-number row that was not used (the message went the next way) is `FAILED` with a sentence ("... ; sent another way."), not `PENDING`;
  `WHATSAPP_WEB` is labelled "WhatsApp (QR link)" in the sessions drawer and the Messages page.
- **W12.** `qrExpiresAt` is the time the current code was received plus 20 s (`QR_ROTATE_MS`), not the store's 60 s; a code past that is shown faded
  with "Getting a new code...".
- **W13.** An influencer who is deleted while linked (the row is gone) is logged out on the phone where the socket was open, and the login wiped;
  a force-disconnect already did that through `wantLinked = false`.
- **W3.** The mode picker is gone: the official connection and the QR link are two independent sections, both always visible, with a note on the order.
  The server has no preference.

## 7. Second review (`wa/05-delta-fixes`)

- **D1, what a timeout means.** Baileys sends a text in steps: a device lookup (a query), the fetch of the recipient's pre-keys (a query), then
  the message itself is written to the socket. The adapter now sets the library's query timeout to 10 s (`QUERY_TIMEOUT_MS`, default 60 s), and the send
  queue waits 40 s for a send (`SEND_CALL_TIMEOUT_MS`, was 30 s): three steps of at most 10 s fit inside the wait. So a stall BEFORE the write ends as the
  library's own timeout (status 408, mapped to `not-connected`): that message fails fast, is not counted as a failed send, and goes the next way. A send that is
  still unanswered when the queue gives up has passed every query step: only that is `unknown-delivery` (SENT, "Not confirmed", never sent another way). We have no
  signal from the library for "the message was written", so this relation is what carries the distinction (a test pins it). **Decision:** an unknown send is NOT
  repeated on another channel, for reminders too: the duplicate (a second text or SMS for the same event) is judged worse than the rare lost one, and the e-mail
  confirmation is sent separately. Two unknowns in a row (`STALL_AFTER_UNKNOWNS`) mean a half-open socket: the manager reconnects the number, and the
  messages that arrive meanwhile are refused as not connected and go the next way.
- **D2, failures.** A refusal where the linked number never tried (busy, not connected, over the daily limit, paused, too late, the booking check said no, the
  customer is not on WhatsApp) deletes the in-flight row: no failure is recorded, like the official route. Only an attempt that failed keeps a `FAILED` row. A
  `FAILED` linked-number row is also left out of the "not delivered" counts and the Failed filter (dashboard overview, Messages page, admin overview) when another
  channel's row for the same booking and template is SENT, DELIVERED or READ (`lib/failed-messages.ts`).
- **D3, contact keys.** `identity-key` (named like `session`), the group `sender-key` (`<group>::<user>::<device>`), the member map inside `sender-key-memory` and the
  history list in the credentials are cleaned too; `pre-key`, `app-state-sync-key` and `app-state-sync-version` hold no contact address. A test reads the library's
  declared key types and fails when a new one appears that is neither covered nor listed as address-free.
- **D4, the lease.** It is renewed on its own timer every 5 s (`LEASE_RENEW_EVERY_MS`), not once per pass (a pass can take longer than the lease: each logout waits
  up to 10 s). `send()` and `isReady()` require a lease renewed less than 20 s ago, a login save without one is skipped and the sockets are closed, and when the store
  does not answer no new socket is started (`leaseFresh`: renewed in the last 10 s). **A rolling deploy is not free:** the new worker stays idle until the old one
  releases the lease at shutdown or it runs out after a crash, and in that time the new worker's message jobs find no sockets and send the official way.
- **D5.** Unhandled rejections are logged with a scrubbed stack and reported through `reportError` with a scrubbed copy of the error (environment secrets, URL
  credentials, bearer tokens, phone numbers and WhatsApp addresses are hidden); 10 within 5 minutes end the process with code 1 so the supervisor restarts it.
- **D6.** The manager publishes each QR code with its own lifetime (`lifeMs`: 60 s for the first code of a connection, about 20 s for the next ones, as in
  Baileys' QR timers) and `qrExpiresAt` is the time received plus that.
- **D7.** `WHATSAPP_QR_MIN_GAP_MS` is lowered to 14000 when larger (start-up warning), because a request that would wait over 20 s is refused as busy and
  almost everything would go another way.
