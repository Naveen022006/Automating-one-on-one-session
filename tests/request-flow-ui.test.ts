import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { approveNotice, declineDialogText, declineNotice, manageStatusNotice } from "../web/src/lib/request-flow-ui";

// Pure tests (no browser, no server): the words the dashboard and the customer's manage page show around the booking-request flow, and
// that the dashboard component uses them. The server side is tests/request-whatsapp.test.ts.

const LINK = "https://app.example.com/pay/tok123";
const src = (rel: string) => readFileSync(path.join(import.meta.dirname, "..", rel), "utf8");

test("approve: e-mailed and WhatsApp on its way", () => {
  const n = approveNotice({ ok: true, emailed: true, whatsappQueued: true } as never);
  assert.equal(n.text, "Approved. The customer was e-mailed a link to pay, and it is on its way to their WhatsApp.");
  assert.equal(n.tone, "success");
  assert.equal(n.payLink, null, "no link to hand over: the customer has it");
});

test("approve: e-mailed only, as before (and an older server that does not say is read as e-mailed)", () => {
  assert.equal(approveNotice({ emailed: true, whatsappQueued: false }).text, "Approved. The customer was e-mailed a link to pay.");
  assert.equal(approveNotice({ emailed: true }).text, "Approved. The customer was e-mailed a link to pay.");
  assert.equal(approveNotice({}).text, "Approved. The customer was e-mailed a link to pay.");
  assert.equal(approveNotice({ emailed: true, warning: "The slot is close." }).text, "Approved. The customer was e-mailed a link to pay. The slot is close.");
});

test("approve: not e-mailed but on its way to WhatsApp: a success, and the link is kept as a backup", () => {
  const n = approveNotice({ emailed: false, whatsappQueued: true, payLink: LINK });
  assert.equal(n.text, "Approved. The payment link is on its way to the customer's WhatsApp. They could not be e-mailed.");
  assert.equal(n.tone, "success");
  assert.equal(n.payLink, LINK);
  assert.match(n.payLinkDialog, /on its way to their WhatsApp/);
  assert.match(n.payLinkDialog, /backup|in case/i);
  assert.doesNotMatch(n.text, /was e-mailed|was emailed/, "never says e-mailed for a message that was not sent");
});

test("approve: reached by neither e-mail nor WhatsApp: an error, and the link is the only route", () => {
  const n = approveNotice({ emailed: false, whatsappQueued: false, payLink: LINK });
  assert.equal(n.text, "Approved, but the customer could not be e-mailed. Send them the payment link yourself.");
  assert.equal(n.tone, "error");
  assert.equal(n.payLink, LINK);
  assert.match(n.payLinkDialog, /not e-mailed/);
  assert.match(n.payLinkDialog, /only copy shown/);
  // No link in the answer (it should not happen): the toast still says what to do and nothing breaks.
  assert.equal(approveNotice({ emailed: false }).payLink, null);
  assert.equal(approveNotice({ emailed: false, payLink: "" }).payLink, null);
  assert.equal(approveNotice({ emailed: false, payLink: 42 }).payLink, null, "only a string is a link");
});

test("whatsappQueued is only believed when it is exactly true", () => {
  for (const odd of ["true", 1, "yes", {}, null, undefined]) assert.equal(approveNotice({ emailed: true, whatsappQueued: odd }).text, "Approved. The customer was e-mailed a link to pay.", String(odd));
  for (const odd of ["true", 1, null, undefined, false]) assert.equal(declineNotice({ whatsappQueued: odd }).text, "Request declined.", String(odd));
});

test("decline: says the customer is being told on WhatsApp only when it is queued", () => {
  assert.equal(declineNotice({ whatsappQueued: true }).text, "Request declined. The customer is being told on WhatsApp.");
  assert.equal(declineNotice({ whatsappQueued: false }).text, "Request declined.");
  assert.match(declineDialogText("Asha"), /Asha is told that the request was not accepted, by e-mail and on WhatsApp where they allowed it\. They have not been charged\./);
});

test("the customer's manage page says what a request, an accepted request and a lapsed one are waiting for", () => {
  const requested = manageStatusNotice("REQUESTED", "Sam Rao")!;
  assert.match(requested.text, /Sam Rao has your request and has not answered yet\. Nothing has been charged\./);
  for (const status of ["HELD", "PENDING_PAYMENT"]) assert.match(manageStatusNotice(status, "Sam Rao")!.text, /accepted your request.*payment link we sent you on WhatsApp or by e-mail.*released/, status);
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
  assert.match(src("web/src/pages/booking/ManageBooking.tsx"), /manageStatusNotice\(status, data\.influencerName\)/);
  // Every request message has a label in both message lists (the e-mail and the WhatsApp row share the key).
  for (const file of ["web/src/components/app/SessionsBoard.tsx", "web/src/components/views/dashboard/MessagesView.tsx"]) {
    const code = src(file);
    for (const key of ["request-received", "request-approved", "request-declined", "request-expired"]) assert.ok(code.includes(`"${key}": TEMPLATE_LABELS["${key}"]`), `${file}: ${key}`);
  }
});
