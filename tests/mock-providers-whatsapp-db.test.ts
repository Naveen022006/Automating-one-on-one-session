// Connecting a WhatsApp number through Embedded Signup against the mock server and a migrated Postgres (skipped without DATABASE_URL /
// TOKEN_ENCRYPTION_KEY; no Redis needed). The REAL connect path (code exchange, token check, webhook subscription, PIN registration with
// the PIN table, template submission) and the REAL database run; only Meta is the mock (doc/11-provider-simulator.md, 6.4). A local
// receiver plays the app's webhook route, and what it receives is fed through the app's own parser and updater.
//
// The database may be shared with real data, so this file never uses the mock's fixed demo ids (the owner's demo may have connected
// those). Each run asks the mock for NEW accounts and numbers with random ids (POST /__mock/meta/waba), makes its own influencer
// with a unique slug, and deletes only the rows it created: its influencer's connection, the PIN rows of ITS numbers, its influencer.
import "dotenv/config";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, test } from "node:test";
import { decryptSecret } from "../lib/crypto";
import { prisma } from "../lib/db";
import { KNOWN_TEMPLATES } from "../lib/message-templates";
import { WhatsAppConnectError, applyTemplateStatusUpdate, connectEmbedded, disconnect, getConnectionView, getRegistrationPin, whatsappPinAad } from "../lib/whatsapp-connection";
import { parseTemplateStatusUpdates, verifyMetaSignature } from "../lib/whatsapp-webhook";
import { META_APP_SECRET } from "../scripts/mock-providers/fixtures";
import { cleanup, control, setFault, startMock, startReceiver, useMockEnv, waitFor, type TestMock } from "./helpers/mock-server";

const skip = process.env.DATABASE_URL && process.env.TOKEN_ENCRYPTION_KEY ? false : "DATABASE_URL / TOKEN_ENCRYPTION_KEY not set";
const run = `${Date.now()}-${randomBytes(3).toString("hex")}`;
let t: TestMock;
let receiver: Awaited<ReturnType<typeof startReceiver>>;
let restoreEnv = () => {};
let influencerId = "";
/** The ids this run made (and so the only ones it may delete): a fresh account and number, and one whose number has a PIN the app does not know. */
let WABA_NEW = "";
let PHONE_FRESH = "";
let WABA_PIN = "";
let PHONE_UNKNOWN_PIN = "";
/** No development default PIN from the owner's .env: the generated PIN is what is under test. */
const env = () => ({ ...process.env, WHATSAPP_REGISTRATION_PIN: "" });

const newWaba = async () => (await control(t.mock, "/__mock/meta/waba")).json() as { wabaId: string; phoneId: string };

before(async () => {
  if (skip) return;
  receiver = await startReceiver();
  t = await startMock(receiver.url);
  restoreEnv = useMockEnv(t.mock, receiver.url);
  ({ wabaId: WABA_NEW, phoneId: PHONE_FRESH } = await newWaba());
  ({ wabaId: WABA_PIN, phoneId: PHONE_UNKNOWN_PIN } = await newWaba());
  // This number is already registered, with a PIN nobody gave the app (a number used before).
  await control(t.mock, "/__mock/meta/phone", { phoneId: PHONE_UNKNOWN_PIN, action: "set-pin", pin: "123456" });
  influencerId = (await prisma.influencer.create({ data: { slug: `mp-wa-${run}`, name: "Mock WhatsApp", email: `mp-wa-${run}@example.com` } })).id;
  await setFault(t.mock, "meta.review", "manual");
});

after(async () => {
  if (skip) {
    await prisma.$disconnect();
    return;
  }
  await cleanup(
    [
      ["restore the environment", () => restoreEnv()],
      ["stop the mock", () => t.stop()],
      ["stop the receiver", () => receiver.stop()],
      ["delete this run's WhatsApp connection", () => influencerId && prisma.whatsAppConnection.deleteMany({ where: { influencerId } })],
      ["delete the PIN rows of this run's numbers", () => PHONE_FRESH && prisma.whatsAppRegistrationPin.deleteMany({ where: { phoneNumberId: { in: [PHONE_FRESH, PHONE_UNKNOWN_PIN].filter(Boolean) } } })],
      ["delete this run's influencer", () => influencerId && prisma.influencer.delete({ where: { id: influencerId } })],
    ],
    () => prisma.$disconnect(),
  );
});

const esCode = async (wabaId: string, phoneId: string) => (await control(t.mock, "/__mock/meta/es-code", { wabaId, phoneId })).json().code as string;

test("Embedded Signup for a fresh number: ACTIVE, subscribed, a PIN saved and registered, every template in review; approvals arrive by webhook", { skip }, async () => {
  const view = await connectEmbedded(influencerId, { code: await esCode(WABA_NEW, PHONE_FRESH), wabaId: WABA_NEW, phoneNumberId: PHONE_FRESH }, undefined, env());
  assert.equal(view.status, "ACTIVE");
  assert.equal(view.source, "embedded");
  assert.equal(view.displayPhone, t.mock.state().meta.phones[PHONE_FRESH].display);
  assert.equal(view.verifiedName, t.mock.state().meta.phones[PHONE_FRESH].verifiedName);
  assert.deepEqual(view.webhook, { subscribed: true, error: null });
  assert.equal(view.ready, false);
  assert.deepEqual(view.templates.map((x) => x.status), Array(KNOWN_TEMPLATES.length).fill("PENDING"));
  assert.deepEqual(view.notes, [], "the token passed Meta's check without remarks");

  // The PIN: generated, saved BEFORE the number was registered, and the mock's number holds exactly that.
  const row = await prisma.whatsAppRegistrationPin.findUniqueOrThrow({ where: { phoneNumberId: PHONE_FRESH } });
  assert.equal(row.generated, true);
  const pin = decryptSecret(row.pinEnc, whatsappPinAad(PHONE_FRESH));
  assert.match(pin, /^\d{6}$/);
  assert.equal(t.mock.state().meta.phones[PHONE_FRESH].pin, pin);
  assert.equal(t.mock.state().meta.phones[PHONE_FRESH].registered, true);
  assert.deepEqual(t.mock.state().meta.wabas[WABA_NEW].subscribedApps, [process.env.META_APP_ID]);

  // Approve every template at the mock (nine: the five booking events and the four booking-request messages); the signed webhooks go to the "app", which parses and applies them.
  receiver.received.length = 0;
  for (const tpl of Object.values(t.mock.state().meta.wabas[WABA_NEW].templates)) await control(t.mock, "/__mock/meta/template", { wabaId: WABA_NEW, templateId: tpl.id, action: "approve" });
  await waitFor(() => receiver.received.length === KNOWN_TEMPLATES.length, "one webhook per template");
  for (const r of receiver.received) {
    assert.equal(verifyMetaSignature(r.raw, String(r.headers["x-hub-signature-256"]), META_APP_SECRET), true);
    for (const update of parseTemplateStatusUpdates(JSON.parse(r.raw))) assert.equal(await applyTemplateStatusUpdate(update), true);
  }
  const after = (await getConnectionView(influencerId))!;
  assert.equal(after.ready, true, "every template approved: WhatsApp messages will go out");
  assert.deepEqual(after.templates.map((x) => x.status), Array(KNOWN_TEMPLATES.length).fill("APPROVED"));
  assert.equal(await disconnect(influencerId), true);
});

test("a number with a PIN the app does not know: the connect is refused with the reset option, and resetting works", { skip }, async () => {
  const connect = (resetPin?: boolean) => esCode(WABA_PIN, PHONE_UNKNOWN_PIN).then((code) => connectEmbedded(influencerId, { code, wabaId: WABA_PIN, phoneNumberId: PHONE_UNKNOWN_PIN, resetPin }, undefined, env()));
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
  const code = () => esCode(WABA_PIN, PHONE_UNKNOWN_PIN);
  await assert.rejects(
    code().then((c) => connectEmbedded(influencerId, { code: c, wabaId: WABA_PIN, phoneNumberId: PHONE_UNKNOWN_PIN, pin: "000000", resetPin: true }, undefined, env())),
    (e: unknown) => e instanceof WhatsAppConnectError && e.field === "pin" && e.canReset === false && /does not match/.test(e.message),
  );
  assert.equal(t.mock.state().meta.phones[PHONE_UNKNOWN_PIN].pin, "123456", "a typed PIN is never overwritten, reset ticked or not");
  const view = await code().then((c) => connectEmbedded(influencerId, { code: c, wabaId: WABA_PIN, phoneNumberId: PHONE_UNKNOWN_PIN, pin: "123456" }, undefined, env()));
  assert.equal(view.status, "ACTIVE");
  assert.deepEqual(await getRegistrationPin(influencerId, PHONE_UNKNOWN_PIN), { pin: "123456", generated: false });
});
