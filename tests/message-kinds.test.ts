import assert from "node:assert/strict";
import { test } from "node:test";
import {
  REQUEST_APPROVED_TEMPLATE,
  REQUEST_DECLINED_TEMPLATE,
  REQUEST_EXPIRED_TEMPLATE,
  REQUEST_MESSAGE_KINDS,
  REQUEST_RECEIVED_TEMPLATE,
  isRequestMessageKind,
  messageMayBeSent,
  LINK_REMOVED,
  bearerLinkSecrets,
  redactBearerLinks,
  statusesFor,
  type BookingFacts,
} from "../lib/message-kinds";
import {
  KNOWN_TEMPLATES,
  TEMPLATE_LABELS,
  TEMPLATE_SPECS,
  describeWait,
  isMetaTemplateName,
  metaTemplateName,
  smsBody,
  templateKeyFromMetaName,
  templateLabel,
  templateParams,
  whatsappComponents,
} from "../lib/message-templates";
import { WHATSAPP_WEB_TEMPLATES, isWhatsAppWebTemplate } from "../lib/whatsapp-web/messages";

// Pure tests (no database): the one table of "which booking states may each message be sent in", shared by the sender and the linked
// number's queue, and the definitions of the four booking-request messages (Meta templates, SMS bodies, labels).

const ALL_STATUSES = ["REQUESTED", "HELD", "PENDING_PAYMENT", "PAID", "SCHEDULED", "COMPLETED", "EXPIRED", "CANCELLED", "FAILED"];
const NOW = new Date("2026-11-10T10:00:00Z");
const LATER = new Date(NOW.getTime() + 3_600_000);
const EARLIER = new Date(NOW.getTime() - 3_600_000);
const facts = (over: Partial<BookingFacts>): BookingFacts => ({ status: "PAID", holdExpiresAt: null, decidedAt: null, requiresApproval: false, hasPayment: false, receivedDelivered: false, hostSuspended: false, ...over });

test("the five booking events keep exactly the states they always had, per route", () => {
  const paidOrAfter = ["PAID", "SCHEDULED", "COMPLETED"];
  // The sender (lib/messaging.ts): paid, scheduled and completed for all of them; a cancellation notice is also for a CANCELLED booking.
  for (const t of ["booking-confirmation", "reminder-24h", "reminder-15m", "reschedule"]) assert.deepEqual(statusesFor(t, "sender"), paidOrAfter, `${t} (sender)`);
  assert.deepEqual(statusesFor("cancellation", "sender"), [...paidOrAfter, "CANCELLED"]);
  // The linked number's queue is stricter for reminders and reschedule notices, because it asks again right before the send.
  assert.deepEqual(statusesFor("booking-confirmation", "queue"), paidOrAfter);
  assert.deepEqual(statusesFor("reminder-24h", "queue"), ["SCHEDULED"]);
  assert.deepEqual(statusesFor("reminder-15m", "queue"), ["SCHEDULED"]);
  assert.deepEqual(statusesFor("reschedule", "queue"), ["PAID", "SCHEDULED"]);
  assert.deepEqual(statusesFor("cancellation", "queue"), [...paidOrAfter, "CANCELLED"]);
  // A template that is not listed (a receipt, a future one) and a queue request that names no kind: the widest rule of the first versions.
  assert.deepEqual(statusesFor("receipt", "sender"), paidOrAfter);
  assert.deepEqual(statusesFor("", "queue"), [...paidOrAfter, "CANCELLED"]);
  assert.deepEqual(statusesFor("receipt", "queue"), [...paidOrAfter, "CANCELLED"]);
  for (const t of REQUEST_MESSAGE_KINDS) assert.equal(statusesFor(t, "sender"), null, `${t}: a request message reads more than the status`);
});

test("table-driven: messageMayBeSent for the five events over every booking status, on both routes", () => {
  const sender: Record<string, string[]> = {
    "booking-confirmation": ["PAID", "SCHEDULED", "COMPLETED"],
    "reminder-24h": ["PAID", "SCHEDULED", "COMPLETED"],
    "reminder-15m": ["PAID", "SCHEDULED", "COMPLETED"],
    reschedule: ["PAID", "SCHEDULED", "COMPLETED"],
    cancellation: ["PAID", "SCHEDULED", "COMPLETED", "CANCELLED"],
  };
  const queue: Record<string, string[]> = { ...sender, "reminder-24h": ["SCHEDULED"], "reminder-15m": ["SCHEDULED"], reschedule: ["PAID", "SCHEDULED"] };
  for (const t of Object.keys(sender)) {
    for (const status of ALL_STATUSES) {
      assert.equal(messageMayBeSent(t, facts({ status }), NOW, "sender"), sender[t].includes(status), `${t}/${status} (sender)`);
      assert.equal(messageMayBeSent(t, facts({ status }), NOW, "queue"), queue[t].includes(status), `${t}/${status} (queue)`);
      // The facts of a request never change the five events.
      assert.equal(messageMayBeSent(t, facts({ status, decidedAt: EARLIER, requiresApproval: true, hasPayment: true, holdExpiresAt: EARLIER }), NOW, "sender"), sender[t].includes(status), `${t}/${status} (any facts)`);
    }
  }
});

test("the queue can never allow what the sender refuses, for any message and any state (so the two cannot disagree)", () => {
  const templates = [...KNOWN_TEMPLATES, "receipt", "", "something-new"];
  const variants: Partial<BookingFacts>[] = [
    {},
    { decidedAt: EARLIER },
    { requiresApproval: true },
    { requiresApproval: true, decidedAt: EARLIER },
    { requiresApproval: true, hasPayment: true },
    { holdExpiresAt: LATER },
    { holdExpiresAt: EARLIER },
    { holdExpiresAt: LATER, decidedAt: EARLIER, requiresApproval: true },
    { requiresApproval: true, receivedDelivered: true },
    { holdExpiresAt: LATER, decidedAt: EARLIER, hostSuspended: true },
  ];
  for (const t of templates) {
    for (const status of ALL_STATUSES) {
      for (const v of variants) {
        const f = facts({ status, ...v });
        const q = messageMayBeSent(t, f, NOW, "queue");
        const s = messageMayBeSent(t, f, NOW, "sender");
        if (isRequestMessageKind(t)) assert.equal(q, s, `${t}/${status}/${JSON.stringify(v)}: one rule for both routes`);
        else if (t !== "" && t !== "something-new" && t !== "receipt") assert.ok(!q || s, `${t}/${status}: the queue allowed what the sender refuses`);
      }
    }
  }
});

test("request-received: only a REQUESTED booking whose hold is still running", () => {
  for (const status of ALL_STATUSES) {
    assert.equal(messageMayBeSent(REQUEST_RECEIVED_TEMPLATE, facts({ status, holdExpiresAt: LATER }), NOW), status === "REQUESTED", status);
  }
  assert.equal(messageMayBeSent(REQUEST_RECEIVED_TEMPLATE, facts({ status: "REQUESTED", holdExpiresAt: EARLIER }), NOW), false, "the request lapsed: 'we received it' would be wrong");
  assert.equal(messageMayBeSent(REQUEST_RECEIVED_TEMPLATE, facts({ status: "REQUESTED", holdExpiresAt: NOW }), NOW), false, "ends exactly now: over");
  assert.equal(messageMayBeSent(REQUEST_RECEIVED_TEMPLATE, facts({ status: "REQUESTED", holdExpiresAt: null }), NOW), false);
  // Answered before the notice ran: the answer replaces it.
  assert.equal(messageMayBeSent(REQUEST_RECEIVED_TEMPLATE, facts({ status: "HELD", holdExpiresAt: LATER, decidedAt: EARLIER }), NOW), false);
});

test("request-approved: approved and unpaid (HELD or PENDING_PAYMENT) with the time to pay still ahead; a booking already paid gets the confirmation instead", () => {
  const ok = (over: Partial<BookingFacts>) => messageMayBeSent(REQUEST_APPROVED_TEMPLATE, facts({ status: "HELD", holdExpiresAt: LATER, decidedAt: EARLIER, requiresApproval: true, ...over }), NOW);
  for (const status of ALL_STATUSES) assert.equal(ok({ status }), status === "HELD" || status === "PENDING_PAYMENT", status);
  assert.equal(ok({ status: "PAID", holdExpiresAt: null }), false);
  assert.equal(ok({ status: "SCHEDULED", holdExpiresAt: null }), false);
  assert.equal(ok({ holdExpiresAt: EARLIER }), false, "the time to pay has gone: a link to a dead page is worse than nothing");
  assert.equal(ok({ holdExpiresAt: null }), false);
  assert.equal(ok({ decidedAt: null }), false, "a plain hold of a service without approval is not an accepted request");
  assert.equal(ok({ hostSuspended: true }), false, "suspended since the approval: the payment page says 'unavailable', so no 'Pay here' link");
  for (const route of ["sender", "queue"] as const) {
    assert.equal(messageMayBeSent(REQUEST_APPROVED_TEMPLATE, facts({ status: "HELD", holdExpiresAt: LATER, decidedAt: EARLIER, hostSuspended: true }), NOW, route), false, route);
  }
  // The suspension changes only the payment link: a decline or an expiry is still told to the customer.
  assert.equal(messageMayBeSent(REQUEST_DECLINED_TEMPLATE, facts({ status: "CANCELLED", decidedAt: EARLIER, hostSuspended: true }), NOW), true);
  assert.equal(messageMayBeSent(REQUEST_EXPIRED_TEMPLATE, facts({ status: "EXPIRED", requiresApproval: true, receivedDelivered: true, hostSuspended: true }), NOW), true);
  assert.equal(messageMayBeSent("booking-confirmation", facts({ status: "PAID", hostSuspended: true }), NOW), true, "a paid customer still gets the Meet link");
});

test("request-declined: CANCELLED, decided and never paid, whatever the service's approval setting is now", () => {
  const ok = (over: Partial<BookingFacts>) => messageMayBeSent(REQUEST_DECLINED_TEMPLATE, facts({ status: "CANCELLED", decidedAt: EARLIER, requiresApproval: true, ...over }), NOW);
  for (const status of ALL_STATUSES) assert.equal(ok({ status }), status === "CANCELLED", status);
  assert.equal(ok({ decidedAt: null }), false, "cancelled without the host deciding is not a decline");
  assert.equal(ok({ requiresApproval: false }), true, "a host who turned approval off can still decline the backlog: only a decline gives an unpaid booking a decision AND CANCELLED");
  assert.equal(ok({ hasPayment: true }), false, "an approved request that was paid and cancelled later is a cancellation, which has its own notice");
  assert.equal(messageMayBeSent("cancellation", facts({ status: "CANCELLED", decidedAt: EARLIER, requiresApproval: true, hasPayment: true }), NOW), true);
});

test("request-expired: EXPIRED, never decided, a service that needs approval, never paid, and the customer was told about the request (an approved hold that lapsed unpaid is not this message)", () => {
  const ok = (over: Partial<BookingFacts>) => messageMayBeSent(REQUEST_EXPIRED_TEMPLATE, facts({ status: "EXPIRED", decidedAt: null, requiresApproval: true, receivedDelivered: true, ...over }), NOW);
  for (const status of ALL_STATUSES) assert.equal(ok({ status }), status === "EXPIRED", status);
  assert.equal(ok({ decidedAt: EARLIER }), false, "approved and then not paid: out of scope, recorded as a follow-up in doc/16");
  assert.equal(ok({ requiresApproval: false }), false, "an ordinary hold that expired never gets this");
  assert.equal(ok({ hasPayment: true }), false);
  assert.equal(ok({ receivedDelivered: false }), false, "'not confirmed in time' about a request the customer never heard of goes to a stranger: not sent");
  for (const route of ["sender", "queue"] as const) assert.equal(messageMayBeSent(REQUEST_EXPIRED_TEMPLATE, facts({ status: "EXPIRED", requiresApproval: true, receivedDelivered: false }), NOW, route), false, route);
});

test("bearer links (payment and manage) are taken out of any text, in every spelling a provider can echo them", () => {
  const pay = "https://app.example.com/pay/eyJiIjoiYmtfMSJ9.abc-DEF_123xyz";
  const manage = "https://app.example.com/manage/eyJiIjoiYmtfMiJ9.qrs-TUV_456uvw";
  const escaped = (u: string) => u.replace(/\//g, "\\/"); // https:\/\/host\/pay\/TOKEN, as PHP-based APIs (MSG91) write JSON
  const twice = (u: string) => u.replace(/\//g, "\\\\/"); // JSON inside a JSON string
  for (const [name, link] of [["pay", pay], ["manage", manage]] as const) {
    for (const [form, text] of [["plain", link], ["json-escaped", escaped(link)], ["escaped twice", twice(link)], ["percent-encoded", encodeURIComponent(link)]] as const) {
      assert.equal(redactBearerLinks(`WhatsApp refused: ${text} is not allowed`), `WhatsApp refused: ${LINK_REMOVED} is not allowed`, `${name} ${form}`);
      assert.equal(redactBearerLinks(`SMS failed (400): {"body":"Open ${text}"}`), `SMS failed (400): {"body":"Open ${LINK_REMOVED}"}`, `${name} ${form} in a JSON body`);
    }
  }
  // Path-only and partly encoded spellings.
  assert.equal(redactBearerLinks("see /pay/abc123 now"), `see ${LINK_REMOVED} now`);
  assert.equal(redactBearerLinks("see \\/manage\\/abc123 and %2Fpay%2Fabc123 and %2fmanage%2fabc123"), `see ${LINK_REMOVED} and ${LINK_REMOVED} and ${LINK_REMOVED}`);
  assert.equal(redactBearerLinks("http://localhost:3000/pay/tok%2Ex and https://x.test/manage/y"), `${LINK_REMOVED} and ${LINK_REMOVED}`);
  assert.equal(redactBearerLinks(`${pay} then ${manage}`), `${LINK_REMOVED} then ${LINK_REMOVED}`);
  // Other links and words stay.
  assert.equal(redactBearerLinks("https://x.test/payouts/1 and /payments/2 and 'pay later' and /dashboard/manage-x and https://x.test/api/pay"), "https://x.test/payouts/1 and /payments/2 and 'pay later' and /dashboard/manage-x and https://x.test/api/pay");
  assert.equal(redactBearerLinks(""), "");
});

test("the exact links of one send also catch a token quoted without its path, and short strings are never treated as secrets", () => {
  const pay = "https://app.example.com/pay/eyJiIjoiYmtfMSJ9.abc-DEF_123xyz";
  const manage = "https://app.example.com/manage/eyJiIjoiYmtfMiJ9.qrs-TUV_456uvw";
  const known = bearerLinkSecrets([pay, manage, null, undefined, ""]);
  assert.ok(known.includes(pay) && known.includes(manage));
  assert.ok(known.includes("eyJiIjoiYmtfMSJ9.abc-DEF_123xyz") && known.includes("eyJiIjoiYmtfMiJ9.qrs-TUV_456uvw"), "the tokens");
  assert.ok(known.includes(encodeURIComponent(pay)) && known.includes(pay.replace(/\//g, "\\/")), "the encoded and JSON-escaped URLs");
  assert.deepEqual([...known].sort((a, b) => b.length - a.length), known, "longest first, so a URL goes before its own token");
  assert.equal(redactBearerLinks("invalid parameter eyJiIjoiYmtfMSJ9.abc-DEF_123xyz in body", known), `invalid parameter ${LINK_REMOVED} in body`);
  assert.equal(redactBearerLinks("invalid parameter eyJiIjoiYmtfMSJ9.abc-DEF_123xyz in body"), "invalid parameter eyJiIjoiYmtfMSJ9.abc-DEF_123xyz in body", "without the list a bare token is not recognisable");
  assert.deepEqual(bearerLinkSecrets(["/pay/abc"]), [], "too short to replace everywhere");
});

// ---- the definitions of the four messages ----------------------------------------------------------------------------------------

test("the four request kinds are one list everywhere: message kinds, Meta templates, linked-number texts, labels", () => {
  assert.deepEqual([...REQUEST_MESSAGE_KINDS], ["request-received", "request-approved", "request-declined", "request-expired"]);
  for (const k of REQUEST_MESSAGE_KINDS) {
    assert.ok(isRequestMessageKind(k) && KNOWN_TEMPLATES.includes(k), `${k} has a Meta template definition`);
    assert.ok(isWhatsAppWebTemplate(k) && (WHATSAPP_WEB_TEMPLATES as readonly string[]).includes(k), `${k} has a linked-number text`);
    assert.ok(TEMPLATE_LABELS[k], `${k} has a label`);
  }
  for (const t of ["booking-confirmation", "reminder-24h", "receipt", "request-cancelled", ""]) assert.equal(isRequestMessageKind(t), false, t);
  assert.deepEqual([REQUEST_RECEIVED_TEMPLATE, REQUEST_APPROVED_TEMPLATE, REQUEST_DECLINED_TEMPLATE, REQUEST_EXPIRED_TEMPLATE], [...REQUEST_MESSAGE_KINDS]);
  assert.equal(KNOWN_TEMPLATES.length, 9, "the five booking events and the four request messages");
  assert.equal(templateLabel("request-received"), "Request received");
  assert.equal(templateLabel("request-approved"), "Request accepted (payment link)");
  assert.equal(templateLabel("request-declined"), "Request declined");
  assert.equal(templateLabel("request-expired"), "Request expired");
});

test("Meta templates for the request kinds: UTILITY-ready names, sequential variables, one example each, one parameter per variable", () => {
  const expected: Record<string, { meta: string; vars: number }> = {
    "request-received": { meta: "sa_request_received", vars: 5 },
    "request-approved": { meta: "sa_request_approved", vars: 7 },
    "request-declined": { meta: "sa_request_declined", vars: 5 },
    "request-expired": { meta: "sa_request_expired", vars: 4 },
  };
  const ctx = { link: null, serviceTitle: "Career call", influencerName: "Sam Rao", when: "Mon, 12 Oct 2026, 11:00 AM IST" };
  for (const [key, want] of Object.entries(expected)) {
    const spec = TEMPLATE_SPECS[key];
    assert.equal(spec.name, want.meta);
    assert.equal(metaTemplateName(key), want.meta);
    assert.ok(isMetaTemplateName(spec.name));
    assert.equal(templateKeyFromMetaName(spec.name), key);
    const vars = [...spec.body.matchAll(/\{\{(\d+)\}\}/g)].map((m) => Number(m[1]));
    assert.deepEqual(vars, vars.map((_, i) => i + 1), `${key}: variables numbered 1..n in order`);
    assert.equal(vars.length, want.vars, `${key}: ${want.vars} variables`);
    assert.equal(spec.examples.length, vars.length, `${key}: one example per variable`);
    assert.ok(spec.examples.every((e) => e.trim().length > 0), `${key}: no empty example`);
    assert.equal(templateParams(key, ctx).length, vars.length, `${key}: one parameter per variable`);
    assert.equal(whatsappComponents(key, ctx)[0].parameters.length, vars.length);
    assert.ok(!/^\{\{/.test(spec.body) && !/\}\}$/.test(spec.body), `${key}: Meta rejects a body that starts or ends with a variable`);
    assert.ok(spec.body.length < 1024);
    assert.doesNotMatch(spec.body, /\n/, "single line, like the others");
  }
  assert.equal(new Set(KNOWN_TEMPLATES.map((k) => TEMPLATE_SPECS[k].name)).size, KNOWN_TEMPLATES.length, "Meta names are unique");
});

test("the parameters of each request template are the right values in the right order, none of them empty", () => {
  const ctx = {
    link: null,
    serviceTitle: "Career call",
    influencerName: "Sam Rao",
    when: "Thu, 12 Nov 2026, 11:00 AM IST",
    manageUrl: "https://app.test/manage/m1",
    payUrl: "https://app.test/pay/p1",
    payBy: "Fri, 13 Nov 2026, 6:00 PM IST",
    amount: "₹499.00",
    bookingPageUrl: "https://app.test/sam",
    decideWithinHours: 48,
    reason: "  Away\nthat week  ",
  };
  assert.deepEqual(templateParams("request-received", ctx), ["Career call", "Sam Rao", ctx.when, "2 days", "https://app.test/manage/m1"]);
  assert.deepEqual(templateParams("request-approved", ctx), ["Career call", "Sam Rao", ctx.when, "₹499.00", ctx.payBy, "https://app.test/pay/p1", "https://app.test/manage/m1"]);
  assert.deepEqual(templateParams("request-declined", ctx), ["Career call", "Sam Rao", ctx.when, 'Their note: "Away that week".', "https://app.test/sam"]);
  assert.deepEqual(templateParams("request-expired", ctx), ["Career call", "Sam Rao", ctx.when, "https://app.test/sam"]);
  // WhatsApp refuses an empty parameter: a missing note and missing links become short stand-ins, never "".
  for (const k of REQUEST_MESSAGE_KINDS) assert.ok(templateParams(k, { link: null, serviceTitle: "S", influencerName: "H", when: "W" }).every((p) => p.length > 0), k);
  // A decline with no note says so in a sentence: never an empty quote like Their note: "(none)".
  for (const reason of [null, undefined, "", "   "]) {
    const params = templateParams("request-declined", { ...ctx, reason });
    assert.equal(params[3], "No reason was given.", String(reason));
    assert.ok(!params.some((p) => /note|\(none\)|""/i.test(p)), "no stray quote or placeholder");
    const sms = smsBody("request-declined", { ...ctx, reason });
    assert.ok(sms.includes("No reason was given. You were not charged."), sms);
    assert.ok(!/Their note|\(none\)/.test(sms), sms);
  }
  // The body puts the sentence where the note goes; with a note it reads as before.
  assert.match(TEMPLATE_SPECS["request-declined"].body, /on \{\{3\}\}\. \{\{4\}\} You were not charged\./);
  assert.equal(TEMPLATE_SPECS["request-declined"].examples[3], 'Their note: "I am away that week".');
  assert.equal(templateParams("request-declined", { ...ctx, reason: "Line one\nline two" })[3], 'Their note: "Line one line two".');
  assert.equal(templateParams("request-received", { ...ctx, decideWithinHours: undefined })[3], "a couple of days");
});

test("SMS bodies for the request kinds say the same thing as the other channels, with the amount and the deadline in the accepted one", () => {
  const ctx = {
    link: null,
    serviceTitle: "Career call",
    influencerName: "Sam Rao",
    when: "Thu, 12 Nov 2026, 11:00 AM IST",
    manageUrl: "https://app.test/manage/m1",
    payUrl: "https://app.test/pay/p1",
    payBy: "Fri, 13 Nov 2026, 6:00 PM IST",
    amount: "₹499.00",
    bookingPageUrl: "https://app.test/sam",
    decideWithinHours: 48,
    reason: "Away that week",
  };
  const received = smsBody("request-received", ctx);
  assert.match(received, /Request received/);
  assert.ok(received.includes("Career call") && received.includes("Sam Rao") && received.includes(ctx.when) && received.includes("2 days") && received.includes(ctx.manageUrl));
  assert.match(received, /Nothing is charged yet/);
  const approved = smsBody("request-approved", ctx);
  for (const part of ["Request accepted", "₹499.00", "Fri, 13 Nov 2026, 6:00 PM IST", "https://app.test/pay/p1", ctx.when]) assert.ok(approved.includes(part), `accepted: ${part}`);
  assert.match(approved, /released/);
  const declined = smsBody("request-declined", ctx);
  for (const part of ["Request not accepted", 'Their note: "Away that week"', "You were not charged", "https://app.test/sam"]) assert.ok(declined.includes(part), `declined: ${part}`);
  const expired = smsBody("request-expired", ctx);
  for (const part of ["Request not confirmed in time", "You were not charged", "https://app.test/sam", ctx.when]) assert.ok(expired.includes(part), `expired: ${part}`);
  for (const k of REQUEST_MESSAGE_KINDS) assert.ok(!smsBody(k, ctx).includes("(link coming soon)"), k);
});

test("how long a request waits, in words", () => {
  assert.equal(describeWait(48), "2 days");
  assert.equal(describeWait(47.9), "2 days", "a request made a few seconds ago still has its two days");
  assert.equal(describeWait(72), "3 days");
  assert.equal(describeWait(71), "2 days", "never more than there is");
  assert.equal(describeWait(36), "36 hours", "no rounding up to two days");
  assert.equal(describeWait(24), "24 hours");
  assert.equal(describeWait(29.67), "29 hours", "rounded down, with a quarter of an hour of slack");
  assert.equal(describeWait(12), "12 hours");
  assert.equal(describeWait(1), "1 hour");
  assert.equal(describeWait(1.7), "1 hour");
  assert.equal(describeWait(1.8), "2 hours", "within the quarter hour of slack");
  assert.equal(describeWait(0.99), "a short time", "under an hour");
  assert.equal(describeWait(0), "a short time");
  assert.equal(describeWait(Number.NaN), "a short time");
  assert.equal(describeWait(-3), "a short time");
});
