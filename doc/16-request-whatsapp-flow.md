# 16. WhatsApp messages for the booking-request flow

Status: implemented (branch `feat/request-whatsapp-flow`). For services with "I approve each booking request" the customer used to hear
about the request only by e-mail; WhatsApp started after payment. Now every step of the request flow is also a WhatsApp message (SMS
fallback), and the e-mails stay exactly as they were.

## 1. The flow

| Step | What happens | Customer gets (WhatsApp, SMS fallback) | E-mail (unchanged) |
|------|--------------|----------------------------------------|--------------------|
| 1 | Customer books through the influencer's link: `POST /api/bookings/hold`, booking `REQUESTED` (hold of `REQUEST_TTL_HOURS` = 48 h). | `request-received` | receipt + influencer alert |
| 2 | Influencer accepts: `approveRequest`, `REQUESTED -> HELD` with a pay-by time (24 h, never later than 15 min before the session). | `request-approved` with the payment link, the amount and the pay-by time | the payment link |
| 3 | Customer pays: checkout `HELD -> PENDING_PAYMENT`, Razorpay webhook `-> PAID`, create-meeting `-> SCHEDULED`. | `booking-confirmation` with the Google Meet link (the existing message) | confirmation + receipt |
| 4a | Influencer declines: `declineRequest`, `REQUESTED -> CANCELLED`. | `request-declined` (with the note, if any) | the decline |
| 4b | Nobody answers: the worker's hold expiry, `REQUESTED -> EXPIRED`. | `request-expired` | none (as before) |

Services without approval keep today's flow: pay at once, then the confirmation with the Meet link.

Step 3 was checked end to end (`tests/request-whatsapp.test.ts`, "pay: checkout, the captured payment, the meeting..."): an approved request
reaches `PAID` through the same `startCheckout` and `applyCapturedPayment` as any booking, `createMeetingForBooking` schedules it, and the
`booking-confirmation` message carries the Meet link from the linked number and from the official template. Nothing needed fixing there.

## 2. What the messages say

The four texts as sent from an influencer's linked number (plain text; the official template and the SMS carry the same facts):

```
Your booking request was received.

Session: Portfolio review with Asha Rao
Requested time: Thu, 12 Nov 2026, 11:00 AM IST
Asha Rao has 2 days to answer. Nothing has been charged and there is nothing to pay yet.
If the request is accepted, the payment link will be sent to you here. If it is not answered in time, it lapses and you pay nothing.
Your booking: https://example.com/manage/TOKEN

- Asha Rao
```

```
Good news: your booking request was accepted.

Session: Portfolio review with Asha Rao
When: Thu, 12 Nov 2026, 11:00 AM IST
Amount to pay: ₹499.00
Pay by: Fri, 13 Nov 2026, 6:00 PM IST. If it is not paid by then, the time is released.
Pay here: https://example.com/pay/TOKEN
Your booking: https://example.com/manage/TOKEN

- Asha Rao
```

```
Your booking request was not accepted.

Session: Portfolio review with Asha Rao
Requested time: Thu, 12 Nov 2026, 11:00 AM IST
Note from Asha Rao: I am away that week
You were not charged anything.
To pick another time: https://example.com/asha

- Asha Rao
```

```
Your booking request was not confirmed in time.

Session: Portfolio review with Asha Rao
Requested time: Thu, 12 Nov 2026, 11:00 AM IST
The request lapsed before it was answered, so the time was released. You were not charged anything.
To request a time again: https://example.com/asha

- Asha Rao
```

The note line is left out when the host left none. The amount and the pay-by time come from the service row and the booking's hold
(`lib/india.ts`: rupees, IST); the texts never promise a reply or a stop word (a test reads them for that) and say nothing the system
cannot keep ("has 2 days to answer" is the hold; "lapses" is what the hold does).

## 3. Design

- **One table of states per message** (`lib/message-kinds.ts`, pure). `messageMayBeSent(template, facts, now, route)` is read by the sender
  (`lib/messaging.ts`, which used one global `SENDABLE_STATUSES`) and by the linked number's queue check (`lib/whatsapp-web/booking-guard.ts`,
  which had its own table), so for the four new messages they cannot disagree. The five booking events keep exactly what they had; the queue
  is deliberately stricter for the reminders (only `SCHEDULED`) and reschedule (`PAID` or `SCHEDULED`) because it asks again right before a
  send that waited. A test pins that the queue's states are always a subset of the sender's.
  - `request-received`: `REQUESTED` and the hold still running.
  - `request-approved`: `HELD` or `PENDING_PAYMENT`, decided (`decidedAt` set), pay-by time ahead. `PAID` and `SCHEDULED` are skipped: the confirmation follows.
  - `request-declined`: `CANCELLED`, `decidedAt` set, no payment row ever (declining is the only way an unpaid booking gets `CANCELLED`).
  - `request-expired`: `EXPIRED`, `decidedAt` null, the service needs approval, no payment row ever.
  - Always skipped: erased customer data (`redactedAt`), no WhatsApp opt-in, no number.
- **Values worked out when the message is sent** (`lib/request-message-context.ts`), never stored in a job: the payment link
  (`buildPayUrl(bookingId, secondsUntil(holdExpiresAt))`, so a retry always gets a link that matches the booking's pay-by time; the message
  is skipped when the pay-by time has passed or no link can be signed), the pay-by time, the amount, the booking page `APP_URL/<slug>`, the
  decline note (trimmed to 300 characters), the status link (the customer's existing signed manage link). A job is `{ bookingId, template }`.
- **Triggers** (`lib/request-messages.ts`, best effort, after the database change has committed, never inside a transaction): the hold route
  queues `request-received` next to the e-mail receipt; `approveRequest` queues `request-approved` right after its conditional update (before
  the e-mail, because a slow e-mail must not delay it); `declineRequest` queues `request-declined`; the worker's hold expiry queues
  `request-expired` for each unanswered request it expires. Job ids are deterministic (`send-message-<template>-<bookingId>`) and the messages
  table remembers what was sent, so a repeat sends nothing. A queue that is down costs one log line (never a link) and never changes the
  answer: the hold is created, the request approved or declined.
- **A route first, then a job** (`lib/message-route.ts`, one shared helper). Before anything is queued, `customerMessageRoute(influencerId,
  template)` says how the message can reach the customer right now: `whatsapp-linked` (the feature is on and the influencer's number is
  LINKED and wanted), `whatsapp-official` (their official connection is ACTIVE AND this template is approved or flagged at Meta, the same
  decision as `resolveSendCredentials`), `sms` (the provider is set up for this message: `smsConfigProblem` in `lib/sms.ts`, the same check
  `sendSMS` makes), or `none`. With `none` nothing is queued at all, for any of the four messages. A dry run reports the official route.
- **The decision answer** (`POST /api/dashboard/bookings/:id/decision`) carries `messageRoute` (the four values above) and `messageQueued`
  (the job is really on the queue). The dashboard says "on its way to the customer's WhatsApp" only for the two WhatsApp routes, "by SMS" for
  `sms`, and for `none` (or a route whose job the queue did not take) shows the red "send it yourself" answer. `payLink` is returned to the host
  exactly when the customer was not e-mailed AND no message is on its way (`web/src/lib/request-flow-ui.ts`, tested). This replaces the first
  version's `whatsappQueued`, which was true whenever the customer opted in and the job was queued, even on a site where the job could only
  fail (no linked number, official templates still PENDING, no SMS).
- **Expiry** (`expireStaleHoldsAndNotify`): the unanswered `REQUESTED` bookings are expired first, in batches of 200 (at most 25 batches per
  tick), and the ones this sweep really moved to `EXPIRED` with `decidedAt` null are queued; everything else (a held or pending hold that
  lapsed) is expired by the unchanged `expireStaleHolds`, which the old tests keep calling. A request declined or approved while the sweep
  ran is never contradicted (the update is conditional and the notified set is read back).
- **Linked-number deadlines** (`webSendDeadline`): `request-received` 30 minutes after it was queued; `request-approved` until the pay-by
  time; `request-declined` and `request-expired` 6 hours. A late message is dropped, not sent.
- **Meta templates** (`sa_request_received` 5 variables, `sa_request_approved` 7, `sa_request_declined` 5, `sa_request_expired` 4, all
  UTILITY, bodies in `lib/message-templates.ts`). The existing template sync submits them for approval for every connected influencer (the
  worker's periodic check does it for accounts that were connected before this change); until Meta approves one, the official route falls
  through to SMS for that message, as for the other templates. The settings card shows nine templates now; template trouble never blocks
  going live.
- **SMS**: bodies in `lib/message-templates.ts`; MSG91 flow ids `MSG91_TEMPLATE_REQUEST_RECEIVED`, `_APPROVED`, `_DECLINED`, `_EXPIRED`
  (`.env.example`, `KNOWN_ENV_VARS`, doc/08). The variables are sent in the order of the Meta parameters. `smsConfigProblem` (lib/sms.ts) is
  the one check of "can this message go by SMS" (provider credentials, and for MSG91 a flow id of its own or `MSG91_TEMPLATE_DEFAULT`);
  `sendSMS` refuses with the typed, non-retryable `NoMessageRouteError` when it says no, before any network call.
- **No route at all is final, and quiet, for the four request messages.** When the linked number is not a route, the official WhatsApp could
  not even be tried (no connection, or the template not approved) and SMS throws `NoMessageRouteError`, `sendMessageForBooking` writes ONE
  FAILED row ("No WhatsApp or SMS route for this message", on the SMS channel) and finishes: no five retries, no "could not deliver" alert,
  no `booking.lastError`. Anything that could still work stays a retried failure: an official send that really failed, or a linked
  number that is linked and wanted but busy or reconnecting right now. The five booking events keep today's behaviour exactly: a paid
  customer who is missing the Meet link still alerts the host. Because nothing is queued without a route (above), this path is rare: it
  covers a route that vanished between queueing and sending.
- **Labels**: "Request received", "Request accepted (payment link)", "Request declined", "Request expired" in the Messages page, the booking
  drawer and the template list. The e-mail row and the WhatsApp row of a step share the key; the channel column tells them apart.
- **The customer's status link**: the existing manage link. Its page used to say "This booking can no longer be changed online" for every
  booking that is not paid yet; it now says what the booking waits for (the host's answer, the payment, or that the time was released).

## 4. Security and privacy

- The payment link is a bearer link, and so is the manage link that several messages carry (a Meta parameter, the SMS body, the linked-number
  texts). The payment link is built when the message is sent, goes to the booking's own number only, and is never logged, stored, put in an
  activity or audit row, in a job, in `Message.error`, `booking.lastError`, an alert or a failed job's reason. Where an error could echo a
  link (a provider repeating the message), `redactBearerLinks` takes it out before the error is stored, logged or thrown: the pattern knows
  `…/pay/<token>` and `…/manage/<token>` in their plain, JSON-escaped (`https:\/\/host\/pay\/…`, as PHP-based APIs such as MSG91 write
  them), escaped-twice and percent-encoded (`%2Fpay%2F`) spellings, and `sendMessageForBooking` also passes the EXACT links and tokens of the
  send (`bearerLinkSecrets`), which catches a token quoted without its path. Everything that leaves `sendMessageForBooking` as an error is
  scrubbed that way (so BullMQ's failed reason, the worker log and the alert text never see a link), and the worker's `send-message`
  wrapper and the final-failure alert apply the pattern again as a backstop, for every message type. Development-only loggers
  (`MESSAGING_DRY_RUN`, the fake QR transport, `EMAIL_PROVIDER=log`) print message bodies by design; production refuses all of them.
- Only the booking's own customer number is messaged; the per-number daily cap, the send gap, the booking guard and the circuit breaker of
  the linked number apply as to every other message. Customers who did not opt in, have no number, or were erased get nothing.
- **A stranger's number cannot be messaged on demand.** An anonymous visitor could type any Indian mobile into the booking form and tick the
  opt-in, and the host's linked number would message it at once and again 48 hours later; ten holds per IP per ten minutes would burn the
  linked number's daily limit on strangers (and spam reports risk the number). So: (a) a request is counted per destination number
  (`IDENTITY_RULES.holdPhone`, 3 requests per number per 24 hours, requests only; ordinary holds send nothing before payment), and
  `createHold` refuses a request while another request from the same number is still waiting for the same host (`maxOpenRequestsPerNumber: 1`,
  checked under the schedule lock, so two at once cannot both get in); (b) "request expired" is sent only when "request received" was really
  delivered to that booking (a sent, delivered or read row on a customer channel), so a number that never heard of the request is not told
  it lapsed. The cost: someone who knows a real customer's number can use up that customer's three requests for the day, the same trade
  the e-mail limit makes.
- Nothing weakened: no new route, no new environment value except the four MSG91 flow ids, no migration (the template column is text).

## 5. Decisions and deviations from the brief

1. **Two tables stay two views of one table.** The brief says one module for the sender and the queue guard. The five existing events had
   different rules in the two places (a reminder for a `PAID` booking was sent by the sender but refused by the queue). Unifying them would
   have changed today's behaviour, so the module has a sender view and a queue view for the five, and one rule for the four new messages.
2. **`messageRoute` + `messageQueued` instead of `whatsappQueued`** (see above): the dashboard must not say "on its way" when no route exists.
3. **`request-declined` and `request-expired` also check "no payment ever"**, because a cancelled booking with `decidedAt` set can also
   be an approved, paid and later cancelled booking. `request-expired` also checks that the service needs approval (an expired one with
   `decidedAt` null can be a plain hold); `request-declined` does not, so a host who turned approval off can still decline the backlog.
   The cost: a request that lapses after the host turned approval off gets no "expired" message.
4. **`request-received` and `request-approved` check that the hold is still running**; a "we received your request" an hour after it lapsed
   would be wrong.
5. **The expiry notification is a separate function** (`expireStaleHoldsAndNotify`), not a change to `expireStaleHolds`: the plain
   function stays Redis-free for the tests that call it, and the worker calls the new one.
6. **MSG91 with no flow id is a missing route, not a failure**, for the four request messages (see "No route at all"). For the five booking
   events a missing SMS route still ends as a thrown error with retries and the usual alert, as before.
7. **The linked-number texts are nine now**: `WHATSAPP_WEB_TEMPLATES` and its pinned tests were updated on purpose. The tests that counted five
   Meta templates (`mock-providers-meta`, `mock-providers-whatsapp-db`, `spa-dashboard-setup`, `whatsapp-connect`) count `KNOWN_TEMPLATES` now.

## 6. Follow-ups, not done

- **An approved request that nobody pays.** Its hold lapses, the worker marks it `EXPIRED` and the customer hears nothing on WhatsApp (the
  rule for `request-expired` says "never decided" on purpose). A "your time was released" message for it is the natural next message.
- **A lost "request expired" message** when the queue is down during the exact sweep that expired the request (logged once). A repair sweep
  like `reconcileReminders` would close it.
- **Meta approval takes time** and the four new templates start `PENDING` on every account; until then the official route falls through.

## 7. Tests

`tests/message-kinds.test.ts` (the state table, per route, per status; Meta templates, SMS bodies, labels), `tests/request-messages.test.ts`
(queueing, the worker wrapper, wiring), `tests/request-flow-ui.test.ts` (the dashboard and manage-page words), `tests/request-whatsapp.test.ts`
(the whole flow against the database with every provider faked: hold route, decision route, linked number, official and SMS fallbacks,
payment, meeting, decline, expiry, the booking guard, the real manager with the fake transport, no payment link in any log or stored
error), plus the updated `whatsapp-web-messages`, `whatsapp-web-deadlines` and the template-count tests.
