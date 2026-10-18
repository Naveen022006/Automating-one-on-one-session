import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { approveNotice, declineDialogText, declineNotice, manageStatusNotice } from "../web/src/lib/request-flow-ui";

// Pure tests (no browser, no server): the words the dashboard and the customer's manage page show around the booking-request flow, and
// that the dashboard component uses them. The server side is tests/request-whatsapp.test.ts.

const LINK = "https://app.example.com/pay/tok123";
const src = (rel: string) => readFileSync(path.join(import.meta.dirname, "..", rel), "utf8");
const queued = (messageRoute: string) => ({ messageRoute, messageQueued: true });

test("approve: e-mailed, and the message is on its way by each route", () => {
  const wa = approveNotice({ ok: true, emailed: true, ...queued("whatsapp-linked") } as never);
  assert.equal(wa.text, "Approved. The customer was e-mailed a link to pay, and it is on its way to their WhatsApp.");
  assert.equal(wa.tone, "success");
  assert.equal(wa.payLink, null, "no link to hand over: the customer has it");
  assert.equal(approveNotice({ emailed: true, ...queued("whatsapp-official") }).text, wa.text, "the official connection is WhatsApp too");
  assert.equal(approveNotice({ emailed: true, ...queued("sms") }).text, "Approved. The customer was e-mailed a link to pay, and it is on its way to their phone by SMS.");
});

test("approve: e-mailed and nothing else is on its way: as before (and an older server that does not say is read as e-mailed)", () => {
  assert.equal(approveNotice({ emailed: true, messageRoute: "none", messageQueued: false }).text, "Approved. The customer was e-mailed a link to pay.");
  assert.equal(approveNotice({ emailed: true }).text, "Approved. The customer was e-mailed a link to pay.");
  assert.equal(approveNotice({}).text, "Approved. The customer was e-mailed a link to pay.");
  assert.equal(approveNotice({ emailed: true, warning: "The slot is close." }).text, "Approved. The customer was e-mailed a link to pay. The slot is close.");
});

test("approve: not e-mailed but a message is on its way: a success, no link to send yourself", () => {
  const wa = approveNotice({ emailed: false, ...queued("whatsapp-linked") });
  assert.equal(wa.text, "Approved. The payment link is on its way to the customer's WhatsApp. They could not be e-mailed.");
  assert.equal(wa.tone, "success");
  assert.equal(wa.payLink, null);
  const sms = approveNotice({ emailed: false, ...queued("sms") });
  assert.equal(sms.text, "Approved. The payment link is on its way to the customer's phone by SMS. They could not be e-mailed.");
  assert.equal(sms.tone, "success");
  assert.doesNotMatch(wa.text + sms.text, /was e-mailed|was emailed/, "never says e-mailed for a message that was not sent");
});

test("approve: not e-mailed and no route (or nothing queued): the red 'send it yourself' answer with the link", () => {
  for (const reply of [
    { emailed: false, messageRoute: "none", messageQueued: false, payLink: LINK },
    { emailed: false, messageRoute: "whatsapp-linked", messageQueued: false, payLink: LINK }, // a route existed but the queue did not take the job
    { emailed: false, messageRoute: "sms", messageQueued: false, payLink: LINK },
    { emailed: false, payLink: LINK }, // an answer without the new fields says nothing is on its way
  ]) {
    const n = approveNotice(reply);
    assert.equal(n.text, "Approved, but the customer could not be e-mailed. Send them the payment link yourself.", JSON.stringify(reply));
    assert.equal(n.tone, "error");
    assert.equal(n.payLink, LINK);
    assert.match(n.payLinkDialog, /could not be reached/);
    assert.match(n.payLinkDialog, /no WhatsApp or SMS route/);
    assert.match(n.payLinkDialog, /only copy shown/);
  }
  // No link in the answer (it should not happen): the toast still says what to do and nothing breaks.
  assert.equal(approveNotice({ emailed: false }).payLink, null);
  assert.equal(approveNotice({ emailed: false, payLink: "" }).payLink, null);
  assert.equal(approveNotice({ emailed: false, payLink: 42 }).payLink, null, "only a string is a link");
});

test("a message is 'on its way' only when a known route AND a queued job are both reported, exactly", () => {
  const plain = "Approved. The customer was e-mailed a link to pay.";
  for (const odd of [
    { messageRoute: "whatsapp-linked", messageQueued: "true" },
    { messageRoute: "whatsapp-linked", messageQueued: 1 },
    { messageRoute: "whatsapp-linked" },
    { messageQueued: true },
    { messageRoute: "none", messageQueued: true },
    { messageRoute: "telegram", messageQueued: true },
    { messageRoute: 7, messageQueued: true },
  ]) {
    assert.equal(approveNotice({ emailed: true, ...odd }).text, plain, JSON.stringify(odd));
    assert.equal(declineNotice(odd).text, "Request declined.", JSON.stringify(odd));
  }
});

test("decline: says how the customer is being told, only when a message is queued", () => {
  assert.equal(declineNotice(queued("whatsapp-linked")).text, "Request declined. The customer is being told on WhatsApp.");
  assert.equal(declineNotice(queued("whatsapp-official")).text, "Request declined. The customer is being told on WhatsApp.");
  assert.equal(declineNotice(queued("sms")).text, "Request declined. The customer is being told by SMS.");
  assert.equal(declineNotice({ messageRoute: "none", messageQueued: false }).text, "Request declined.");
  assert.equal(declineNotice({ messageRoute: "whatsapp-linked", messageQueued: false }).text, "Request declined.");
  assert.match(declineDialogText("Asha"), /Asha is told that the request was not accepted, by e-mail and by WhatsApp or SMS where this site can send it and they allowed it\. They have not been charged\./);
});

test("the customer's manage page says what a request, an accepted request and a lapsed one are waiting for, without promising a channel", () => {
  const requested = manageStatusNotice("REQUESTED", "Sam Rao")!;
  assert.match(requested.text, /Sam Rao has your request and has not answered yet\. Nothing has been charged\. You will be told as soon as they answer\./);
  for (const status of ["HELD", "PENDING_PAYMENT"]) assert.match(manageStatusNotice(status, "Sam Rao")!.text, /accepted your request.*payment link you were sent.*released/, status);
  const expired = manageStatusNotice("EXPIRED", "Sam Rao")!;
  assert.equal(expired.tone, "warning");
  assert.match(expired.text, /not confirmed in time.*Nothing was charged/);
  for (const status of ["PAID", "SCHEDULED", "COMPLETED", "CANCELLED", "FAILED"]) assert.equal(manageStatusNotice(status, "Sam Rao"), null, `${status} keeps its own page content`);
});

test("the dashboard component and the pages use these words (and the old sentences are gone)", () => {
  const board = src("web/src/components/app/SessionsBoard.tsx");
  assert.match(board, /approveNotice\(r\.data\)/);
  assert.match(board, /declineNotice\(r\.data\)/);
  assert.match(board, /declineDialogText\(detail\.customerName\)/);
  assert.ok(!board.includes("The customer was emailed a link to pay"), "the fixed sentence is replaced by the one that depends on the reply");
  assert.ok(!board.includes("is emailed that the request was not accepted"));
  assert.ok(!/whatsappQueued/.test(board + src("web/src/lib/request-flow-ui.ts")), "the browser reads the route and the queued flag, not a WhatsApp-only flag");
  assert.match(src("web/src/pages/booking/ManageBooking.tsx"), /manageStatusNotice\(status, data\.influencerName\)/);
  // Every request message has a label in both message lists (the e-mail row and the WhatsApp row share the key).
  for (const file of ["web/src/components/app/SessionsBoard.tsx", "web/src/components/views/dashboard/MessagesView.tsx"]) {
    const code = src(file);
    for (const key of ["request-received", "request-approved", "request-declined", "request-expired"]) assert.ok(code.includes(`"${key}": TEMPLATE_LABELS["${key}"]`), `${file}: ${key}`);
  }
});
