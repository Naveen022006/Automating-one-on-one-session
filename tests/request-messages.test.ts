import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { mock, test } from "node:test";
import { NoMessageRouteError, sendSMS, smsConfigProblem } from "../lib/sms";
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
  assert.ok(!lines.join("\n").includes("/pay/") && lines[0].includes("[link removed]"), lines.join("\n"));
});

test("the worker's send-message job keeps payment and manage links out of the reason of a failed message, and leaves an error without one alone", async () => {
  let fail: () => Error = () => new Error(`WhatsApp refused ${LINK} as a parameter`);
  mock.module("../lib/messaging", { namedExports: { sendMessageForBooking: async () => Promise.reject(fail()) } });
  const { handleSendMessage } = await import("../worker/jobs/sendMessage");
  const job = (template: string) => ({ data: { bookingId: "bk_1", template } }) as never;

  // The message is the whole story that BullMQ keeps in Redis and the health page shows.
  await assert.rejects(handleSendMessage(job("request-approved")), (e: unknown) => e instanceof Error && e.message === "WhatsApp refused [link removed] as a parameter");
  await assert.rejects(handleSendMessage(job("request-declined")), (e: unknown) => e instanceof Error && !e.message.includes("/pay/"));

  const plain = new Error("WhatsApp is down");
  fail = () => plain;
  await assert.rejects(handleSendMessage(job("request-approved")), (e: unknown) => e === plain, "an error without a link is passed on untouched (same object, same stack)");
  // Any message: the manage link is a bearer link too, and the QR texts of the booking events carry it.
  const manage = new Error("Graph said: https:\\/\\/app.example.com\\/manage\\/eyJiIjoiYmtfMSJ9.abc");
  fail = () => manage;
  await assert.rejects(handleSendMessage(job("booking-confirmation")), (e: unknown) => e instanceof Error && e.message === "Graph said: [link removed]");
  fail = () => new Error("an error without any link");
  await assert.rejects(handleSendMessage(job("booking-confirmation")), (e: unknown) => e instanceof Error && e.message === "an error without any link");
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

test("SMS configuration: one check tells whether a message can go by SMS, and sendSMS refuses with a typed, non-retryable error before any network call", async () => {
  const none: Record<string, string | undefined> = {};
  assert.match(smsConfigProblem("request-approved", none) ?? "", /SMS_API_URL \/ SMS_API_KEY are missing/, "the default provider needs a URL and a key");
  assert.equal(smsConfigProblem("request-approved", { SMS_API_URL: "https://x.test", SMS_API_KEY: "k" }), null);
  assert.match(smsConfigProblem("request-approved", { SMS_API_URL: "https://x.test" }) ?? "", /missing/);

  const msg91 = { SMS_PROVIDER: "msg91", SMS_API_KEY: "k" };
  assert.match(smsConfigProblem("request-approved", msg91) ?? "", /no flow for this message/);
  assert.equal(smsConfigProblem("request-approved", { ...msg91, MSG91_TEMPLATE_REQUEST_APPROVED: "f1" }), null);
  assert.match(smsConfigProblem("request-declined", { ...msg91, MSG91_TEMPLATE_REQUEST_APPROVED: "f1" }) ?? "", /no flow/, "a flow id belongs to its own message");
  assert.equal(smsConfigProblem("request-declined", { ...msg91, MSG91_TEMPLATE_DEFAULT: "d" }), null, "the default flow carries any message");
  assert.equal(smsConfigProblem(undefined, { ...msg91, MSG91_TEMPLATE_DEFAULT: "d" }), null);
  assert.match(smsConfigProblem("request-approved", { SMS_PROVIDER: "msg91", MSG91_TEMPLATE_DEFAULT: "d" }) ?? "", /SMS_API_KEY/);

  const twilio = { SMS_PROVIDER: "Twilio", TWILIO_ACCOUNT_SID: "AC", TWILIO_AUTH_TOKEN: "t" };
  assert.match(smsConfigProblem("x", twilio) ?? "", /no sender/);
  assert.equal(smsConfigProblem("x", { ...twilio, TWILIO_FROM: "+1555" }), null);
  assert.equal(smsConfigProblem("x", { ...twilio, TWILIO_MESSAGING_SERVICE_SID: "MG" }), null);
  assert.match(smsConfigProblem("x", { SMS_PROVIDER: "twilio" }) ?? "", /credentials are missing/);
  assert.equal(smsConfigProblem("x", { MESSAGING_DRY_RUN: "true" }), null, "a dry run only logs");

  const saved = { ...process.env };
  for (const k of ["SMS_PROVIDER", "SMS_API_KEY", "SMS_API_URL", "MSG91_TEMPLATE_DEFAULT", "MESSAGING_DRY_RUN"]) delete process.env[k];
  try {
    await assert.rejects(sendSMS({ to: "+919876543210", body: "hello", template: "request-approved" }), (e: unknown) => e instanceof NoMessageRouteError && e.retryable === false && /SMS is not set up/.test(e.message));
    process.env.MESSAGING_DRY_RUN = "true";
    const realLog = console.log;
    console.log = () => {};
    try {
      assert.match((await sendSMS({ to: "+919876543210", body: "hello", template: "request-approved" })).providerMessageId, /^dry-run-sms-/);
    } finally {
      console.log = realLog;
    }
  } finally {
    for (const k of ["SMS_PROVIDER", "SMS_API_KEY", "SMS_API_URL", "MSG91_TEMPLATE_DEFAULT", "MESSAGING_DRY_RUN"]) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
});
