import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import vm from "node:vm";
import { after, afterEach, before, test } from "node:test";
import { TEMPLATE_SPECS, whatsappComponents } from "../lib/message-templates";
import { sendSMS } from "../lib/sms";
import { sendWhatsApp } from "../lib/whatsapp";
import {
  WhatsAppGraphError,
  checkTokenInfo,
  ensureTemplates,
  exchangeEmbeddedCode,
  getPhoneNumber,
  inspectToken,
  isAlreadyExists,
  listTemplates,
  registerNumber,
  setTwoStepPin,
  subscribeApp,
  wabaOwnsNumber,
} from "../lib/whatsapp-connect";
import { control, raw, setFault, startMock, useMockEnv, type TestMock } from "./helpers/mock-server";
import {
  META_APP_ID,
  META_ES_CONFIG_ID,
  OWN_APP_ID,
  PHONE_FRESH,
  PHONE_MANUAL,
  PHONE_UNKNOWN_PIN,
  SMS_API_KEY,
  WABA_BIG,
  WABA_NEW,
  WABA_OLD_TEMPLATE,
} from "../scripts/mock-providers/fixtures";

// The REAL Meta clients of the app (lib/whatsapp-connect.ts, lib/whatsapp.ts, lib/sms.ts) driven against the mock over HTTP
// (doc/11-provider-simulator.md, 6.4). The mock's side of the Embedded Signup popup and SDK is exercised at the end.

const MGMT = "whatsapp_business_management";
const MSG = "whatsapp_business_messaging";
let t: TestMock;
let restoreEnv: () => void;
let marker = 0;

before(async () => {
  t = await startMock();
  restoreEnv = useMockEnv(t.mock);
});
after(async () => {
  restoreEnv();
  await t.stop();
});
afterEach(async () => {
  await control(t.mock, "/__mock/faults/clear");
});

async function mint(o: { app?: "platform" | "own"; scopes?: string[]; wabaIds?: string[]; expiresInDays?: number } = {}): Promise<string> {
  const res = await control(t.mock, "/__mock/meta/mint-token", { app: o.app ?? "platform", scopes: o.scopes ?? [MGMT, MSG], wabaIds: o.wabaIds ?? [WABA_NEW, WABA_OLD_TEMPLATE, WABA_BIG], expiresInDays: o.expiresInDays ?? 0 });
  return res.json().token as string;
}

/** A pristine world (accounts, numbers, templates) and a fresh platform token for all three accounts. */
async function fresh(): Promise<string> {
  await control(t.mock, "/__mock/reset", { confirm: "reset" });
  return mint();
}

/** The requests the mock answered while `action` ran (immune to the request log's size cap). */
async function logDuring(action: () => Promise<unknown>) {
  const path = `/__mock/marker-${++marker}`;
  await raw(t.mock, "GET", path);
  await action();
  const log = t.mock.state().requests;
  return log.slice(log.findLastIndex((r) => r.path === path) + 1);
}

const wabaOf = (id: string) => t.mock.state().meta.wabas[id];
const approveAll = async (wabaId: string) => {
  for (const tpl of Object.values(wabaOf(wabaId).templates)) if (tpl.name.startsWith("sa_")) await control(t.mock, "/__mock/meta/template", { wabaId, templateId: tpl.id, action: "approve" });
};

test("phone and account reads: the app's own calls return the display number and name, and ownership", async () => {
  const token = await fresh();
  const phone = await getPhoneNumber(PHONE_FRESH, token);
  assert.deepEqual(phone, { id: PHONE_FRESH, displayPhone: "+91 00000 02001", verifiedName: "Mock Coaching", qualityRating: "GREEN" });
  assert.equal(await wabaOwnsNumber(WABA_NEW, PHONE_FRESH, token), true);
  assert.equal(await wabaOwnsNumber(WABA_OLD_TEMPLATE, PHONE_FRESH, token), false);

  const onlyOne = await mint({ wabaIds: [WABA_NEW] });
  await assert.rejects(getPhoneNumber(PHONE_MANUAL, onlyOne), (e: unknown) => e instanceof WhatsAppGraphError && e.code === 100 && e.subcode === 33 && !e.invalidToken, "a token without access to the account's number");
  await assert.rejects(getPhoneNumber(PHONE_FRESH, "MOCK-NOT-REAL-unknown"), (e: unknown) => e instanceof WhatsAppGraphError && e.invalidToken && e.code === 190);
  await assert.rejects(getPhoneNumber("123", token), (e: unknown) => e instanceof WhatsAppGraphError && e.code === 100);
  const revoked = await mint();
  await control(t.mock, "/__mock/meta/revoke-token", { token: revoked });
  await assert.rejects(getPhoneNumber(PHONE_FRESH, revoked), (e: unknown) => e instanceof WhatsAppGraphError && e.invalidToken && e.subcode === 460);
  const expired = await mint();
  await control(t.mock, "/__mock/meta/expire-token", { token: expired });
  await assert.rejects(getPhoneNumber(PHONE_FRESH, expired), (e: unknown) => e instanceof WhatsAppGraphError && e.invalidToken && e.subcode === 463);
  const noScopes = await mint({ scopes: [] });
  await assert.rejects(getPhoneNumber(PHONE_FRESH, noScopes), (e: unknown) => e instanceof WhatsAppGraphError && e.code === 10 && e.invalidToken);
});

test("token inspection: asked as our app, then as the token itself for the influencer's own app", async () => {
  const platform = await mint();
  const log = await logDuring(async () => {
    const info = await inspectToken(platform);
    assert.equal(info.valid, true);
    assert.equal(info.appId, META_APP_ID);
    assert.equal(info.expiresAt, null);
    assert.ok(info.scopes?.includes(MGMT) && info.scopes.includes(MSG));
    assert.deepEqual(checkTokenInfo(info), { ok: true, notes: [] });
  });
  assert.equal(log.filter((r) => r.path.includes("/debug_token")).length, 1);

  const own = await mint({ app: "own" });
  const ownLog = await logDuring(async () => {
    const info = await inspectToken(own);
    assert.equal(info.valid, true);
    assert.equal(info.appId, OWN_APP_ID);
    assert.equal(checkTokenInfo(info).ok, true);
  });
  const debugCalls = ownLog.filter((r) => r.path.includes("/debug_token"));
  assert.deepEqual(debugCalls.map((r) => r.status), [400, 200], "refused for another app's token, then the token inspected itself");

  const day = checkTokenInfo(await inspectToken(await mint({ expiresInDays: 1 })));
  assert.equal(day.ok, false);
  assert.match(!day.ok ? day.message : "", /expires in/);
  const month = checkTokenInfo(await inspectToken(await mint({ expiresInDays: 30 })));
  assert.equal(month.ok, true, "a 30-day token is accepted with a note");
  assert.ok(month.ok && month.notes.some((n) => /expires on/.test(n)));
  const noMessaging = checkTokenInfo(await inspectToken(await mint({ scopes: [MGMT] })));
  assert.equal(noMessaging.ok, false);
  assert.match(!noMessaging.ok ? noMessaging.message : "", /whatsapp_business_messaging/);

  const revoked = await mint();
  await control(t.mock, "/__mock/meta/revoke-token", { token: revoked });
  await assert.rejects(inspectToken(revoked), WhatsAppGraphError);
});

test("webhook subscription: the platform app's token subscribes OUR app; another app's token subscribes the wrong one", async () => {
  const token = await fresh();
  assert.deepEqual(await subscribeApp(WABA_NEW, token), { subscribed: true, reason: null });
  assert.deepEqual(wabaOf(WABA_NEW).subscribedApps, [META_APP_ID]);
  assert.deepEqual(await subscribeApp(WABA_NEW, token), { subscribed: true, reason: null }, "idempotent");
  const own = await mint({ app: "own" });
  const result = await subscribeApp(WABA_OLD_TEMPLATE, own);
  assert.equal(result.subscribed, false);
  assert.match(result.reason ?? "", /different Meta app/);
  assert.deepEqual(wabaOf(WABA_OLD_TEMPLATE).subscribedApps, [OWN_APP_ID]);
  const narrow = await mint({ scopes: [MSG] });
  await assert.rejects(subscribeApp(WABA_NEW, narrow), (e: unknown) => e instanceof WhatsAppGraphError && e.code === 10);
});

test("PIN and registration: a fresh number takes any PIN, a known PIN is idempotent, a wrong one is refused and eventually locks", async () => {
  const token = await fresh();
  await registerNumber(PHONE_FRESH, token, "111111");
  await registerNumber(PHONE_FRESH, token, "111111");
  assert.equal(t.mock.state().meta.phones[PHONE_FRESH].registered, true);
  assert.equal(t.mock.state().meta.phones[PHONE_FRESH].pin, "111111");
  await assert.rejects(registerNumber(PHONE_FRESH, token, "222222"), (e: unknown) => e instanceof WhatsAppGraphError && e.pinMismatch && e.code === 133005 && !e.pinLocked);
  await assert.rejects(registerNumber(PHONE_MANUAL, token, "12"), (e: unknown) => e instanceof WhatsAppGraphError && e.code === 100, "a PIN is 6 digits");

  // 2002 is registered with a PIN the app does not know.
  await assert.rejects(registerNumber(PHONE_UNKNOWN_PIN, token, "000000"), (e: unknown) => e instanceof WhatsAppGraphError && e.pinMismatch);
  for (let i = 0; i < 4; i++) await assert.rejects(registerNumber(PHONE_UNKNOWN_PIN, token, "000000"), (e: unknown) => e instanceof WhatsAppGraphError && e.pinMismatch);
  await assert.rejects(registerNumber(PHONE_UNKNOWN_PIN, token, "000000"), (e: unknown) => e instanceof WhatsAppGraphError && e.pinLocked && e.code === 133008, "locked after five wrong guesses");
  await assert.rejects(registerNumber(PHONE_UNKNOWN_PIN, token, "123456"), (e: unknown) => e instanceof WhatsAppGraphError && e.pinLocked, "even the right PIN while locked");
  await assert.rejects(setTwoStepPin(PHONE_UNKNOWN_PIN, token, "222222"), (e: unknown) => e instanceof WhatsAppGraphError && e.pinLocked, "a locked number refuses the reset as well");

  await control(t.mock, "/__mock/meta/phone", { phoneId: PHONE_UNKNOWN_PIN, action: "unlock" });
  await setTwoStepPin(PHONE_UNKNOWN_PIN, token, "222222");
  await assert.rejects(registerNumber(PHONE_UNKNOWN_PIN, token, "123456"), (e: unknown) => e instanceof WhatsAppGraphError && e.pinMismatch, "the old PIN no longer works");
  await registerNumber(PHONE_UNKNOWN_PIN, token, "222222");
  await control(t.mock, "/__mock/meta/phone", { phoneId: PHONE_UNKNOWN_PIN, action: "lock" });
  await assert.rejects(registerNumber(PHONE_UNKNOWN_PIN, token, "222222"), (e: unknown) => e instanceof WhatsAppGraphError && e.pinLocked, "the lock control");
});

test("templates: five are submitted once as PENDING, a re-run adds nothing, and the review timer decides", async () => {
  const token = await fresh();
  await setFault(t.mock, "meta.review", "manual");
  const first = await ensureTemplates(WABA_NEW, token, "en");
  assert.equal(first.submitted.length, 5);
  assert.deepEqual(first.failed, []);
  assert.deepEqual(Object.values(first.templates).map((x) => x.status), ["PENDING", "PENDING", "PENDING", "PENDING", "PENDING"]);
  for (const spec of Object.values(TEMPLATE_SPECS)) {
    const stored = Object.values(wabaOf(WABA_NEW).templates).find((x) => x.name === spec.name);
    assert.ok(stored, spec.name);
    assert.equal(stored.body, spec.body);
    assert.equal(stored.category, "UTILITY");
  }
  const second = await ensureTemplates(WABA_NEW, token, "en");
  assert.equal(second.submitted.length, 0);
  assert.equal(Object.values(wabaOf(WABA_NEW).templates).length, 5);

  // Created a moment ago but not on the list the app read: Meta says "already exists" and the app looks it up by name.
  const hideUnfiltered = (async (url: string | URL | Request, init?: RequestInit) => {
    const res = await fetch(url, init);
    if (init?.method !== "POST" && String(url).includes("/message_templates") && !String(url).includes("name=")) return new Response(JSON.stringify({ data: [] }), { status: 200 });
    return res;
  }) as typeof fetch;
  const dup = await ensureTemplates(WABA_NEW, token, "en", hideUnfiltered);
  assert.deepEqual(dup.submitted, []);
  assert.deepEqual(dup.failed, []);
  assert.equal(dup.templates["booking-confirmation"].status, "PENDING");
  const direct = await raw(t.mock, "POST", `/meta/v26.0/${WABA_NEW}/message_templates`, { authorization: `Bearer ${token}`, "content-type": "application/json" }, JSON.stringify({ name: "sa_reschedule", language: "en", category: "UTILITY", components: [{ type: "BODY", text: "Your session was rescheduled. Updated link: {{1}} Session: {{2}} with {{3}}, now on {{4}}. See you then.", example: { body_text: [["a", "b", "c", "d"]] } }] }));
  assert.equal(direct.status, 400);
  assert.equal(direct.json().error.error_subcode, 2388024);
  assert.equal(isAlreadyExists(new WhatsAppGraphError(direct.json().error.error_user_msg, 400, direct.json().error.code, direct.json().error.error_subcode)), true);

  // Meta's validation: name, a body that starts with a variable, and the number of examples.
  const post = (body: object) => raw(t.mock, "POST", `/meta/v26.0/${WABA_NEW}/message_templates`, { authorization: `Bearer ${token}`, "content-type": "application/json" }, JSON.stringify(body));
  const component = (text: string, examples: string[]) => [{ type: "BODY", text, example: { body_text: [examples] } }];
  assert.equal((await post({ name: "Bad-Name", language: "en", components: component("Hi", []) })).status, 400);
  assert.match((await post({ name: "bad_name", language: "en", components: component("{{1}} is first", ["a"]) })).json().error.error_user_msg, /starts or ends with a variable/);
  assert.equal((await post({ name: "bad_name2", language: "en", components: component("Ends with {{1}}", ["a"]) })).status, 400);
  assert.equal((await post({ name: "bad_name3", language: "en", components: component("Hi {{1}} there", []) })).status, 400, "examples must match the variables");
  assert.equal((await post({ name: "good_name", language: "en", components: component("Hi {{1}} there", ["a"]) })).status, 200);

  // The review timer: approve after 0 seconds.
  const t2 = await fresh();
  await setFault(t.mock, "meta.review", "auto:0");
  await ensureTemplates(WABA_NEW, t2, "en");
  await new Promise((r) => setTimeout(r, 150));
  const after = await listTemplates(WABA_NEW, t2);
  assert.deepEqual([...new Set(after.map((x) => x.status))], ["APPROVED"]);
  await setFault(t.mock, "meta.review", "reject:INVALID_FORMAT:0");
  await ensureTemplates(WABA_OLD_TEMPLATE, t2, "en");
  await new Promise((r) => setTimeout(r, 150));
  const rejected = (await listTemplates(WABA_OLD_TEMPLATE, t2)).filter((x) => x.name !== "sa_reschedule");
  assert.ok(rejected.length === 4 && rejected.every((x) => x.status === "REJECTED" && x.rejectedReason === "INVALID_FORMAT"));
});

test("templates: a name already used with a different number of variables is a CONFLICT, and a long list needs several pages", async () => {
  const token = await fresh();
  await setFault(t.mock, "meta.review", "manual");
  const r = await ensureTemplates(WABA_OLD_TEMPLATE, token, "en");
  assert.equal(r.templates.reschedule.status, "CONFLICT");
  assert.match(r.templates.reschedule.reason ?? "", /2 variables and our message needs 4/);
  assert.equal(r.submitted.length, 4, "the four others are submitted; the clashing name is left alone");

  const log = await logDuring(async () => {
    const all = await listTemplates(WABA_BIG, token);
    assert.ok(all.length >= 150, `${all.length} templates`);
  });
  const pages = log.filter((x) => x.path.includes(`/${WABA_BIG}/message_templates`));
  assert.equal(pages.length, 2, "100 + 50: the app follows the cursor");
  assert.ok(pages[1].path.includes("after="));
  const big = await ensureTemplates(WABA_BIG, token, "en");
  assert.equal(big.submitted.length, 5, "the five are submitted although 150 other templates exist");
  await setFault(t.mock, "meta.templates", "500");
  const failing = await ensureTemplates(WABA_NEW, token, "en");
  assert.equal(failing.failed.length, 5, "every submit failed");
  assert.deepEqual(failing.submitted, []);
});

test("Embedded Signup code exchange: the code works once and the token is the platform app's, for that account only", async () => {
  await fresh();
  const code = (await control(t.mock, "/__mock/meta/es-code", { wabaId: WABA_NEW, phoneId: PHONE_FRESH })).json().code as string;
  assert.match(code, /^MOCK-NOT-REAL-/);
  const token = await exchangeEmbeddedCode(code);
  assert.match(token, /^MOCK-NOT-REAL-meta-/);
  assert.equal((await getPhoneNumber(PHONE_FRESH, token)).displayPhone, "+91 00000 02001");
  await assert.rejects(getPhoneNumber(PHONE_MANUAL, token), (e: unknown) => e instanceof WhatsAppGraphError && e.code === 100, "only the chosen account");
  const info = await inspectToken(token);
  assert.equal(info.appId, META_APP_ID);
  assert.equal(info.expiresAt, null);
  await assert.rejects(exchangeEmbeddedCode(code), (e: unknown) => e instanceof WhatsAppGraphError && /been used/.test(e.message), "a code works once");
  await assert.rejects(exchangeEmbeddedCode("not-a-code"), (e: unknown) => e instanceof WhatsAppGraphError && e.code === 100);
  const wrongSecret = await raw(t.mock, "GET", `/meta/v26.0/oauth/access_token?client_id=${META_APP_ID}&client_secret=nope&code=${code}`);
  assert.equal(wrongSecret.status, 400);
  assert.ok(!wrongSecret.text.includes(code), "the code is not echoed");
});

test("the waba control route makes new accounts and numbers whose ids are never the fixed demo ids (database tests use them)", async () => {
  const fixed = new Set([WABA_NEW, WABA_OLD_TEMPLATE, WABA_BIG, PHONE_FRESH, PHONE_MANUAL, PHONE_UNKNOWN_PIN]);
  const a = (await control(t.mock, "/__mock/meta/waba")).json() as { wabaId: string; phoneId: string };
  const b = (await control(t.mock, "/__mock/meta/waba")).json() as { wabaId: string; phoneId: string };
  for (const id of [a.wabaId, a.phoneId, b.wabaId, b.phoneId]) assert.ok(!fixed.has(id), `${id} is not a fixture id`);
  assert.notEqual(a.wabaId, b.wabaId);
  assert.notEqual(a.phoneId, b.phoneId);
  const state = t.mock.state().meta;
  assert.deepEqual(state.wabas[a.wabaId].phoneIds, [a.phoneId]);
  assert.equal(state.phones[a.phoneId].registered, false, "fresh: not registered, no PIN");
  assert.equal(state.phones[a.phoneId].pin, null);
  // It works with the rest of the Embedded Signup path like any other account.
  const code = (await control(t.mock, "/__mock/meta/es-code", { wabaId: a.wabaId, phoneId: a.phoneId })).json().code as string;
  const token = await exchangeEmbeddedCode(code);
  assert.equal((await getPhoneNumber(a.phoneId, token)).displayPhone, state.phones[a.phoneId].display);
  // A control route needs the control token like the others.
  const noToken = await raw(t.mock, "POST", "/__mock/meta/waba", { "content-type": "application/json" }, "{}");
  assert.ok(noToken.status === 403 || noToken.status === 400 || noToken.status === 401, `refused without the token (got ${noToken.status})`);
});

const context = { link: "http://127.0.0.1:4010/meet/mock-abcd-efgh", serviceTitle: "1:1 Career Call", influencerName: "Demo Creator", when: "Mon, 12 Oct 2026, 11:00 am IST" };
const send = (token: string, phoneNumberId: string, o: { template?: string; components?: ReturnType<typeof whatsappComponents>; to?: string } = {}) =>
  sendWhatsApp({ to: o.to ?? "+919876543210", template: o.template ?? "booking-confirmation", languageCode: "en", components: o.components ?? whatsappComponents(o.template ?? "booking-confirmation", context), credentials: { token, phoneNumberId } });

test("sending: a template message needs a registered number and an approved template with the right parameters", async () => {
  const token = await fresh();
  await setFault(t.mock, "meta.review", "manual");
  await assert.rejects(send(token, PHONE_FRESH), (e: unknown) => e instanceof WhatsAppGraphError && e.code === 133010, "not registered");
  await registerNumber(PHONE_FRESH, token, "111111");
  await assert.rejects(send(token, PHONE_FRESH), (e: unknown) => e instanceof WhatsAppGraphError && e.code === 132001, "the template does not exist yet");
  await ensureTemplates(WABA_NEW, token, "en");
  await assert.rejects(send(token, PHONE_FRESH), (e: unknown) => e instanceof WhatsAppGraphError && e.code === 132001 && e.status === 404, "in review");

  await approveAll(WABA_NEW);
  const sent = await send(token, PHONE_FRESH);
  assert.match(sent.providerMessageId, /^wamid\.MOCK-NOT-REAL-/);
  const message = t.mock.state().meta.messages[sent.providerMessageId];
  assert.ok(message.rendered.includes(context.link) && message.rendered.includes("1:1 Career Call") && message.rendered.includes("Demo Creator"), message.rendered);
  assert.equal(message.template, "sa_booking_confirmation");
  assert.deepEqual(message.params, [context.link, "1:1 Career Call", "Demo Creator", context.when]);
  assert.equal(message.to, "+919876543210");

  await assert.rejects(send(token, PHONE_FRESH, { components: [{ type: "body", parameters: [{ type: "text", text: context.link }] }] }), (e: unknown) => e instanceof WhatsAppGraphError && e.code === 132000, "one parameter instead of four");
  await assert.rejects(
    send(token, PHONE_FRESH, { components: [{ type: "body", parameters: ["a", "b\nc", "d", "e"].map((text) => ({ type: "text", text })) }] }),
    (e: unknown) => e instanceof WhatsAppGraphError && e.code === 132018,
    "a newline in a parameter",
  );
  await assert.rejects(send(token, PHONE_FRESH, { to: "12" }), (e: unknown) => e instanceof WhatsAppGraphError && e.code === 100);

  for (const status of ["pause", "disable"]) {
    const tpl = Object.values(wabaOf(WABA_NEW).templates).find((x) => x.name === "sa_reminder_24h")!;
    await control(t.mock, "/__mock/meta/template", { wabaId: WABA_NEW, templateId: tpl.id, action: status });
    await assert.rejects(send(token, PHONE_FRESH, { template: "reminder-24h" }), (e: unknown) => e instanceof WhatsAppGraphError && e.code === (status === "pause" ? 132015 : 132016));
  }
  const flagged = Object.values(wabaOf(WABA_NEW).templates).find((x) => x.name === "sa_reminder_15m")!;
  await control(t.mock, "/__mock/meta/template", { wabaId: WABA_NEW, templateId: flagged.id, action: "flag" });
  assert.match((await send(token, PHONE_FRESH, { template: "reminder-15m" })).providerMessageId, /^wamid\./, "a flagged template is still sent, like the app does");
  await control(t.mock, "/__mock/meta/template", { wabaId: WABA_NEW, templateId: flagged.id, action: "reinstate" });
  assert.equal(flagged.status, "APPROVED");
});

test("sending: a revoked or permission-less token and the injected faults are what the app treats as a dead connection", async () => {
  const token = await fresh();
  await setFault(t.mock, "meta.review", "auto:0");
  await registerNumber(PHONE_FRESH, token, "111111");
  await ensureTemplates(WABA_NEW, token, "en");
  await new Promise((r) => setTimeout(r, 150));
  assert.ok((await send(token, PHONE_FRESH)).providerMessageId);

  const revoked = await mint();
  await control(t.mock, "/__mock/meta/revoke-token", { token: revoked });
  await assert.rejects(send(revoked, PHONE_FRESH), (e: unknown) => e instanceof WhatsAppGraphError && e.invalidToken && e.code === 190);
  await assert.rejects(send(await mint({ scopes: [MGMT] }), PHONE_FRESH), (e: unknown) => e instanceof WhatsAppGraphError && e.invalidToken && e.code === 10, "no messaging permission");

  for (const [value, check] of [
    ["10", (e: WhatsAppGraphError) => e.invalidToken && e.code === 10],
    ["190", (e: WhatsAppGraphError) => e.invalidToken && e.code === 190],
    ["132001", (e: WhatsAppGraphError) => !e.invalidToken && e.code === 132001],
    ["500", (e: WhatsAppGraphError) => !e.invalidToken && e.status === 500],
  ] as const) {
    await setFault(t.mock, "meta.send", value);
    await assert.rejects(send(token, PHONE_FRESH), (e: unknown) => e instanceof WhatsAppGraphError && check(e), `meta.send=${value}`);
  }
  await control(t.mock, "/__mock/faults/clear");
  assert.ok((await send(token, PHONE_FRESH)).providerMessageId);

  await setFault(t.mock, "latency.meta", "300");
  const started = Date.now();
  await getPhoneNumber(PHONE_FRESH, token);
  assert.ok(Date.now() - started >= 290);
});

test("SMS sink: the app's generic provider posts to it with the key; a wrong key or the fault is an error", async () => {
  const sent = await sendSMS({ to: "9876543210", body: "Your session is confirmed. Join here: http://x.test/meet/mock-abcd-efgh" });
  assert.match(sent.providerMessageId, /^MOCK-SMS-/);
  const last = t.mock.state().sms.at(-1)!;
  assert.equal(last.id, sent.providerMessageId);
  assert.equal(last.to, "+919876543210", "the app normalises the number");
  assert.match(last.body, /Join here/);

  await setFault(t.mock, "sms", "500");
  await assert.rejects(sendSMS({ to: "9876543210", body: "x" }), /SMS send failed \(500\)/);
  await control(t.mock, "/__mock/faults/clear");
  const wrongKey = await raw(t.mock, "POST", "/sms/send", { authorization: "Bearer nope", "content-type": "application/json" }, JSON.stringify({ to: "+91", body: "x" }));
  assert.equal(wrongKey.status, 401);
  const noBody = await raw(t.mock, "POST", "/sms/send", { authorization: `Bearer ${SMS_API_KEY}`, "content-type": "application/json" }, JSON.stringify({ to: "+91" }));
  assert.equal(noBody.status, 400);
});

/* ---------- the Embedded Signup popup and the mock SDK ---------- */

const dialogQuery = (o: Record<string, string> = {}) =>
  new URLSearchParams({ app_id: META_APP_ID, config_id: META_ES_CONFIG_ID, response_type: "code", opener: "http://localhost:3000", session: "sess-0123456789", v: "v26.0", siv: "3", ...o }).toString();

test("Embedded Signup window: checks the app, config and opener, then answers with the account ids and a code", async () => {
  await fresh();
  const ok = await raw(t.mock, "GET", `/meta/dialog/embedded-signup?${dialogQuery()}`);
  assert.equal(ok.status, 200);
  assert.match(ok.text, /MOCK of Meta&#39;s WhatsApp Embedded Signup/);
  assert.match(ok.text, /have NOT been verified/);
  assert.match(ok.text, /Mock Coaching \(new account\)/);
  assert.match(ok.text, /\+91 00000 02001/);
  assert.match(ok.text, /Create a new WhatsApp Business account/);

  for (const [bad, pattern] of [
    [{ app_id: "123" }, /Invalid app/],
    [{ config_id: "123" }, /Invalid configuration/],
    [{ response_type: "token" }, /response type/i],
    [{ opener: "https://app.example.com" }, /local address/],
    [{ opener: "http://localhost@evil.com" }, /local address/],
    [{ session: "x" }, /session/i],
  ] as const) {
    const res = await raw(t.mock, "GET", `/meta/dialog/embedded-signup?${dialogQuery(bad)}`);
    assert.equal(res.status, 400, JSON.stringify(bad));
    assert.match(res.text, pattern);
  }

  const submit = async (fields: Record<string, string>, headers: Record<string, string> = {}) => {
    const page = await raw(t.mock, "GET", `/meta/dialog/embedded-signup?${dialogQuery()}`);
    const form_token = /name="form_token" value="([^"]+)"/.exec(page.text)![1];
    return raw(t.mock, "POST", "/meta/dialog/embedded-signup/finish", { "content-type": "application/x-www-form-urlencoded", origin: t.mock.url, ...headers }, new URLSearchParams({ form_token, session: "sess-0123456789", opener: "http://localhost:3000", ...fields }).toString());
  };
  const messageOf = (html: string) => JSON.parse(/var m=(\{.*?\});var o=/s.exec(html)![1]);

  const finished = await submit({ target: `${WABA_NEW}:${PHONE_FRESH}`, outcome: "finish", order: "code-first" });
  assert.equal(finished.status, 200);
  assert.match(String(finished.headers["content-security-policy"]), /script-src 'nonce-/);
  assert.match(finished.text, /window\.opener\.postMessage\(m,o\)/);
  assert.match(finished.text, /var o="http:\/\/localhost:3000"/);
  const message = messageOf(finished.text);
  assert.equal(message.event, "FINISH");
  assert.equal(message.session, "sess-0123456789");
  assert.deepEqual(message.data, { waba_id: WABA_NEW, phone_number_id: PHONE_FRESH });
  assert.equal(message.order, "code-first");
  assert.equal(await exchangeEmbeddedCode(message.code).then((x) => x.startsWith("MOCK-NOT-REAL-meta-")), true, "the code is one the app can exchange");

  const cancelled = messageOf((await submit({ outcome: "cancel", cancel_step: "PHONE_NUMBER_SETUP", target: "NEW" })).text);
  assert.deepEqual([cancelled.event, cancelled.data, cancelled.code], ["CANCEL", { current_step: "PHONE_NUMBER_SETUP" }, undefined]);
  const errored = messageOf((await submit({ outcome: "error", error_message: "<b>boom</b>", target: "NEW" })).text);
  assert.deepEqual([errored.event, errored.data], ["ERROR", { error_message: "<b>boom</b>" }]);
  const html = (await submit({ outcome: "error", error_message: "</script><img src=x onerror=alert(1)>", target: "NEW" })).text;
  assert.ok(!html.includes("</script><img"), "the message cannot break out of the script element");

  const created = messageOf((await submit({ outcome: "finish", target: "NEW", order: "ids-first" })).text);
  assert.equal(created.order, "ids-first");
  const newPhone = t.mock.state().meta.phones[created.data.phone_number_id];
  assert.ok(newPhone && newPhone.wabaId === created.data.waba_id && !newPhone.registered && newPhone.pin === null, "a fresh account with a fresh number");
  assert.match(created.data.waba_id, /^\d{5,30}$/, "ids the app accepts");

  // Single-use form token, same-origin, and an unlisted combination.
  const page = await raw(t.mock, "GET", `/meta/dialog/embedded-signup?${dialogQuery()}`);
  const form_token = /name="form_token" value="([^"]+)"/.exec(page.text)![1];
  const body = new URLSearchParams({ form_token, session: "sess-0123456789", opener: "http://localhost:3000", outcome: "finish", target: `${WABA_NEW}:${PHONE_FRESH}` }).toString();
  const headers = { "content-type": "application/x-www-form-urlencoded", origin: t.mock.url };
  assert.equal((await raw(t.mock, "POST", "/meta/dialog/embedded-signup/finish", { ...headers, "sec-fetch-site": "cross-site" }, body)).status, 403);
  assert.equal((await raw(t.mock, "POST", "/meta/dialog/embedded-signup/finish", headers, body)).status, 200);
  assert.equal((await raw(t.mock, "POST", "/meta/dialog/embedded-signup/finish", headers, body)).status, 403, "the form token works once");
  assert.equal((await submit({ outcome: "finish", target: `${WABA_NEW}:${PHONE_MANUAL}` })).status, 400, "that number is not on that account");
});

/** Runs the mock SDK the way a browser page would, with a stub window, and returns what the app's callbacks would see. */
async function runSdk(message: Record<string, unknown> | null, o: { blocked?: boolean } = {}) {
  const src = (await raw(t.mock, "GET", "/meta/en_US/sdk.js")).text;
  const events: string[] = [];
  const listeners: ((e: unknown) => void)[] = [];
  const popup = { closed: false };
  let opened = "";
  class MessageEvent {
    constructor(
      readonly type: string,
      init: { origin: string; data: string },
    ) {
      Object.assign(this, init);
    }
  }
  const win: Record<string, unknown> = {
    location: { origin: "http://localhost:3000" },
    crypto: webcrypto,
    open: (url: string) => ((opened = url), o.blocked ? null : popup),
    addEventListener: (_n: string, fn: (e: unknown) => void) => listeners.push(fn),
    removeEventListener: (_n: string, fn: (e: unknown) => void) => listeners.splice(listeners.indexOf(fn), 1),
    dispatchEvent: (e: { origin: string; data: string }) => events.push(`event:${JSON.parse(e.data).event}@${e.origin}`),
    fbAsyncInit: () => events.push("fbAsyncInit"),
  };
  const ctx = vm.createContext({ window: win, MessageEvent, URLSearchParams, setTimeout, clearInterval, setInterval, console });
  vm.runInContext(src, ctx);
  await new Promise((r) => setTimeout(r, 20));
  const FB = win.FB as { init(o: object): void; login(cb: (r: unknown) => void, o: object): void };
  FB.init({ appId: META_APP_ID, version: "v26.0" });
  FB.login((r) => events.push(`callback:${JSON.stringify(r)}`), { config_id: META_ES_CONFIG_ID, response_type: "code", extras: { sessionInfoVersion: "3" } });
  const session = new URL(opened || "http://x/?session=none").searchParams.get("session");
  if (message) listeners[0]?.({ origin: t.mock.url, source: popup, data: { session, ...message } });
  return { events, opened, listeners, popup };
}

test("mock SDK: served as no-store JavaScript with the mock origin baked in and nothing reflected from the request", async () => {
  const res = await raw(t.mock, "GET", `/meta/en_US/sdk.js?x=%3Cscript%3Ealert(1)%3C/script%3E&origin=http://evil.example`);
  assert.equal(res.status, 200);
  assert.match(String(res.headers["content-type"]), /^application\/javascript; charset=utf-8$/);
  assert.equal(res.headers["cache-control"], "no-store");
  assert.ok(res.text.includes(JSON.stringify(t.mock.url)));
  assert.ok(!res.text.includes("evil.example") && !res.text.includes("alert(1)"));
  assert.match(res.text, /MOCK Facebook SDK/);
});

test("mock SDK: FB.login opens the popup with the app's configuration, then answers like Meta (code first, ids 800 ms later)", async () => {
  const run = await runSdk({ event: "FINISH", data: { waba_id: WABA_NEW, phone_number_id: PHONE_FRESH }, code: "the-code", order: "code-first" });
  const url = new URL(run.opened);
  assert.equal(url.origin, t.mock.url);
  assert.equal(url.pathname, "/meta/dialog/embedded-signup");
  assert.deepEqual([url.searchParams.get("app_id"), url.searchParams.get("config_id"), url.searchParams.get("response_type"), url.searchParams.get("opener"), url.searchParams.get("siv")], [META_APP_ID, META_ES_CONFIG_ID, "code", "http://localhost:3000", "3"]);
  assert.deepEqual(run.events, ["fbAsyncInit", `callback:${JSON.stringify({ authResponse: { code: "the-code" }, status: "connected" })}`]);
  await new Promise((r) => setTimeout(r, 900));
  assert.equal(run.events.at(-1), "event:FINISH@https://www.facebook.com");

  const idsFirst = await runSdk({ event: "FINISH", data: { waba_id: WABA_NEW, phone_number_id: PHONE_FRESH }, code: "c2", order: "ids-first" });
  assert.deepEqual(idsFirst.events.slice(1), ["event:FINISH@https://www.facebook.com"]);
  await new Promise((r) => setTimeout(r, 900));
  assert.match(idsFirst.events.at(-1)!, /^callback:.*c2/);
});

test("mock SDK: CANCEL and ERROR reach the app before the callback, a closed or blocked popup is a plain cancel, strangers are ignored", async () => {
  const cancel = await runSdk({ event: "CANCEL", data: { current_step: "WABA_SELECTION" }, order: "code-first" });
  assert.deepEqual(cancel.events.slice(1), ["event:CANCEL@https://www.facebook.com", `callback:${JSON.stringify({ authResponse: null, status: "unknown" })}`]);
  const error = await runSdk({ event: "ERROR", data: { error_message: "x" }, order: "code-first" });
  assert.equal(error.events[1], "event:ERROR@https://www.facebook.com");

  const blocked = await runSdk(null, { blocked: true });
  assert.deepEqual(blocked.events.slice(1), [`callback:${JSON.stringify({ authResponse: null, status: "unknown" })}`]);

  const closed = await runSdk(null);
  closed.popup.closed = true;
  await new Promise((r) => setTimeout(r, 700));
  assert.deepEqual(closed.events.slice(1), [`callback:${JSON.stringify({ authResponse: null, status: "unknown" })}`], "closing the window without finishing");

  const stranger = await runSdk(null);
  stranger.listeners[0]({ origin: "http://evil.example", source: stranger.popup, data: { event: "FINISH", code: "x", session: "whatever" } });
  stranger.listeners[0]({ origin: t.mock.url, source: {}, data: { event: "FINISH", code: "x", session: "whatever" } });
  stranger.listeners[0]({ origin: t.mock.url, source: stranger.popup, data: { event: "FINISH", code: "x", session: "someone-elses" } });
  assert.deepEqual(stranger.events, ["fbAsyncInit"], "wrong origin, wrong window and wrong session are all ignored");
  stranger.popup.closed = true; // lets the SDK's polling timer end
  await new Promise((r) => setTimeout(r, 700));
});
