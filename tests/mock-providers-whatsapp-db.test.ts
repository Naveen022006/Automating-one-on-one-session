// Connecting a WhatsApp number through Embedded Signup against the mock server and a migrated Postgres (skipped without DATABASE_URL /
// TOKEN_ENCRYPTION_KEY; no Redis needed). The REAL connect path (code exchange, token check, webhook subscription, PIN registration with
// the PIN table, template submission) and the REAL database run; only Meta is the mock (doc/11-provider-simulator.md, 6.4). A local
// receiver plays the app's webhook route, and what it receives is fed through the app's own parser and updater.
import "dotenv/config";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { decryptSecret } from "../lib/crypto";
import { prisma } from "../lib/db";
import { WhatsAppConnectError, applyTemplateStatusUpdate, connectEmbedded, disconnect, getConnectionView, getRegistrationPin, whatsappPinAad } from "../lib/whatsapp-connection";
import { parseTemplateStatusUpdates, verifyMetaSignature } from "../lib/whatsapp-webhook";
import { META_APP_SECRET, PHONE_FRESH, PHONE_UNKNOWN_PIN, WABA_NEW } from "../scripts/mock-providers/fixtures";
import { control, setFault, startMock, startReceiver, useMockEnv, waitFor, type TestMock } from "./helpers/mock-server";

const skip = process.env.DATABASE_URL && process.env.TOKEN_ENCRYPTION_KEY ? false : "DATABASE_URL / TOKEN_ENCRYPTION_KEY not set";
const run = Date.now();
let t: TestMock;
let receiver: Awaited<ReturnType<typeof startReceiver>>;
let restoreEnv = () => {};
let influencerId = "";
/** No development default PIN from the owner's .env: the generated PIN is what is under test. */
const env = () => ({ ...process.env, WHATSAPP_REGISTRATION_PIN: "" });

before(async () => {
  if (skip) return;
  receiver = await startReceiver();
  t = await startMock(receiver.url);
  restoreEnv = useMockEnv(t.mock, receiver.url);
  influencerId = (await prisma.influencer.create({ data: { slug: `mp-wa-${run}`, name: "Mock WhatsApp", email: `mp-wa-${run}@example.com` } })).id;
  await setFault(t.mock, "meta.review", "manual");
});

after(async () => {
  if (!skip) {
    restoreEnv();
    await t.stop();
    await receiver.stop();
    await prisma.whatsAppConnection.deleteMany({ where: { influencerId } });
    await prisma.whatsAppRegistrationPin.deleteMany({ where: { phoneNumberId: { in: [PHONE_FRESH, PHONE_UNKNOWN_PIN] } } });
    await prisma.influencer.delete({ where: { id: influencerId } });
  }
  await prisma.$disconnect();
});

const esCode = async (wabaId: string, phoneId: string) => (await control(t.mock, "/__mock/meta/es-code", { wabaId, phoneId })).json().code as string;

test("Embedded Signup for a fresh number: ACTIVE, subscribed, a PIN saved and registered, five templates in review; approvals arrive by webhook", { skip }, async () => {
  const view = await connectEmbedded(influencerId, { code: await esCode(WABA_NEW, PHONE_FRESH), wabaId: WABA_NEW, phoneNumberId: PHONE_FRESH }, undefined, env());
  assert.equal(view.status, "ACTIVE");
  assert.equal(view.source, "embedded");
  assert.equal(view.displayPhone, "+91 00000 02001");
  assert.equal(view.verifiedName, "Mock Coaching");
  assert.deepEqual(view.webhook, { subscribed: true, error: null });
  assert.equal(view.ready, false);
  assert.deepEqual(view.templates.map((x) => x.status), ["PENDING", "PENDING", "PENDING", "PENDING", "PENDING"]);
  assert.deepEqual(view.notes, [], "the token passed Meta's check without remarks");

  // The PIN: generated, saved BEFORE the number was registered, and the mock's number holds exactly that.
  const row = await prisma.whatsAppRegistrationPin.findUniqueOrThrow({ where: { phoneNumberId: PHONE_FRESH } });
  assert.equal(row.generated, true);
  const pin = decryptSecret(row.pinEnc, whatsappPinAad(PHONE_FRESH));
  assert.match(pin, /^\d{6}$/);
  assert.equal(t.mock.state().meta.phones[PHONE_FRESH].pin, pin);
  assert.equal(t.mock.state().meta.phones[PHONE_FRESH].registered, true);
  assert.deepEqual(t.mock.state().meta.wabas[WABA_NEW].subscribedApps, [process.env.META_APP_ID]);

  // Approve all five at the mock; the signed webhooks go to the "app", which parses and applies them.
  receiver.received.length = 0;
  for (const tpl of Object.values(t.mock.state().meta.wabas[WABA_NEW].templates)) await control(t.mock, "/__mock/meta/template", { wabaId: WABA_NEW, templateId: tpl.id, action: "approve" });
  await waitFor(() => receiver.received.length === 5, "five template webhooks");
  for (const r of receiver.received) {
    assert.equal(verifyMetaSignature(r.raw, String(r.headers["x-hub-signature-256"]), META_APP_SECRET), true);
    for (const update of parseTemplateStatusUpdates(JSON.parse(r.raw))) assert.equal(await applyTemplateStatusUpdate(update), true);
  }
  const after = (await getConnectionView(influencerId))!;
  assert.equal(after.ready, true, "every template approved: WhatsApp messages will go out");
  assert.deepEqual(after.templates.map((x) => x.status), ["APPROVED", "APPROVED", "APPROVED", "APPROVED", "APPROVED"]);
  assert.equal(await disconnect(influencerId), true);
});

test("a number with a PIN the app does not know: the connect is refused with the reset option, and resetting works", { skip }, async () => {
  const connect = (resetPin?: boolean) => esCode(WABA_NEW, PHONE_UNKNOWN_PIN).then((code) => connectEmbedded(influencerId, { code, wabaId: WABA_NEW, phoneNumberId: PHONE_UNKNOWN_PIN, resetPin }, undefined, env()));
  await assert.rejects(connect(), (e: unknown) => e instanceof WhatsAppConnectError && e.field === "pin" && e.canReset === true && /do not know/.test(e.message));
  assert.equal(t.mock.state().meta.phones[PHONE_UNKNOWN_PIN].pin, "123456", "nothing was changed behind the owner's back");
  const generated = await getRegistrationPin(influencerId, PHONE_UNKNOWN_PIN);
  assert.equal(generated?.generated, true, "a PIN we generated is on record, so the reset is ours to offer");

  const view = await connect(true);
  assert.equal(view.status, "ACTIVE");
  const pin = await getRegistrationPin(influencerId, PHONE_UNKNOWN_PIN);
  assert.ok(pin);
  assert.equal(t.mock.state().meta.phones[PHONE_UNKNOWN_PIN].pin, pin.pin, "the number now holds the PIN we saved");
  assert.notEqual(pin.pin, "123456");
  assert.equal(t.mock.state().meta.phones[PHONE_UNKNOWN_PIN].registered, true);
});

test("a typed PIN is used as given and never replaced, and a wrong typed PIN is the owner's to fix", { skip }, async () => {
  await disconnect(influencerId);
  await prisma.whatsAppRegistrationPin.deleteMany({ where: { phoneNumberId: PHONE_UNKNOWN_PIN } });
  await control(t.mock, "/__mock/meta/phone", { phoneId: PHONE_UNKNOWN_PIN, action: "set-pin", pin: "123456" });
  const code = () => esCode(WABA_NEW, PHONE_UNKNOWN_PIN);
  await assert.rejects(
    code().then((c) => connectEmbedded(influencerId, { code: c, wabaId: WABA_NEW, phoneNumberId: PHONE_UNKNOWN_PIN, pin: "000000", resetPin: true }, undefined, env())),
    (e: unknown) => e instanceof WhatsAppConnectError && e.field === "pin" && e.canReset === false && /does not match/.test(e.message),
  );
  assert.equal(t.mock.state().meta.phones[PHONE_UNKNOWN_PIN].pin, "123456", "a typed PIN is never overwritten, reset ticked or not");
  const view = await code().then((c) => connectEmbedded(influencerId, { code: c, wabaId: WABA_NEW, phoneNumberId: PHONE_UNKNOWN_PIN, pin: "123456" }, undefined, env()));
  assert.equal(view.status, "ACTIVE");
  assert.deepEqual(await getRegistrationPin(influencerId, PHONE_UNKNOWN_PIN), { pin: "123456", generated: false });
});
