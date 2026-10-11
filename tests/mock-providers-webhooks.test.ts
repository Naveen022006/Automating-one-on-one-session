import assert from "node:assert/strict";
import { after, afterEach, before, test } from "node:test";
import { whatsappComponents } from "../lib/message-templates";
import { sendWhatsApp } from "../lib/whatsapp";
import { ensureTemplates, registerNumber, subscribeApp } from "../lib/whatsapp-connect";
import { isVerifyRequestValid, parseTemplateStatusUpdates, parseWhatsAppStatuses, verifyMetaSignature } from "../lib/whatsapp-webhook";
import { META_APP_SECRET, PHONE_FRESH, WABA_NEW, WABA_OLD_TEMPLATE, WEBHOOK_VERIFY_TOKEN } from "../scripts/mock-providers/fixtures";
import { control, raw, setFault, startMock, startReceiver, useMockEnv, waitFor, type TestMock } from "./helpers/mock-server";

// The mock's webhooks, delivered to a local receiver that plays the app and checked with the app's OWN verifier and parsers
// (doc/11-provider-simulator.md, 4 and 6.4). The receiver's signature check is the app's verifyMetaSignature, not the mock's code.

const MGMT = "whatsapp_business_management";
const MSG = "whatsapp_business_messaging";
let t: TestMock;
let receiver: Awaited<ReturnType<typeof startReceiver>>;
let restoreEnv: () => void;
let respond: (n: number) => { status: number; body?: string } = () => ({ status: 200, body: '{"ok":true}' });
const received = () => receiver.received;

before(async () => {
  receiver = await startReceiver((n) => respond(n));
  t = await startMock(receiver.url, { webhookRetryDelaysMs: [30, 30, 30] });
  restoreEnv = useMockEnv(t.mock, receiver.url);
});
after(async () => {
  restoreEnv();
  await t.stop();
  await receiver.stop();
});
afterEach(async () => {
  respond = () => ({ status: 200, body: '{"ok":true}' });
  await control(t.mock, "/__mock/faults/clear");
});

/** A clean world with the platform app subscribed to account WABA_NEW, templates submitted and left in review. */
async function setup(): Promise<string> {
  await control(t.mock, "/__mock/reset", { confirm: "reset" });
  const token = (await control(t.mock, "/__mock/meta/mint-token", { app: "platform", scopes: [MGMT, MSG], wabaIds: [WABA_NEW, WABA_OLD_TEMPLATE], expiresInDays: 0 })).json().token as string;
  await setFault(t.mock, "meta.review", "manual");
  assert.equal((await subscribeApp(WABA_NEW, token)).subscribed, true);
  await ensureTemplates(WABA_NEW, token, "en");
  receiver.received.length = 0;
  return token;
}
const templateId = (wabaId: string, name: string) => Object.values(t.mock.state().meta.wabas[wabaId].templates).find((x) => x.name === name)!.id;
const act = (wabaId: string, name: string, action: string, reason?: string) => control(t.mock, "/__mock/meta/template", { wabaId, templateId: templateId(wabaId, name), action, reason });
const attemptsOf = (kind: string) => t.mock.state().webhooks.log.filter((x) => x.kind === kind);
const signatureOf = (r: { headers: Record<string, string | string[] | undefined> }) => String(r.headers["x-hub-signature-256"]);
const body = (r: { raw: string }) => JSON.parse(r.raw);

test("approving a template delivers a signed POST that the app's own verifier accepts and its parser reads", async () => {
  await setup();
  await act(WABA_NEW, "sa_booking_confirmation", "approve");
  await waitFor(() => received().length === 1, "the template webhook");
  const r = received()[0];
  assert.equal(r.method, "POST");
  assert.equal(r.url, "/api/webhooks/whatsapp");
  assert.equal(r.headers["content-type"], "application/json");
  assert.match(signatureOf(r), /^sha256=[0-9a-f]{64}$/);
  assert.match(String(r.headers["x-hub-signature"]), /^sha1=[0-9a-f]{40}$/);
  assert.equal(verifyMetaSignature(r.raw, signatureOf(r), META_APP_SECRET), true, "the mock's HMAC and the app's verifier agree");
  assert.equal(verifyMetaSignature(r.raw + " ", signatureOf(r), META_APP_SECRET), false, "the signature covers the exact bytes");
  assert.deepEqual(parseTemplateStatusUpdates(JSON.parse(r.raw)), [{ wabaId: WABA_NEW, name: "sa_booking_confirmation", language: "en", status: "APPROVED", reason: null }]);
  assert.equal(body(r).object, "whatsapp_business_account");
  // The log entry is written when the mock has read the app's answer, a moment after the receiver counted the request.
  await waitFor(() => attemptsOf("template APPROVED").length === 1, "the delivery to be logged");
  assert.deepEqual(attemptsOf("template APPROVED").map((x) => [x.attempt, x.status, x.error]), [[1, 200, null]]);
});

test("a rejection carries its reason; pause, disable, flag and reinstate are events the app understands", async () => {
  await setup();
  await act(WABA_NEW, "sa_reschedule", "reject", "invalid_format");
  await act(WABA_NEW, "sa_cancellation", "pause");
  await act(WABA_NEW, "sa_reminder_24h", "flag");
  await act(WABA_NEW, "sa_reminder_24h", "reinstate");
  await act(WABA_NEW, "sa_reminder_15m", "disable");
  await waitFor(() => received().length === 5, "five template webhooks");
  const updates = received().flatMap((r) => parseTemplateStatusUpdates(JSON.parse(r.raw)));
  assert.deepEqual(
    updates.map((u) => [u.name, u.status, u.reason]),
    [
      ["sa_reschedule", "REJECTED", "INVALID_FORMAT"],
      ["sa_cancellation", "PAUSED", null],
      ["sa_reminder_24h", "FLAGGED", null],
      ["sa_reminder_24h", "APPROVED", null], // REINSTATED is read as approved again
      ["sa_reminder_15m", "DISABLED", null],
    ],
  );
  assert.equal(JSON.parse(received()[3].raw).entry[0].changes[0].value.event, "REINSTATED");
});

/** Registers the number, approves all five templates and returns a function that sends a booking confirmation. */
async function readyToSend(token: string) {
  await registerNumber(PHONE_FRESH, token, "111111");
  for (const name of ["sa_booking_confirmation", "sa_reschedule", "sa_cancellation", "sa_reminder_24h", "sa_reminder_15m"]) await act(WABA_NEW, name, "approve");
  await waitFor(() => received().length === 5, "the five approvals");
  receiver.received.length = 0;
  const context = { link: "http://127.0.0.1:4010/meet/mock-abcd-efgh", serviceTitle: "1:1 Career Call", influencerName: "Demo Creator", when: "Mon, 12 Oct 2026, 11:00 am IST" };
  return () =>
    sendWhatsApp({ to: "+919876543210", template: "booking-confirmation", languageCode: "en", components: whatsappComponents("booking-confirmation", context), credentials: { token, phoneNumberId: PHONE_FRESH } });
}

test("a sent message gets sent, delivered and read, in order, one status per POST", async () => {
  const token = await setup();
  const send = await readyToSend(token);
  await setFault(t.mock, "meta.status", "delivered_read:20");
  const { providerMessageId } = await send();
  await waitFor(() => received().length === 3, "three status webhooks");
  const updates = received().flatMap((r) => parseWhatsAppStatuses(JSON.parse(r.raw)));
  assert.deepEqual(updates, [
    { providerMessageId, status: "SENT" },
    { providerMessageId, status: "DELIVERED" },
    { providerMessageId, status: "READ" },
  ]);
  for (const r of received()) assert.equal(verifyMetaSignature(r.raw, signatureOf(r), META_APP_SECRET), true);
  const value = body(received()[0]).entry[0].changes[0].value;
  assert.equal(value.metadata.phone_number_id, PHONE_FRESH);
  assert.equal(value.statuses[0].recipient_id, "919876543210");
  const message = t.mock.state().meta.messages[providerMessageId];
  await waitFor(() => message.statuses.length === 3 && message.statuses.every((s) => s.webhook === "200"), "the timeline to record the deliveries");
  assert.deepEqual(message.statuses.map((s) => s.status), ["sent", "delivered", "read"]);
});

test("meta.status variants: failed carries an error, sent_only stops, out_of_order regresses, instant sends all at once", async () => {
  const token = await setup();
  const send = await readyToSend(token);

  await setFault(t.mock, "meta.status", "failed_131026:20");
  const failed = await send();
  await waitFor(() => received().length === 1, "the failed webhook");
  assert.deepEqual(parseWhatsAppStatuses(JSON.parse(received()[0].raw)), [{ providerMessageId: failed.providerMessageId, status: "FAILED", error: "Message undeliverable" }]);

  receiver.received.length = 0;
  await setFault(t.mock, "meta.status", "sent_only:20");
  await send();
  await waitFor(() => received().length === 1, "sent");
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(received().length, 1, "nothing after sent");

  receiver.received.length = 0;
  await setFault(t.mock, "meta.status", "out_of_order:20");
  await send();
  await waitFor(() => received().length === 3, "three statuses");
  assert.deepEqual(received().flatMap((r) => parseWhatsAppStatuses(JSON.parse(r.raw)).map((u) => u.status)), ["SENT", "READ", "DELIVERED"], "delivered arrives after read");

  receiver.received.length = 0;
  await setFault(t.mock, "meta.status", "instant");
  await send();
  await waitFor(() => received().length === 3, "three statuses at once");
});

test("failures: a bad signature is rejected by the app's verifier, 'off' sends nothing, app_500_once delivers twice", async () => {
  await setup();
  await setFault(t.mock, "meta.webhooks", "bad_signature");
  await act(WABA_NEW, "sa_booking_confirmation", "approve");
  await waitFor(() => received().length === 1, "the bad-signature webhook");
  assert.equal(verifyMetaSignature(received()[0].raw, signatureOf(received()[0]), META_APP_SECRET), false);
  assert.equal(verifyMetaSignature(received()[0].raw, signatureOf(received()[0]), `${META_APP_SECRET}-wrong`), true, "it was signed with another secret");

  receiver.received.length = 0;
  await setFault(t.mock, "meta.webhooks", "off");
  await act(WABA_NEW, "sa_reschedule", "approve");
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(received().length, 0, "webhooks are switched off");
  assert.ok(t.mock.state().webhooks.log.some((x) => x.attempt === 0 && /switched off/.test(x.error ?? "")), "and the log says why nothing was sent");

  await control(t.mock, "/__mock/faults/clear");
  await setFault(t.mock, "meta.webhooks", "app_500_once");
  assert.equal(t.mock.state().faults["meta.webhooks"].once, true, "app_500_once applies once by itself");
  await act(WABA_NEW, "sa_cancellation", "approve");
  await waitFor(() => received().length === 2, "the delivery and its retry");
  assert.equal(received()[0].raw, received()[1].raw, "the same body twice");
  await waitFor(() => attemptsOf("template APPROVED").some((x) => x.attempt === 2 && x.status === 200), "the retry to be logged");
  const attempts = attemptsOf("template APPROVED").slice(-2);
  assert.deepEqual(attempts.map((x) => [x.attempt, x.status]), [[1, 500], [2, 200]]);
  assert.match(attempts[0].error ?? "", /app_500_once/);
});

test("retries: a failing app is retried, then the delivery is dropped; later deliveries to the same target still go on", async () => {
  await setup();
  respond = (n) => (n <= 2 ? { status: 500, body: "boom" } : { status: 200, body: "ok" });
  await act(WABA_NEW, "sa_booking_confirmation", "approve");
  await waitFor(() => received().length === 3, "two failures and a success");
  await waitFor(() => attemptsOf("template APPROVED").length === 3, "the three attempts to be logged");
  assert.deepEqual(attemptsOf("template APPROVED").map((x) => [x.attempt, x.status]), [[1, 500], [2, 500], [3, 200]]);
  assert.equal(t.mock.state().webhooks.log.find((x) => x.status === 500)?.bodyPreview, "boom", "the start of the app's answer is logged");

  receiver.received.length = 0;
  respond = () => ({ status: 503, body: "down" });
  await act(WABA_NEW, "sa_reschedule", "approve");
  await waitFor(() => received().length === 4, "four attempts (one try, three retries)");
  await waitFor(() => t.mock.state().webhooks.log.some((x) => /dropped/.test(x.error ?? "")), "the drop to be logged");

  receiver.received.length = 0;
  respond = () => ({ status: 200 });
  await act(WABA_NEW, "sa_cancellation", "approve");
  await waitFor(() => received().length === 1, "the next delivery");
});

test("only accounts our Meta app is subscribed to get webhooks", async () => {
  await setup();
  const token = (await control(t.mock, "/__mock/meta/mint-token", { app: "own", scopes: [MGMT, MSG], wabaIds: [WABA_OLD_TEMPLATE], expiresInDays: 0 })).json().token as string;
  assert.equal((await subscribeApp(WABA_OLD_TEMPLATE, token)).subscribed, false, "only the influencer's own app is subscribed there");
  await act(WABA_OLD_TEMPLATE, "sa_reschedule", "pause");
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(received().length, 0);
  assert.ok(t.mock.state().webhooks.log.some((x) => x.attempt === 0 && /not subscribed/.test(x.error ?? "")));
});

test("the verify handshake passes against an app that echoes hub.challenge for the right token, and fails otherwise", async () => {
  await setup();
  // A receiver that behaves like app/api/webhooks/whatsapp: the app's own isVerifyRequestValid decides.
  const seen: string[] = [];
  const echo = await startReceiver((_n, req) => {
    const u = new URL(req.url, "http://x");
    seen.push(u.search);
    return isVerifyRequestValid(u.searchParams.get("hub.mode"), u.searchParams.get("hub.verify_token"), process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN)
      ? { status: 200, body: u.searchParams.get("hub.challenge") ?? "" }
      : { status: 403, body: "Forbidden" };
  });
  try {
    await control(t.mock, "/__mock/webhooks/target", { url: `${echo.url}/api/webhooks/whatsapp` });
    const ok = (await control(t.mock, "/__mock/webhooks/verify")).json();
    assert.equal(ok.ok, true, JSON.stringify(ok));
    assert.equal(echo.received[0].method, "GET");
    const params = new URL(echo.received[0].url, "http://x").searchParams;
    assert.equal(params.get("hub.mode"), "subscribe");
    assert.equal(params.get("hub.verify_token"), WEBHOOK_VERIFY_TOKEN);
    assert.match(params.get("hub.challenge") ?? "", /^mock-challenge-/);

    const saved = process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN;
    process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN = "some-other-token";
    try {
      const bad = (await control(t.mock, "/__mock/webhooks/verify")).json();
      assert.equal(bad.ok, false);
      assert.equal(bad.status, 403);
      assert.match(bad.detail, /WHATSAPP_WEBHOOK_VERIFY_TOKEN/);
    } finally {
      process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN = saved;
    }
    const wrongBody = await startReceiver(() => ({ status: 200, body: "not the challenge" }));
    try {
      await control(t.mock, "/__mock/webhooks/target", { url: wrongBody.url });
      assert.equal((await control(t.mock, "/__mock/webhooks/verify")).json().ok, false);
    } finally {
      await wrongBody.stop();
    }
  } finally {
    await control(t.mock, "/__mock/webhooks/target", { url: `${receiver.url}/api/webhooks/whatsapp` });
    await echo.stop();
  }
});

test("the webhook target must be local: https://example.com/hook is refused, and nothing is ever sent there", async () => {
  for (const url of ["https://example.com/hook", "http://192.168.1.5:3000/x", "http://localhost@evil.com/x", "ftp://localhost/x", ""]) {
    const res = await raw(t.mock, "POST", "/__mock/webhooks/target", { "content-type": "application/json", "x-mock-control": t.mock.controlToken }, JSON.stringify({ url }));
    assert.equal(res.status, 400, url);
  }
  assert.equal(t.mock.state().webhooks.target, `${receiver.url}/api/webhooks/whatsapp`, "unchanged");
  const ok = await control(t.mock, "/__mock/webhooks/target", { url: "http://app.localhost:3000/api/webhooks/whatsapp" });
  assert.equal(ok.json().ok, true);
  await control(t.mock, "/__mock/webhooks/target", { url: `${receiver.url}/api/webhooks/whatsapp` });
});
