import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { mock, test } from "node:test";
import { canMessageOnWhatsApp, queueRequestMessage } from "../lib/request-messages";

// Pure tests (no database, no Redis): the best-effort queueing helper, the worker's job wrapper that keeps a payment link out of a
// failed job's reason, and the wiring of the triggers. The end-to-end flow is tests/request-whatsapp.test.ts.

const LINK = "https://app.example.com/pay/eyJiIjoiYmtfMSIsImV4cCI6MX0.c2ln-NATURE_123";
const contact = { id: "bk_1", influencerId: "inf_1", whatsappOptIn: true, whatsappE164: "+919876543210", redactedAt: null };
const src = (rel: string) => readFileSync(path.join(import.meta.dirname, "..", rel), "utf8");

test("canMessageOnWhatsApp: opted in, a number, and not erased", () => {
  assert.equal(canMessageOnWhatsApp(contact), true);
  assert.equal(canMessageOnWhatsApp({ ...contact, whatsappOptIn: false }), false);
  assert.equal(canMessageOnWhatsApp({ ...contact, whatsappE164: "" }), false);
  assert.equal(canMessageOnWhatsApp({ ...contact, whatsappE164: null }), false);
  assert.equal(canMessageOnWhatsApp({ ...contact, redactedAt: new Date() }), false);
});

test("queueRequestMessage: queues only when a route to the customer exists; says which route and whether the job is on the queue; never throws; the log lines have no link", async () => {
  const calls: [string, string][] = [];
  const ok = async (id: string, template: string) => void calls.push([id, template]);
  const routeCalls: string[] = [];
  const via = (route: "whatsapp-linked" | "whatsapp-official" | "sms" | "none") => async (influencerId: string, template: string) => {
    routeCalls.push(`${influencerId}:${template}`);
    return route;
  };

  for (const route of ["whatsapp-linked", "whatsapp-official", "sms"] as const) {
    calls.length = 0;
    assert.deepEqual(await queueRequestMessage(contact, "request-received", { enqueue: ok, route: via(route) }), { route, queued: true });
    assert.deepEqual(calls, [["bk_1", "request-received"]], route);
  }
  assert.deepEqual(routeCalls.slice(0, 1), ["inf_1:request-received"], "the route is worked out for THIS influencer and THIS message");

  // No route: nothing is queued at all (a job could only fail).
  calls.length = 0;
  assert.deepEqual(await queueRequestMessage(contact, "request-approved", { enqueue: ok, route: via("none") }), { route: "none", queued: false });
  assert.deepEqual(calls, []);

  // A customer who cannot be messaged: no route lookup, no job.
  routeCalls.length = 0;
  for (const c of [{ ...contact, whatsappOptIn: false }, { ...contact, redactedAt: new Date() }, { ...contact, whatsappE164: "" }, { ...contact, whatsappE164: null }]) {
    assert.deepEqual(await queueRequestMessage(c, "request-received", { enqueue: ok, route: via("whatsapp-linked") }), { route: "none", queued: false });
  }
  assert.deepEqual([calls.length, routeCalls.length], [0, 0], "not even looked at");

  const lines: string[] = [];
  const realError = console.error;
  console.error = (...a: unknown[]) => void lines.push(a.join(" "));
  try {
    const failing = async () => {
      throw new Error(`connect ECONNREFUSED; payload ${LINK}`);
    };
    assert.deepEqual(await queueRequestMessage(contact, "request-approved", { enqueue: failing, route: via("whatsapp-linked") }), { route: "whatsapp-linked", queued: false }, "a route existed; the queue did not take it");
    const stuck = async () => {
      throw "a string, not an Error";
    };
    assert.deepEqual(await queueRequestMessage(contact, "request-declined", { enqueue: stuck, route: via("sms") }), { route: "sms", queued: false });
    // The route lookup itself failing (the database) is also survived: nothing is queued, and the line says why without the error's other text.
    const broken = async () => {
      throw new Error(`database said ${LINK}`);
    };
    assert.deepEqual(await queueRequestMessage(contact, "request-declined", { enqueue: ok, route: broken }), { route: "none", queued: false });
  } finally {
    console.error = realError;
  }
  assert.equal(lines.length, 3);
  assert.ok(lines[0].includes('could not queue "request-approved" for booking bk_1'));
  assert.ok(lines[2].includes("could not work out how to reach the customer"));
  assert.ok(!lines.join("\n").includes("/pay/") && lines[0].includes("[payment link]"), lines.join("\n"));
});

test("the worker's send-message job keeps a payment link out of the reason of a failed request message, and leaves every other error alone", async () => {
  let fail: () => Error = () => new Error(`WhatsApp refused ${LINK} as a parameter`);
  mock.module("../lib/messaging", { namedExports: { sendMessageForBooking: async () => Promise.reject(fail()) } });
  const { handleSendMessage } = await import("../worker/jobs/sendMessage");
  const job = (template: string) => ({ data: { bookingId: "bk_1", template } }) as never;

  // The message is the whole story that BullMQ keeps in Redis and the health page shows.
  await assert.rejects(handleSendMessage(job("request-approved")), (e: unknown) => e instanceof Error && e.message === "WhatsApp refused [payment link] as a parameter");
  await assert.rejects(handleSendMessage(job("request-declined")), (e: unknown) => e instanceof Error && !e.message.includes("/pay/"));

  const plain = new Error("WhatsApp is down");
  fail = () => plain;
  await assert.rejects(handleSendMessage(job("request-approved")), (e: unknown) => e === plain, "an error without a link is passed on untouched (same object, same stack)");
  // Another message's error is not rewritten, whatever it says (only the booking-request messages carry a payment link).
  const other = new Error(`odd text with ${LINK}`);
  fail = () => other;
  await assert.rejects(handleSendMessage(job("booking-confirmation")), (e: unknown) => e === other);
});

test("the triggers are wired where the design says, and each one is best effort", () => {
  const hold = src("app/api/bookings/hold/route.ts");
  assert.match(hold, /await queueRequestMessage\(\{ \.\.\.booking, influencerId: service\.influencerId \}, REQUEST_RECEIVED_TEMPLATE\);\s*\n\s*await notifyRequestCreated\(booking\.id\);/, "request-received is queued next to the e-mail receipt, in the request branch only");
  assert.ok(hold.indexOf("await queueRequestMessage(") > hold.indexOf("await createHold("), "after the hold is committed");

  const approval = src("lib/booking-approval.ts");
  assert.match(approval, /deps\.queueMessage\(\{ \.\.\.b, influencerId \}, REQUEST_APPROVED_TEMPLATE\)/);
  assert.match(approval, /deps\.queueMessage\(\{ \.\.\.b, influencerId \}, REQUEST_DECLINED_TEMPLATE\)/);
  assert.ok(approval.indexOf("if (count === 0) throw new ApprovalError(\"This request changed while you were approving it") < approval.indexOf("deps.queueMessage({ ...b, influencerId }, REQUEST_APPROVED_TEMPLATE)"), "queued only after the conditional update succeeded");
  assert.ok(!/\$transaction/.test(approval), "never inside a database transaction that could still roll back");

  const worker = src("worker/index.ts");
  assert.match(worker, /expireStaleHoldsAndNotify\(\)/, "the worker's hold expiry is the one that tells customers");
  assert.ok(!/expireStaleHolds\(\)/.test(worker));

  const decision = src("app/api/dashboard/bookings/[id]/decision/route.ts");
  assert.match(decision, /messageRoute, messageQueued/);
  assert.ok(!/whatsappQueued/.test(decision), "the answer names the route and whether a job is queued, not a WhatsApp-only flag");

  // The job data is the booking id and the template, nothing else (lib/queue.ts enqueueSendMessage).
  assert.match(src("lib/queue.ts"), /"send-message",\s*\{ bookingId, template \}/);
});

test("production code logs ids, statuses and redacted errors for these messages, never a message text or a payment link", () => {
  const consoleLines = (file: string) => src(file).split(/\r?\n/).filter((l) => /console\.(log|info|warn|error|debug)\(/.test(l));
  for (const file of ["lib/request-messages.ts", "lib/request-message-context.ts", "lib/booking-approval.ts", "worker/jobs/sendMessage.ts", "lib/messaging.ts", "worker/index.ts"]) {
    for (const line of consoleLines(file)) {
      assert.ok(!/payUrl|payLink|\$\{text\}|\$\{body\}|context/.test(line), `${file}: ${line.trim()}`);
    }
  }
  // Every place that logs an error from a send goes through errText (which redacts), not the raw error.
  assert.ok(!/console\.\w+\([^)]*\$\{(whatsappError|smsError)\}/.test(src("lib/messaging.ts")));
});
