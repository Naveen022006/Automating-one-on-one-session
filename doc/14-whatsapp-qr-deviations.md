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
