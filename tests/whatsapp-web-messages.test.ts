import assert from "node:assert/strict";
import { test } from "node:test";
import { formatSessionTime } from "../lib/format";
import { smsBody } from "../lib/message-templates";
import { ACTIVITY_DETAIL_KEYS, sanitiseActivityDetail, summariseActivity, type ActivityAction } from "../lib/activity-actions";
import { createDeliveryHandler, DELIVERY_FAILED_TEXT, messageStatusFor, type DeliveryDb, type MessageDeliveryStatus } from "../lib/whatsapp-web/delivery";
import { maskE164 } from "../lib/whatsapp-web/mask";
import { isWhatsAppWebTemplate, whatsAppWebTestText, whatsAppWebText, WHATSAPP_WEB_TEMPLATES } from "../lib/whatsapp-web/messages";
import type { SessionPatch, SessionRepo, SessionRow } from "../lib/whatsapp-web/session-repo";
import { observeSessionRepo } from "../worker/whatsapp-web-messaging";
import { newRow, settle } from "./helpers/whatsapp-web";

// Pure tests (no database, no network): the five texts, the delivery-state mapping and the activity observer of the worker.

const START = new Date(Date.UTC(2026, 10, 12, 5, 30, 0));
const when = formatSessionTime(START);
const ctx = { link: "https://meet.google.com/abc-defg-hij", serviceTitle: "Career call", influencerName: "Asha Rao", when };
const MANAGE = "https://example.test/manage/abc123";

test("there is a text for exactly the five booking events and the four booking-request messages, and for nothing else", () => {
  // Deliberately nine, no longer five: the booking-request flow (doc/16-request-whatsapp-flow.md) sends its four messages from a linked
  // number too. The first five are unchanged; a template that is not listed here still has no text and is never sent this way.
  assert.deepEqual([...WHATSAPP_WEB_TEMPLATES], ["booking-confirmation", "reminder-24h", "reminder-15m", "reschedule", "cancellation", "request-received", "request-approved", "request-declined", "request-expired"]);
  for (const t of WHATSAPP_WEB_TEMPLATES) assert.ok(isWhatsAppWebTemplate(t) && whatsAppWebText(t, ctx), t);
  for (const t of ["receipt", "marketing", "booking-cancelled", "", "booking-confirmation ", "request-approved ", "request-cancelled"]) {
    assert.equal(isWhatsAppWebTemplate(t), false, t);
    assert.equal(whatsAppWebText(t, ctx), null, t);
  }
});

test("every text names the service and the host, shows the time exactly as the SMS text shows it, and ends with the host's name", () => {
  for (const t of WHATSAPP_WEB_TEMPLATES) {
    const text = whatsAppWebText(t, { ...ctx, manageUrl: MANAGE })!;
    assert.ok(text.includes("Career call"), t);
    assert.ok(text.includes(when), `${t}: the time string is the formatter's, unchanged`);
    assert.ok(smsBody(t, ctx).includes(when), `${t}: and the SMS text carries the same string`);
    assert.ok(text.endsWith("\n\n- Asha Rao"), `${t}: ends with the sender's name`);
    assert.ok(text.length < 600, t);
  }
});

test("the Meet link and the manage link appear where the SMS and e-mail carry them, and nowhere else", () => {
  const withLink = (t: string) => whatsAppWebText(t, { ...ctx, manageUrl: MANAGE })!;
  for (const t of ["booking-confirmation", "reminder-24h", "reminder-15m", "reschedule"]) assert.ok(withLink(t).includes(ctx.link), `${t} has the Meet link`);
  assert.ok(!withLink("cancellation").includes(ctx.link), "a cancelled session has no join link");
  for (const t of ["booking-confirmation", "reminder-24h", "reschedule"]) assert.ok(withLink(t).includes(MANAGE), `${t} has the manage link`);
  for (const t of ["reminder-15m", "cancellation"]) assert.ok(!withLink(t).includes(MANAGE), `${t} has none`);
  // No manage link built (APP_URL / APP_SECRET missing): the message simply has none.
  assert.ok(!whatsAppWebText("booking-confirmation", { ...ctx, manageUrl: null })!.includes("manage"));
  // No Meet link yet: a confirmation says it will follow; the others leave the line out.
  assert.match(whatsAppWebText("booking-confirmation", { ...ctx, link: null })!, /join link will be sent/i);
  assert.ok(!whatsAppWebText("reminder-15m", { ...ctx, link: null })!.includes("Join link"));
});

test("the wording of each event", () => {
  assert.match(whatsAppWebText("booking-confirmation", ctx)!, /^Your booking is confirmed\./);
  assert.match(whatsAppWebText("reminder-24h", ctx)!, /^Reminder: your session is tomorrow\./);
  assert.match(whatsAppWebText("reminder-15m", ctx)!, /^Your session starts in 15 minutes\./);
  assert.match(whatsAppWebText("reschedule", ctx)!, /^Your session was rescheduled\.[\s\S]*New time: /);
  assert.match(whatsAppWebText("cancellation", ctx)!, /^Your session was cancelled\.[\s\S]*Any refund follows the cancellation policy\./);
});

// ---- the four booking-request messages ---------------------------------------------------------------------------------------
const PAY = "https://example.test/pay/tok123";
const PAGE = "https://example.test/asha";
const requestCtx = { ...ctx, manageUrl: MANAGE, payUrl: PAY, payBy: "Fri, 13 Nov 2026, 6:00 PM IST", amount: "₹499.00", bookingPageUrl: PAGE, decideWithinHours: 48, reason: "I am away that week" };

test("request received: says nothing was charged, how long the host has, that the payment link follows here, and carries the status link", () => {
  assert.equal(
    whatsAppWebText("request-received", requestCtx),
    [
      "Your booking request was received.",
      "",
      "Session: Career call with Asha Rao",
      `Requested time: ${when}`,
      "Asha Rao has 2 days to answer. Nothing has been charged and there is nothing to pay yet.",
      "If the request is accepted, the payment link will be sent to you here. If it is not answered in time, it lapses and you pay nothing.",
      `Your booking: ${MANAGE}`,
      "",
      "- Asha Rao",
    ].join("\n"),
  );
  assert.ok(!whatsAppWebText("request-received", { ...requestCtx, manageUrl: null })!.includes("Your booking:"), "no status link built: the line is left out");
  assert.match(whatsAppWebText("request-received", { ...requestCtx, decideWithinHours: 12 })!, /has 12 hours to answer/);
});

test("request accepted: the payment link, the amount in rupees, the pay-by time in IST, what happens when it is not paid, and the booking link", () => {
  assert.equal(
    whatsAppWebText("request-approved", requestCtx),
    [
      "Good news: your booking request was accepted.",
      "",
      "Session: Career call with Asha Rao",
      `When: ${when}`,
      "Amount to pay: ₹499.00",
      "Pay by: Fri, 13 Nov 2026, 6:00 PM IST. If it is not paid by then, the time is released.",
      `Pay here: ${PAY}`,
      `Your booking: ${MANAGE}`,
      "",
      "- Asha Rao",
    ].join("\n"),
  );
  // Without a payment link the text never pretends to have one.
  const noLink = whatsAppWebText("request-approved", { ...requestCtx, payUrl: null })!;
  assert.ok(!noLink.includes("Pay here:") && /payment link will be sent to you shortly/.test(noLink));
});

test("request declined: nothing was charged, the host's note when there is one, and a link to pick another time", () => {
  assert.equal(
    whatsAppWebText("request-declined", requestCtx),
    [
      "Your booking request was not accepted.",
      "",
      "Session: Career call with Asha Rao",
      `Requested time: ${when}`,
      "Note from Asha Rao: I am away that week",
      "You were not charged anything.",
      `To pick another time: ${PAGE}`,
      "",
      "- Asha Rao",
    ].join("\n"),
  );
  assert.ok(!whatsAppWebText("request-declined", { ...requestCtx, reason: "  " })!.includes("Note from"), "no note: no empty line");
  const long = whatsAppWebText("request-declined", { ...requestCtx, reason: `${"x".repeat(400)}\nnew line` })!;
  assert.ok(long.length < 800 && !/\nnew line/.test(long), "a long, multi-line note is cut and kept on one line");
});

test("request expired: not confirmed in time, the time was released, nothing was charged, and a link to request again", () => {
  assert.equal(
    whatsAppWebText("request-expired", requestCtx),
    [
      "Your booking request was not confirmed in time.",
      "",
      "Session: Career call with Asha Rao",
      `Requested time: ${when}`,
      "The request lapsed before it was answered, so the time was released. You were not charged anything.",
      `To request a time again: ${PAGE}`,
      "",
      "- Asha Rao",
    ].join("\n"),
  );
});

test("the request texts carry their links only where they belong, and no text shows another message's link", () => {
  const text = (t: string) => whatsAppWebText(t, requestCtx)!;
  assert.ok(text("request-approved").includes(PAY));
  for (const t of ["request-received", "request-declined", "request-expired", "booking-confirmation"]) assert.ok(!text(t).includes(PAY), `${t} never shows the payment link`);
  assert.ok(text("request-declined").includes(PAGE) && text("request-expired").includes(PAGE) && !text("request-received").includes(PAGE));
  for (const t of ["request-received", "request-approved", "request-declined", "request-expired"]) {
    assert.ok(!text(t).includes("meet.google"), `${t}: a request has no Meet link yet`);
    assert.doesNotMatch(text(t), /\bSTOP\b|reply|unsubscribe|offer|discount|\bban(ned)?\b|detect/i, t);
  }
});

test("no promise about replying or stopping (replies are never read), nothing promotional, and a hostile title cannot reshape the message", () => {
  for (const t of WHATSAPP_WEB_TEMPLATES) {
    const text = whatsAppWebText(t, { ...ctx, manageUrl: MANAGE })!;
    assert.doesNotMatch(text, /\bSTOP\b|reply|unsubscribe|offer|discount/i, t);
  }
  const hostile = whatsAppWebText("booking-confirmation", { ...ctx, serviceTitle: "Call\n\nFREE MONEY\t\u0000 now", influencerName: "A\r\nB" })!;
  assert.ok(!/\u0000|\t|\r/.test(hostile));
  assert.match(hostile, /Session: Call FREE MONEY now with A B\n/);
  // Empty names fall back to neutral words rather than an empty signature.
  assert.ok(whatsAppWebText("reminder-15m", { ...ctx, serviceTitle: " ", influencerName: "" })!.endsWith("- your host"));
});

test("the test message carries no customer data and does not ask for a reply", () => {
  const text = whatsAppWebTestText("Session Automation");
  assert.match(text, /^This is a test message from Session Automation\./);
  assert.match(text, /do not need to reply/);
  assert.ok(whatsAppWebTestText("   ").includes("Your booking page"));
});

test("maskE164 hides the middle of a number and gives up on a short or missing one", () => {
  assert.equal(maskE164("+919876543210"), "+91 ••••••• 210");
  assert.equal(maskE164("+1 415 555 0100"), "+14 •••••• 100");
  assert.equal(maskE164("123"), null);
  assert.equal(maskE164(null), null);
  assert.equal(maskE164(undefined), null);
});

// ---- delivery receipts -----------------------------------------------------------------------------------------------------

test("WhatsApp's states map onto the message statuses", () => {
  assert.equal(messageStatusFor("sent"), "SENT");
  assert.equal(messageStatusFor("delivered"), "DELIVERED");
  assert.equal(messageStatusFor("read"), "READ");
  assert.equal(messageStatusFor("failed"), "FAILED");
});

function fakeDb(initial: { id: string; status: "SENT" | "DELIVERED" | "READ" | "FAILED" | "PENDING" } | null) {
  const calls: { op: string; influencerId: string; providerMessageId: string; status?: MessageDeliveryStatus }[] = [];
  const state = { row: initial, failures: 0 };
  const order = ["PENDING", "SENT", "DELIVERED", "READ", "FAILED"];
  const db: DeliveryDb = {
    async advance(influencerId, providerMessageId, status) {
      calls.push({ op: "advance", influencerId, providerMessageId, status });
      if (state.failures > 0) {
        state.failures--;
        throw new Error("database down");
      }
      const row = state.row;
      if (!row) return 0;
      const mayAdvance = status === "READ" || status === "FAILED" ? ["SENT", "DELIVERED"] : ["SENT"];
      if (!mayAdvance.includes(row.status) || order.indexOf(status) <= order.indexOf(row.status) && status !== "FAILED") return 0;
      row.status = status;
      return 1;
    },
    async exists(influencerId, providerMessageId) {
      calls.push({ op: "exists", influencerId, providerMessageId });
      return state.row !== null;
    },
  };
  return { db, calls, state };
}

function manualSchedule() {
  const queued: { fn: () => void; ms: number }[] = [];
  return { schedule: (fn: () => void, ms: number) => void queued.push({ fn, ms }), queued };
}

test("a receipt moves the row forward only: sent -> delivered -> read, never back, and a failure only from sent or delivered", async () => {
  const { db, state } = fakeDb({ id: "m1", status: "SENT" });
  const handle = createDeliveryHandler({ db, schedule: manualSchedule().schedule, log: () => {} });
  await handle("inf1", { providerMessageId: "wamid-1", status: "delivered" });
  assert.equal(state.row!.status, "DELIVERED");
  await handle("inf1", { providerMessageId: "wamid-1", status: "sent" }); // a late "sent" changes nothing
  assert.equal(state.row!.status, "DELIVERED");
  await handle("inf1", { providerMessageId: "wamid-1", status: "read" });
  assert.equal(state.row!.status, "READ");
  await handle("inf1", { providerMessageId: "wamid-1", status: "delivered" }); // a late "delivered" cannot pull it back
  assert.equal(state.row!.status, "READ");
});

test("a receipt that arrives before the send is recorded is tried again later, a bounded number of times, then dropped", async () => {
  const { db, calls, state } = fakeDb(null);
  const { schedule, queued } = manualSchedule();
  const handle = createDeliveryHandler({ db, schedule, log: () => {}, retryDelaysMs: [2_000, 10_000] });
  await handle("inf1", { providerMessageId: "wamid-2", status: "delivered" });
  assert.deepEqual(queued.map((q) => q.ms), [2_000]);
  state.row = { id: "m2", status: "SENT" }; // the send gets recorded
  queued.shift()!.fn();
  await settle();
  assert.equal(state.row.status, "DELIVERED");
  assert.equal(queued.length, 0, "done once it applied");

  // Never recorded: two retries, then it gives up (a receipt for a message we have no row for is not kept).
  const none = fakeDb(null);
  const s2 = manualSchedule();
  const h2 = createDeliveryHandler({ db: none.db, schedule: s2.schedule, log: () => {}, retryDelaysMs: [1_000, 5_000] });
  await h2("inf1", { providerMessageId: "wamid-3", status: "read" });
  while (s2.queued.length) {
    s2.queued.shift()!.fn();
    await settle();
  }
  assert.equal(none.calls.filter((c) => c.op === "advance").length, 3, "first try plus two retries");
  assert.ok(calls.length > 0);
});

test("a receipt for a row that exists but is already past that state is not retried, and a failing database never throws", async () => {
  const { db, state } = fakeDb({ id: "m3", status: "READ" });
  const s = manualSchedule();
  await createDeliveryHandler({ db, schedule: s.schedule, log: () => {} })("inf1", { providerMessageId: "wamid-4", status: "delivered" });
  assert.equal(s.queued.length, 0);
  assert.equal(state.row!.status, "READ");

  const broken = fakeDb({ id: "m4", status: "SENT" });
  broken.state.failures = 5;
  const lines: string[] = [];
  await createDeliveryHandler({ db: broken.db, schedule: s.schedule, log: (l) => lines.push(l) })("inf1", { providerMessageId: "wamid-5", status: "read" });
  assert.equal(lines.length, 1);
  assert.ok(!lines[0].includes("wamid-5"), "the log line names no message");
});

test("a failed receipt records plain wording and the status of nothing else", () => {
  assert.match(DELIVERY_FAILED_TEXT, /not delivered/);
});

// ---- the activity observer ---------------------------------------------------------------------------------------------------

function observed() {
  const entries: { influencerId: string; action: ActivityAction; detail: Record<string, unknown> }[] = [];
  let current: SessionRow = newRow("inf1", { status: "NOT_LINKED" });
  const inner: SessionRepo = {
    listManageable: async () => [current],
    get: async () => ({ ...current }),
    update: async (_id: string, patch: SessionPatch) => void Object.assign(current, patch),
    incrementSent: async () => {},
    authStorage: () => ({ load: async () => null, save: async () => {}, clear: async () => {} }),
  };
  const repo = observeSessionRepo(inner, (influencerId, action, detail) => void entries.push({ influencerId, action, detail }));
  return { repo, entries, row: () => current };
}

test("the first link is recorded with a masked tail; a reconnect, a resume and unrelated updates are not", async () => {
  const o = observed();
  await o.repo.update("inf1", { lastErrorCode: null }); // no status: nothing
  await o.repo.update("inf1", { status: "PENDING_QR" });
  await o.repo.update("inf1", { status: "LINKED", phoneE164: "+919876543210", deviceLabel: "Chrome" });
  assert.deepEqual(o.entries, [{ influencerId: "inf1", action: "whatsapp_web.linked", detail: { phone: "+91 ••••••• 210" } }]);
  await o.repo.update("inf1", { status: "RECONNECTING" });
  await o.repo.update("inf1", { status: "LINKED", phoneE164: "+919876543210" }); // back after a drop
  await o.repo.update("inf1", { status: "LINKED", phoneE164: "+919876543210" }); // and the same state again
  assert.equal(o.entries.length, 1);
  assert.ok(!JSON.stringify(o.entries).includes("9876543210"), "never the full number");
});

test("a suspension and a logout by the phone are recorded once each, with a short code and nothing else", async () => {
  const o = observed();
  await o.repo.update("inf1", { status: "LINKED", phoneE164: "+919876543210" });
  await o.repo.update("inf1", { status: "SUSPENDED", suspendedReason: "Sending failed three times", lastErrorCode: "send-failures", lastErrorText: "text" });
  await o.repo.update("inf1", { status: "SUSPENDED", lastErrorCode: "send-failures" });
  await o.repo.update("inf1", { status: "LOGGED_OUT", lastErrorCode: "logged-out" });
  await o.repo.update("inf1", { status: "LOGGED_OUT" });
  assert.deepEqual(
    o.entries.map((e) => [e.action, e.detail]),
    [
      ["whatsapp_web.linked", { phone: "+91 ••••••• 210" }],
      ["whatsapp_web.suspended", { code: "send-failures" }],
      ["whatsapp_web.disconnected", { reason: "logged-out" }],
    ],
  );
  // The write itself still happened.
  assert.equal(o.row().status, "LOGGED_OUT");
});

test("a recorder that throws never breaks the session update", async () => {
  const repo = observeSessionRepo(
    { listManageable: async () => [], get: async () => newRow("inf1"), update: async () => {}, incrementSent: async () => {}, authStorage: () => ({ load: async () => null, save: async () => {}, clear: async () => {} }) },
    () => {
      throw new Error("log down");
    },
  );
  await repo.update("inf1", { status: "LINKED", phoneE164: "+919876543210" });
});

test("the four new activity actions: allowlisted detail keys only, wording without a number", () => {
  const actions = ["whatsapp_web.consent", "whatsapp_web.linked", "whatsapp_web.disconnected", "whatsapp_web.suspended"] as const;
  for (const a of actions) {
    const hostile = sanitiseActivityDetail(a, { version: "v1", phone: "+91 ••••••• 210", reason: "admin", code: "x", customerPhone: "+919999999999", qr: "2@SECRET", auth: "blob" });
    for (const key of Object.keys(hostile ?? {})) assert.ok(ACTIVITY_DETAIL_KEYS[a].includes(key), `${a}.${key}`);
    assert.ok(!JSON.stringify(hostile ?? {}).match(/9999999999|SECRET|blob/), a);
  }
  assert.equal(summariseActivity("whatsapp_web.linked", { phone: "+91 ••••••• 210" }), "WhatsApp number linked by QR code (+91 ••••••• 210)");
  assert.equal(summariseActivity("whatsapp_web.disconnected", { reason: "admin" }), "WhatsApp QR-code link removed (removed by the platform)");
  assert.equal(summariseActivity("whatsapp_web.disconnected", { reason: "logged-out" }), "WhatsApp QR-code link removed (WhatsApp logged the device out)");
  assert.equal(summariseActivity("whatsapp_web.suspended", { code: "send-failures" }), "WhatsApp QR-code sending paused");
  assert.equal(summariseActivity("whatsapp_web.consent", { version: "v1" }), "WhatsApp QR-code risk statement accepted");
});
