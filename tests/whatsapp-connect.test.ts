import "dotenv/config";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { decryptSecret, encryptSecret } from "../lib/crypto";
import { getOverview } from "../lib/dashboard-data";
import { prisma } from "../lib/db";
import { ENCRYPTED_COLUMNS } from "../lib/key-rotation-db";
import { KNOWN_TEMPLATES, TEMPLATE_SPECS, isMetaTemplateName, metaTemplateName, templateKeyFromMetaName, templateParams } from "../lib/message-templates";
import { sendMessageForBooking } from "../lib/messaging";
import { sendWhatsApp } from "../lib/whatsapp";
import { DEFAULT_GRAPH_VERSION, graphBase, graphVersion } from "../lib/whatsapp-graph-version";
import { parseTemplateStatusUpdates } from "../lib/whatsapp-webhook";
import {
  REQUIRED_SCOPES,
  WhatsAppGraphError,
  checkTokenInfo,
  debugToken,
  embeddedSignupConfig,
  ensureTemplates,
  exchangeEmbeddedCode,
  getPhoneNumber,
  listTemplates,
  metaAppCredentials,
  registerNumber,
  templatePayload,
  wabaOwnsNumber,
  webhookAppSecret,
} from "../lib/whatsapp-connect";
import {
  WhatsAppConnectError,
  WhatsAppNotConnectedError,
  applyTemplateStatusUpdate,
  connectEmbedded,
  connectManual,
  connectionsAwaitingTemplates,
  disconnect,
  generateRegistrationPin,
  getConnectionView,
  markTokenInvalid,
  refreshTemplates,
  resolveSendCredentials,
  whatsappPinAad,
  whatsappTokenAad,
  type ConnectDeps,
} from "../lib/whatsapp-connection";

/* ---------- templates ---------- */

test("every template we send has a Meta body that matches its parameters", () => {
  assert.deepEqual(Object.keys(TEMPLATE_SPECS).sort(), [...KNOWN_TEMPLATES].sort());
  const ctx = { link: "https://meet.google.com/x", serviceTitle: "Call", influencerName: "Sam", when: "Mon 11:00" };
  for (const [name, spec] of Object.entries(TEMPLATE_SPECS)) {
    const vars = [...spec.body.matchAll(/\{\{(\d+)\}\}/g)].map((m) => Number(m[1]));
    assert.deepEqual(vars, vars.map((_, i) => i + 1), `${name}: variables are numbered 1..n in order`);
    assert.equal(vars.length, templateParams(name, ctx).length, `${name}: same number of variables as parameters sent`);
    assert.equal(spec.examples.length, vars.length, `${name}: one example per variable`);
    assert.ok(!/^\{\{/.test(spec.body) && !/\}\}$/.test(spec.body), `${name}: Meta rejects a body that starts or ends with a variable`);
    assert.ok(spec.body.length < 1024);
  }
});

test("every template name sent to Meta follows Meta's rule (lowercase letters, digits, underscores), and maps back to our key", () => {
  // Meta refuses a name like "booking-confirmation", so a hyphenated name means that template can never be approved.
  assert.equal(isMetaTemplateName("booking-confirmation"), false);
  assert.equal(isMetaTemplateName("Booking_confirmation"), false);
  assert.equal(isMetaTemplateName(""), false);
  const seen = new Set<string>();
  for (const key of KNOWN_TEMPLATES) {
    const name = TEMPLATE_SPECS[key].name;
    assert.match(name, /^[a-z0-9_]{1,512}$/, `${key}: "${name}" is not a name Meta accepts`);
    assert.equal(name, metaTemplateName(key));
    assert.equal(templateKeyFromMetaName(name), key, `${key}: the name maps back`);
    assert.equal(templatePayload(TEMPLATE_SPECS[key], "en").name, name, `${key}: the submitted payload carries the Meta name`);
    assert.ok(!seen.has(name), `${key}: names are unique`);
    seen.add(name);
  }
  assert.equal(metaTemplateName("booking-confirmation"), "booking_confirmation");
  assert.equal(metaTemplateName("reminder-24h"), "reminder_24h");
  assert.equal(metaTemplateName("reminder-15m"), "reminder_15m");
  assert.equal(templateKeyFromMetaName("not_ours"), null);
  assert.equal(metaTemplateName("something-else"), "something-else", "a key we do not know passes through");
  assert.throws(() => templatePayload({ ...TEMPLATE_SPECS.reschedule, name: "re-schedule" }, "en"), /not a valid WhatsApp template name/);
});

test("the submitted payload is a UTILITY template with examples", () => {
  const p = templatePayload(TEMPLATE_SPECS["booking-confirmation"], "en");
  assert.equal(p.category, "UTILITY");
  assert.equal(p.name, "booking_confirmation");
  assert.equal(p.components[0].type, "BODY");
  assert.equal(p.components[0].example.body_text[0].length, 4);
});

test("sending uses the Meta name of the template, not our key", async () => {
  let sent: { template?: { name?: string } } = {};
  const fetchImpl = (async (_url: string, init?: RequestInit) => {
    sent = JSON.parse(String(init?.body));
    return json(200, { messages: [{ id: "wamid.1" }] });
  }) as unknown as typeof fetch;
  const prev = { dry: process.env.MESSAGING_DRY_RUN, off: process.env.WHATSAPP_DISABLED };
  delete process.env.MESSAGING_DRY_RUN;
  delete process.env.WHATSAPP_DISABLED;
  try {
    for (const key of KNOWN_TEMPLATES) {
      await sendWhatsApp({ to: "+919876543210", template: key, credentials: { token: "t", phoneNumberId: "1" } }, fetchImpl);
      assert.equal(sent.template?.name, TEMPLATE_SPECS[key].name, key);
    }
  } finally {
    if (prev.dry !== undefined) process.env.MESSAGING_DRY_RUN = prev.dry;
    if (prev.off !== undefined) process.env.WHATSAPP_DISABLED = prev.off;
  }
});

/* ---------- Graph client (no network) ---------- */

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });

test("phone number lookup, account ownership and token errors", async () => {
  const ok = (async () => json(200, { id: "111", display_phone_number: "+91 98765 43210", verified_name: "Sam Coaching", quality_rating: "GREEN" })) as unknown as typeof fetch;
  const info = await getPhoneNumber("111", "tok", ok);
  assert.equal(info.displayPhone, "+91 98765 43210");
  assert.equal(info.verifiedName, "Sam Coaching");

  const bad = (async () => json(400, { error: { message: "Invalid OAuth access token.", code: 190 } })) as unknown as typeof fetch;
  await assert.rejects(getPhoneNumber("111", "tok", bad), (e: unknown) => e instanceof WhatsAppGraphError && e.invalidToken);

  const nums = (async () => json(200, { data: [{ id: "111" }, { id: "222" }] })) as unknown as typeof fetch;
  assert.equal(await wabaOwnsNumber("w", "222", "tok", nums), true);
  assert.equal(await wabaOwnsNumber("w", "999", "tok", nums), false);
  const down = (async () => { throw new Error("socket hang up"); }) as unknown as typeof fetch;
  await assert.rejects(getPhoneNumber("111", "tok", down), (e: unknown) => e instanceof WhatsAppGraphError && e.status === 0 && !e.invalidToken);
});

test("ensureTemplates submits only what is missing and survives per-template failures", async () => {
  const posted: string[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    if (init?.method === "POST") {
      const name = JSON.parse(String(init.body)).name as string;
      posted.push(name);
      if (name === "reminder_15m") return json(400, { error: { message: "Invalid parameter", code: 100 } });
      if (name === "cancellation") return json(400, { error: { message: "Content in this language already exists", code: 100, error_subcode: 2388024 } });
      return json(200, { id: `t_${name}`, status: "PENDING" });
    }
    return json(200, { data: [{ name: "booking_confirmation", language: "en", status: "APPROVED" }, { name: "other-template", language: "en", status: "APPROVED" }] });
  }) as unknown as typeof fetch;

  const r = await ensureTemplates("waba1", "tok", "en", fetchImpl);
  assert.ok(posted.every(isMetaTemplateName), `every submitted name is one Meta accepts: ${posted.join(", ")}`);
  assert.ok(!posted.includes("booking_confirmation"), "an existing template is not submitted again");
  assert.deepEqual(r.submitted.sort(), ["reminder-24h", "reschedule"]);
  assert.deepEqual(r.failed.map((f) => f.name), ["reminder-15m"]);
  assert.equal(r.templates["booking-confirmation"].status, "APPROVED");
  assert.equal(r.templates["reminder-24h"].status, "PENDING");
  assert.equal(r.templates["reminder-15m"], undefined, "a failed submission is not reported as present");
  assert.ok(!("other-template" in r.templates), "templates we do not own are ignored");
});

test("Embedded Signup exchanges the code and needs the Meta app configured", async () => {
  const env = { META_APP_ID: "app", META_APP_SECRET: "secret", META_ES_CONFIG_ID: "cfg" } as unknown as NodeJS.ProcessEnv;
  let url = "";
  const fetchImpl = (async (u: string) => ((url = u), json(200, { access_token: "business-token" }))) as unknown as typeof fetch;
  assert.equal(await exchangeEmbeddedCode("the-code", env, fetchImpl), "business-token");
  assert.match(url, /client_id=app/);
  assert.match(url, /code=the-code/);
  await assert.rejects(exchangeEmbeddedCode("c", {} as NodeJS.ProcessEnv, fetchImpl), /not configured/);
  assert.deepEqual(embeddedSignupConfig(env), { appId: "app", configId: "cfg", graphVersion: DEFAULT_GRAPH_VERSION });
  assert.equal(embeddedSignupConfig({ META_APP_ID: "app" } as unknown as NodeJS.ProcessEnv), null);
});

test("the Meta app secret is accepted under either name, for the webhook and for Embedded Signup", () => {
  const e = (o: Record<string, string>) => o as unknown as NodeJS.ProcessEnv;
  assert.equal(webhookAppSecret(e({ WHATSAPP_APP_SECRET: "a" })), "a");
  assert.equal(webhookAppSecret(e({ META_APP_SECRET: "m" })), "m", "the webhook can be verified with META_APP_SECRET");
  assert.equal(webhookAppSecret(e({ WHATSAPP_APP_SECRET: "a", META_APP_SECRET: "m" })), "a", "each use keeps the name it read first");
  assert.equal(webhookAppSecret(e({})), undefined);
  assert.deepEqual(metaAppCredentials(e({ META_APP_ID: "app", WHATSAPP_APP_SECRET: "a" })), { appId: "app", appSecret: "a" }, "Embedded Signup and the token check work with WHATSAPP_APP_SECRET");
  assert.deepEqual(metaAppCredentials(e({ META_APP_ID: "app", META_APP_SECRET: "m", WHATSAPP_APP_SECRET: "a" })), { appId: "app", appSecret: "m" });
  assert.equal(metaAppCredentials(e({ META_APP_SECRET: "m" })), null, "no app id");
  assert.deepEqual(embeddedSignupConfig(e({ META_APP_ID: "app", META_ES_CONFIG_ID: "cfg", WHATSAPP_APP_SECRET: "a" })), { appId: "app", configId: "cfg", graphVersion: DEFAULT_GRAPH_VERSION });
});

test("a permission error is a bad token, like an expired one; other errors are not", () => {
  const bad = (code: number | null, status = 400) => new WhatsAppGraphError("x", status, code).invalidToken;
  for (const code of [190, 10, 200, 210, 299]) assert.equal(bad(code), true, `code ${code}`);
  assert.equal(bad(null, 401), true, "HTTP 401");
  for (const code of [100, 4, 17, 131030, 131047, 133005, 300, 9, 11]) assert.equal(bad(code), false, `code ${code} is not a token problem`);
  assert.equal(bad(null, 500), false);
});

test("the token check judges what Meta says about the token", () => {
  const now = new Date("2026-11-02T00:00:00Z");
  const hours = (h: number) => new Date(now.getTime() + h * 3_600_000);
  const ok = { valid: true, expiresAt: null, scopes: [...REQUIRED_SCOPES, "business_management"] };

  assert.deepEqual(checkTokenInfo(ok, now), { ok: true, notes: [] }, "a permanent token with both permissions is healthy");

  const invalid = checkTokenInfo({ ...ok, valid: false }, now);
  assert.equal(invalid.ok, false);

  const noMessaging = checkTokenInfo({ ...ok, scopes: ["whatsapp_business_management"] }, now);
  assert.ok(!noMessaging.ok && /whatsapp_business_messaging/.test(noMessaging.message) && !/whatsapp_business_management/.test(noMessaging.message));
  const neither = checkTokenInfo({ ...ok, scopes: ["business_management"] }, now);
  assert.ok(!neither.ok && /whatsapp_business_management and whatsapp_business_messaging/.test(neither.message));

  const day = checkTokenInfo({ ...ok, expiresAt: hours(23) }, now);
  assert.ok(!day.ok && /expires in 23 hour/.test(day.message) && /System User/.test(day.message), "the 24-hour API Setup token is refused");
  const sixDays = checkTokenInfo({ ...ok, expiresAt: hours(6 * 24) }, now);
  assert.ok(!sixDays.ok && /expires in 6 days/.test(sixDays.message));
  assert.equal(checkTokenInfo({ ...ok, expiresAt: hours(7 * 24 + 1) }, now).ok, true, "just over a week is accepted");

  const later = checkTokenInfo({ ...ok, expiresAt: hours(60 * 24) }, now);
  assert.ok(later.ok && later.notes.length === 1 && /expires on 2027-01-01/.test(later.notes[0]), "a token that does expire later is accepted with a note");

  const unlisted = checkTokenInfo({ ...ok, scopes: null }, now);
  assert.ok(unlisted.ok && /could not check them/.test(unlisted.notes[0]), "unknown permissions are noted, not refused");
});

test("debug_token is read with the app's token, and its answer is turned into token info", async () => {
  const seen: { url: string; auth: string | null }[] = [];
  const answer = (data: unknown) => (async (url: string, init?: RequestInit) => {
    seen.push({ url, auth: new Headers(init?.headers).get("authorization") });
    return json(200, { data });
  }) as unknown as typeof fetch;

  const forever = await debugToken("USER-TOKEN", "app1", "secret1", answer({ is_valid: true, expires_at: 0, scopes: ["whatsapp_business_management", "whatsapp_business_messaging"] }));
  assert.deepEqual(forever, { valid: true, expiresAt: null, scopes: ["whatsapp_business_management", "whatsapp_business_messaging"] });
  assert.match(seen[0].url, /\/debug_token\?input_token=USER-TOKEN$/);
  assert.equal(seen[0].auth, "Bearer app1|secret1", "asked as the app, not with the influencer's own token");

  const soon = await debugToken("t", "a", "s", answer({ is_valid: true, expires_at: 1_800_000_000, granular_scopes: [{ scope: "whatsapp_business_messaging", target_ids: ["1"] }, { scope: "whatsapp_business_management" }] }));
  assert.equal(soon.expiresAt?.getTime(), 1_800_000_000_000);
  assert.deepEqual(soon.scopes?.sort(), ["whatsapp_business_management", "whatsapp_business_messaging"], "granular permissions count");

  assert.deepEqual(await debugToken("t", "a", "s", answer({ is_valid: false, scopes: [] })), { valid: false, expiresAt: null, scopes: null });
  await assert.rejects(debugToken("t", "a", "s", (async () => json(200, {})) as unknown as typeof fetch), WhatsAppGraphError);
});

test("registering a number: a PIN mismatch is recognised, 'already registered' is fine, 'not registered' is not", async () => {
  const fail = (status: number, error: Record<string, unknown>) => (async () => json(status, { error })) as unknown as typeof fetch;
  await assert.rejects(registerNumber("111", "tok", "123456", fail(400, { message: "Two step verification PIN Mismatch", code: 133005 })), (e: unknown) => e instanceof WhatsAppGraphError && e.pinMismatch && !e.pinLocked && !e.invalidToken);
  await assert.rejects(registerNumber("111", "tok", "123456", fail(400, { message: "Too many guesses", code: 133008 })), (e: unknown) => e instanceof WhatsAppGraphError && e.pinLocked && !e.pinMismatch);
  await registerNumber("111", "tok", "123456", fail(400, { message: "The phone number is already registered", code: 100 }));
  await assert.rejects(registerNumber("111", "tok", "123456", fail(400, { message: "Phone number not registered", code: 133010 })), WhatsAppGraphError);
  let body = "";
  await registerNumber("111", "tok", "123456", (async (_u: string, init?: RequestInit) => ((body = String(init?.body)), json(200, { success: true }))) as unknown as typeof fetch);
  assert.deepEqual(JSON.parse(body), { messaging_product: "whatsapp", pin: "123456" });
});

test("generated PINs are six digits and not all the same", () => {
  const pins = Array.from({ length: 60 }, generateRegistrationPin);
  assert.ok(pins.every((p) => /^\d{6}$/.test(p)));
  assert.ok(new Set(pins).size > 50, "random, not a constant");
});

test("the PIN column is encrypted with an owner-bound AAD and listed for key rotation", { skip: process.env.TOKEN_ENCRYPTION_KEY ? false : "TOKEN_ENCRYPTION_KEY not set" }, () => {
  const enc = encryptSecret("482913", whatsappPinAad("inf-1"));
  assert.ok(!enc.includes("482913"));
  assert.equal(decryptSecret(enc, whatsappPinAad("inf-1")), "482913", "round trip");
  assert.throws(() => decryptSecret(enc, whatsappPinAad("inf-2")), "another owner's AAD does not decrypt it");
  assert.throws(() => decryptSecret(enc, whatsappTokenAad("inf-1")), "nor does the token's AAD");
  assert.notEqual(whatsappPinAad("inf-1"), whatsappTokenAad("inf-1"));
  assert.ok(whatsappPinAad("inf-1").includes("inf-1"), "the AAD names the connection owner");

  const col = ENCRYPTED_COLUMNS.find((c) => c.name === "whatsapp_connections.registration_pin_enc");
  assert.ok(col, "listed for key rotation");
  assert.deepEqual([col.table, col.column, col.ownerColumn], ["whatsapp_connections", "registration_pin_enc", "influencer_id"]);
  assert.equal(col.aad("inf-1"), whatsappPinAad("inf-1"), "rotation uses the AAD the app writes with");
});

test("template status webhooks are parsed per account", () => {
  const updates = parseTemplateStatusUpdates({
    entry: [
      {
        id: "waba1",
        changes: [
          { field: "message_template_status_update", value: { event: "APPROVED", message_template_name: "reschedule", message_template_language: "en" } },
          { field: "message_template_status_update", value: { event: "REJECTED", message_template_name: "cancellation", message_template_language: "en", reason: "INVALID_FORMAT" } },
          { field: "messages", value: {} },
        ],
      },
      { changes: [{ field: "message_template_status_update", value: { event: "APPROVED", message_template_name: "x" } }] },
    ],
  });
  assert.deepEqual(updates.map((u) => [u.wabaId, u.name, u.status, u.reason]), [["waba1", "reschedule", "APPROVED", null], ["waba1", "cancellation", "REJECTED", "INVALID_FORMAT"]]);
  assert.deepEqual(parseTemplateStatusUpdates(null), []);
});

/* ---------- Connections (database) ---------- */

const skip = process.env.DATABASE_URL && process.env.TOKEN_ENCRYPTION_KEY ? false : "DATABASE_URL / TOKEN_ENCRYPTION_KEY not set";
const run = Date.now();
const WABA = String(8_000_000_000_000 + (run % 1_000_000_000));
const PHONE = String(7_000_000_000_000 + (run % 1_000_000_000));
let a: string;
let b: string;

function fakeDeps(over: Partial<ConnectDeps> = {}): ConnectDeps {
  return {
    getPhoneNumber: async (id) => ({ id, displayPhone: "+91 98765 43210", verifiedName: "Sam Coaching", qualityRating: "GREEN" }),
    wabaOwnsNumber: async () => true,
    ensureTemplates: async () => ({ templates: { "booking-confirmation": { status: "PENDING", language: "en" } }, submitted: ["booking-confirmation"], failed: [] }),
    exchangeCode: async () => "business-token-from-meta-0123456789",
    subscribeApp: async () => {},
    registerNumber: async () => {},
    inspectToken: async () => ({ valid: true, expiresAt: null, scopes: [...REQUIRED_SCOPES, "business_management"] }),
    ...over,
  };
}

before(async () => {
  if (skip) return;
  a = (await prisma.influencer.create({ data: { slug: `wa-a-${run}`, name: "Alpha", email: `wa-a-${run}@example.com` } })).id;
  b = (await prisma.influencer.create({ data: { slug: `wa-b-${run}`, name: "Beta", email: `wa-b-${run}@example.com` } })).id;
});

after(async () => {
  if (!skip) await prisma.influencer.deleteMany({ where: { id: { in: [a, b].filter(Boolean) } } });
  await prisma.$disconnect();
});

test("connecting verifies with Meta, stores the token encrypted and reports template status", { skip }, async () => {
  const token = "EAAG-permanent-token-for-tests-1234567890";
  const view = await connectManual(a, { wabaId: WABA, phoneNumberId: PHONE, accessToken: token }, fakeDeps());
  assert.equal(view.displayPhone, "+91 98765 43210");
  assert.equal(view.ready, false, "templates are still in review");
  assert.equal(view.templates.find((t) => t.name === "booking-confirmation")?.status, "PENDING");
  assert.equal(view.templates.find((t) => t.name === "reschedule")?.status, "NOT_SUBMITTED");

  const row = await prisma.whatsAppConnection.findUniqueOrThrow({ where: { influencerId: a } });
  assert.ok(!row.tokenEnc.includes(token), "the token is not stored in plaintext");
  assert.equal(JSON.stringify(await getConnectionView(a)).includes(token), false, "the token never leaves the server");
  assert.deepEqual(await resolveSendCredentials(a, {} as NodeJS.ProcessEnv), { token, phoneNumberId: PHONE });
});

test("bad ids, a number on another account and a number owned by someone else are refused", { skip }, async () => {
  const tok = "EAAG-another-token-for-tests-1234567890";
  await assert.rejects(connectManual(b, { wabaId: "abc", phoneNumberId: PHONE, accessToken: tok }, fakeDeps()), (e: unknown) => e instanceof WhatsAppConnectError && e.field === "wabaId");
  await assert.rejects(connectManual(b, { wabaId: WABA, phoneNumberId: PHONE, accessToken: "short" }, fakeDeps()), (e: unknown) => e instanceof WhatsAppConnectError && e.field === "accessToken");
  await assert.rejects(
    connectManual(b, { wabaId: WABA, phoneNumberId: PHONE, accessToken: tok }, fakeDeps({ wabaOwnsNumber: async () => false })),
    (e: unknown) => e instanceof WhatsAppConnectError && e.field === "phoneNumberId",
  );
  await assert.rejects(connectManual(b, { wabaId: WABA, phoneNumberId: PHONE, accessToken: tok }, fakeDeps()), (e: unknown) => e instanceof WhatsAppConnectError && e.status === 409, "already on account A");
  await assert.rejects(
    connectManual(b, { wabaId: WABA, phoneNumberId: String(Number(PHONE) + 1), accessToken: tok }, fakeDeps({ getPhoneNumber: async () => { throw new WhatsAppGraphError("Invalid OAuth access token", 400, 190); } })),
    (e: unknown) => e instanceof WhatsAppConnectError && e.field === "accessToken",
  );
  assert.equal(await prisma.whatsAppConnection.count({ where: { influencerId: b } }), 0, "nothing saved after a failed check");
});

test("a template-sync failure does not block connecting", { skip }, async () => {
  const view = await connectManual(b, { wabaId: WABA, phoneNumberId: String(Number(PHONE) + 2), accessToken: "EAAG-third-token-for-tests-1234567890" }, fakeDeps({ ensureTemplates: async () => { throw new Error("Graph down"); } }));
  assert.equal(view.status, "ACTIVE");
  assert.ok(view.templates.every((t) => t.status === "NOT_SUBMITTED"));
  await disconnect(b);
});

test("Embedded Signup exchanges the code, subscribes the account and saves", { skip }, async () => {
  const calls: string[] = [];
  const deps = fakeDeps({ subscribeApp: async (w) => void calls.push(`subscribe:${w}`), registerNumber: async (p, _t, pin) => void calls.push(`register:${p}:${pin}`) });
  const phone = String(Number(PHONE) + 3);
  const view = await connectEmbedded(b, { code: "code-123456", wabaId: WABA, phoneNumberId: phone }, deps, { WHATSAPP_REGISTRATION_PIN: "123456" } as unknown as NodeJS.ProcessEnv);
  assert.equal(view.source, "embedded");
  assert.deepEqual(calls, [`subscribe:${WABA}`, `register:${phone}:123456`]);
  await assert.rejects(connectEmbedded(b, { code: "c", wabaId: "x", phoneNumberId: "y" }, deps), WhatsAppConnectError);
  await disconnect(b);
});

test("every Embedded Signup number gets its own random PIN, kept encrypted, unless the influencer supplies theirs", { skip }, async () => {
  const phone = String(Number(PHONE) + 4);
  const registered: string[] = [];
  const deps = fakeDeps({ registerNumber: async (_p, _t, pin) => void registered.push(pin) });
  // No WHATSAPP_REGISTRATION_PIN at all: the number is still registered (it used to be skipped, so sends failed).
  const view = await connectEmbedded(b, { code: "code-123456", wabaId: WABA, phoneNumberId: phone }, deps, {} as unknown as NodeJS.ProcessEnv);
  assert.equal(view.status, "ACTIVE");
  assert.equal(registered.length, 1, "registered without any global PIN configured");
  assert.match(registered[0], /^\d{6}$/);

  const row = await prisma.whatsAppConnection.findUniqueOrThrow({ where: { influencerId: b } });
  assert.ok(row.registrationPinEnc && !row.registrationPinEnc.includes(registered[0]), "stored encrypted, not in plaintext");
  assert.equal(decryptSecret(row.registrationPinEnc, whatsappPinAad(b)), registered[0], "the stored PIN is the one the number was registered with");
  assert.throws(() => decryptSecret(row.registrationPinEnc!, whatsappPinAad(a)), "bound to its owner");
  assert.equal(JSON.stringify(await getConnectionView(b)).includes(registered[0]), false, "the PIN never leaves the server");

  // A reconnect registers with the same PIN (a different one would be refused), not a fresh random one.
  await connectEmbedded(b, { code: "code-123456", wabaId: WABA, phoneNumberId: phone }, deps, {} as unknown as NodeJS.ProcessEnv);
  assert.equal(registered[1], registered[0]);

  // The shared dev PIN is ignored in production, so it cannot become every influencer's PIN.
  await disconnect(b);
  await connectEmbedded(b, { code: "code-123456", wabaId: WABA, phoneNumberId: phone }, deps, { NODE_ENV: "production", WHATSAPP_REGISTRATION_PIN: "654321" } as unknown as NodeJS.ProcessEnv);
  assert.match(registered[2], /^\d{6}$/);
  assert.notEqual(registered[2], "654321");
  await disconnect(b);

  // An influencer who knows their number's PIN supplies it, and it is used and kept.
  await connectEmbedded(b, { code: "code-123456", wabaId: WABA, phoneNumberId: phone, pin: "246810" }, deps, {} as unknown as NodeJS.ProcessEnv);
  assert.equal(registered[3], "246810");
  assert.equal(decryptSecret((await prisma.whatsAppConnection.findUniqueOrThrow({ where: { influencerId: b } })).registrationPinEnc!, whatsappPinAad(b)), "246810");
  await disconnect(b);
});

test("a number with a PIN of its own is refused with an error that asks for it; the PIN is checked before the code is used", { skip }, async () => {
  const phone = String(Number(PHONE) + 5);
  const mismatch = () => new WhatsAppGraphError("Two step verification PIN Mismatch", 400, 133005);
  let exchanged = 0;
  const deps = fakeDeps({
    exchangeCode: async () => (exchanged++, "business-token-from-meta-0123456789"),
    registerNumber: async (_p, _t, pin) => {
      if (pin !== "135790") throw mismatch();
    },
  });
  const env = {} as unknown as NodeJS.ProcessEnv;
  await assert.rejects(
    connectEmbedded(b, { code: "code-123456", wabaId: WABA, phoneNumberId: phone }, deps, env),
    (e: unknown) => e instanceof WhatsAppConnectError && e.field === "pin" && /already has a two-step verification PIN/.test(e.message),
  );
  assert.equal(await prisma.whatsAppConnection.count({ where: { influencerId: b } }), 0, "nothing saved");
  await assert.rejects(
    connectEmbedded(b, { code: "code-123456", wabaId: WABA, phoneNumberId: phone, pin: "000000" }, deps, env),
    (e: unknown) => e instanceof WhatsAppConnectError && e.field === "pin" && /does not match/.test(e.message),
  );
  const used = exchanged;
  await assert.rejects(connectEmbedded(b, { code: "code-123456", wabaId: WABA, phoneNumberId: phone, pin: "12ab" }, deps, env), (e: unknown) => e instanceof WhatsAppConnectError && e.field === "pin");
  assert.equal(exchanged, used, "a malformed PIN is refused before the single-use code is exchanged");

  const view = await connectEmbedded(b, { code: "code-123456", wabaId: WABA, phoneNumberId: phone, pin: "135790" }, deps, env);
  assert.equal(view.status, "ACTIVE");
  await disconnect(b);
});

test("a manual connection registers the number only when given a PIN", { skip }, async () => {
  const phone = String(Number(PHONE) + 6);
  const registered: string[] = [];
  const deps = fakeDeps({ registerNumber: async (_p, _t, pin) => void registered.push(pin) });
  const input = { wabaId: WABA, phoneNumberId: phone, accessToken: "EAAG-manual-pin-token-for-tests-1234567890" };
  await connectManual(b, input, deps);
  assert.deepEqual(registered, [], "no PIN: the number is left as it is");
  assert.equal((await prisma.whatsAppConnection.findUniqueOrThrow({ where: { influencerId: b } })).registrationPinEnc, null);
  await connectManual(b, { ...input, pin: "112233" }, deps);
  assert.deepEqual(registered, ["112233"]);
  assert.equal(decryptSecret((await prisma.whatsAppConnection.findUniqueOrThrow({ where: { influencerId: b } })).registrationPinEnc!, whatsappPinAad(b)), "112233");
  await connectManual(b, input, deps);
  assert.ok((await prisma.whatsAppConnection.findUniqueOrThrow({ where: { influencerId: b } })).registrationPinEnc, "reconnecting without a PIN keeps the stored one");
  await assert.rejects(connectManual(b, { ...input, pin: "12" }, deps), (e: unknown) => e instanceof WhatsAppConnectError && e.field === "pin");
  await disconnect(b);
});

test("connecting subscribes the app to the account's webhooks (manual too) and records the outcome, shown to the influencer", { skip }, async () => {
  const phone = String(Number(PHONE) + 7);
  const subscribed: string[] = [];
  const input = { wabaId: WABA, phoneNumberId: phone, accessToken: "EAAG-subscribe-token-for-tests-1234567890" };
  const view = await connectManual(b, input, fakeDeps({ subscribeApp: async (w) => void subscribed.push(w) }));
  assert.deepEqual(subscribed, [WABA], "manual connect subscribes too, not only Embedded Signup");
  assert.deepEqual(view.webhook, { subscribed: true, error: null });
  assert.ok(!/live updates/i.test(view.lastError ?? ""), "nothing to warn about");
  assert.ok((await prisma.whatsAppConnection.findUniqueOrThrow({ where: { influencerId: b } })).webhookSubscribedAt);

  // A failing subscription does not block connecting; it is recorded and shown, and "Check template status" retries it.
  const failing = await connectManual(b, input, fakeDeps({ subscribeApp: async () => { throw new WhatsAppGraphError("(#200) Requires whatsapp_business_management permission", 403, 200); } }));
  assert.equal(failing.status, "ACTIVE");
  assert.equal(failing.webhook.subscribed, false);
  assert.match(failing.webhook.error ?? "", /whatsapp_business_management/);
  assert.match(failing.lastError ?? "", /not sending us live updates \(.*whatsapp_business_management/);

  const retried: string[] = [];
  await refreshTemplates(b, fakeDeps({ subscribeApp: async (w) => void retried.push(w), ensureTemplates: async () => ({ templates: {}, submitted: [], failed: [] }) }));
  assert.deepEqual(retried, [WABA]);
  const healed = await getConnectionView(b);
  assert.deepEqual(healed?.webhook, { subscribed: true, error: null });
  assert.ok(!/live updates/i.test(healed?.lastError ?? ""));
  await refreshTemplates(b, fakeDeps({ subscribeApp: async () => void retried.push("again"), ensureTemplates: async () => ({ templates: {}, submitted: [], failed: [] }) }));
  assert.deepEqual(retried, [WABA], "already subscribed: not asked again");
  await disconnect(b);
});

test("connecting checks the token with Meta: a short-lived or under-permissioned token is refused before anything is saved", { skip }, async () => {
  const phone = String(Number(PHONE) + 9);
  const input = { wabaId: WABA, phoneNumberId: phone, accessToken: "EAAG-vetted-token-for-tests-1234567890" };
  const day = { valid: true, expiresAt: new Date(Date.now() + 23 * 3_600_000), scopes: [...REQUIRED_SCOPES] };
  let looked = 0;
  const watch = { getPhoneNumber: async (id: string) => (looked++, { id, displayPhone: "+91 98765 43210", verifiedName: "Sam", qualityRating: null }) };

  await assert.rejects(connectManual(b, input, fakeDeps({ ...watch, inspectToken: async () => day })), (e: unknown) => e instanceof WhatsAppConnectError && e.field === "accessToken" && /expires in 23 hour/.test(e.message));
  await assert.rejects(
    connectManual(b, input, fakeDeps({ ...watch, inspectToken: async () => ({ valid: true, expiresAt: null, scopes: ["whatsapp_business_management"] }) })),
    (e: unknown) => e instanceof WhatsAppConnectError && e.field === "accessToken" && /whatsapp_business_messaging/.test(e.message),
  );
  await assert.rejects(connectEmbedded(b, { code: "code-123456", wabaId: WABA, phoneNumberId: phone }, fakeDeps({ ...watch, inspectToken: async () => ({ valid: false, expiresAt: null, scopes: null }) })), (e: unknown) => e instanceof WhatsAppConnectError && e.field === "accessToken");
  assert.equal(looked, 0, "refused before the number was even looked up");
  assert.equal(await prisma.whatsAppConnection.count({ where: { influencerId: b } }), 0, "nothing saved");

  // Where it cannot be checked (no Meta app id/secret, or Meta did not answer) the number still connects, and the influencer is told.
  const unchecked = await connectManual(b, input, fakeDeps({ inspectToken: async () => null }));
  assert.equal(unchecked.status, "ACTIVE");
  assert.match(unchecked.notes.join(" "), /no Meta app id and secret configured/);
  const down = await connectManual(b, input, fakeDeps({ inspectToken: async () => { throw new WhatsAppGraphError("Could not reach WhatsApp", 0); } }));
  assert.match(down.notes.join(" "), /could not check this token/);

  const healthy = await connectManual(b, input, fakeDeps());
  assert.deepEqual(healthy.notes, []);
  const expiring = await connectManual(b, input, fakeDeps({ inspectToken: async () => ({ valid: true, expiresAt: new Date(Date.now() + 40 * 86_400_000), scopes: [...REQUIRED_SCOPES] }) }));
  assert.equal(expiring.notes.length, 1);
  assert.match(expiring.notes[0], /expires on/);
  await disconnect(b);
});

test("only healthy connections with unapproved templates are picked for the scheduled sync", { skip }, async () => {
  const phone = String(Number(PHONE) + 8);
  await connectManual(b, { wabaId: WABA, phoneNumberId: phone, accessToken: "EAAG-sync-token-for-tests-1234567890" }, fakeDeps());
  assert.ok((await connectionsAwaitingTemplates()).includes(b), "a template is still in review");
  const approved = Object.fromEntries(KNOWN_TEMPLATES.map((k) => [k, { status: "APPROVED", language: "en" }]));
  await prisma.whatsAppConnection.update({ where: { influencerId: b }, data: { templates: approved } });
  assert.ok(!(await connectionsAwaitingTemplates()).includes(b), "everything approved: nothing to ask Meta");
  await prisma.whatsAppConnection.update({ where: { influencerId: b }, data: { templates: { ...approved, reschedule: { status: "REJECTED", language: "en" } } } });
  assert.ok((await connectionsAwaitingTemplates()).includes(b), "a rejected template is worth a look");
  await prisma.whatsAppConnection.update({ where: { influencerId: b }, data: { status: "ERROR" } });
  assert.ok(!(await connectionsAwaitingTemplates()).includes(b), "an errored connection needs a reconnect, not a sync");
  await disconnect(b);
});

test("which credentials a message is sent with", { skip }, async () => {
  assert.equal(await resolveSendCredentials(b, { MESSAGING_DRY_RUN: "true" } as unknown as NodeJS.ProcessEnv), undefined, "dry run needs no connection");
  await assert.rejects(resolveSendCredentials(b, {} as NodeJS.ProcessEnv), WhatsAppNotConnectedError, "no connection: SMS fallback, not the platform number");
  assert.equal(
    await resolveSendCredentials(b, { WHATSAPP_PLATFORM_FALLBACK: "true", WHATSAPP_TOKEN: "t", WHATSAPP_PHONE_NUMBER_ID: "1" } as unknown as NodeJS.ProcessEnv),
    undefined,
    "the platform number is used only when explicitly allowed",
  );
  assert.ok((await resolveSendCredentials(a, {} as NodeJS.ProcessEnv))?.token, "an active connection wins");
});

test("a rejected token flags the connection once, alerts once, and falls back to SMS", { skip }, async () => {
  const alerts: string[] = [];
  const alert = (async (_id: string, x: { kind: string }) => void alerts.push(x.kind)) as unknown as typeof import("../lib/alerts").alertInfluencer;
  assert.equal(await markTokenInvalid(a, "token expired", alert), true);
  assert.equal(await markTokenInvalid(a, "token expired", alert), false, "second failure does not re-alert");
  assert.deepEqual(alerts, ["whatsapp-reconnect-needed"]);
  assert.equal((await getConnectionView(a))?.status, "ERROR");
  await assert.rejects(resolveSendCredentials(a, {} as NodeJS.ProcessEnv), WhatsAppNotConnectedError, "an errored connection is not used");
});

test("template status webhooks update the matching account", { skip }, async () => {
  await prisma.whatsAppConnection.update({ where: { influencerId: a }, data: { status: "ACTIVE" } });
  assert.equal(await applyTemplateStatusUpdate({ wabaId: WABA, name: "reschedule", language: "en", status: "APPROVED" }), true);
  assert.equal((await getConnectionView(a))?.templates.find((t) => t.name === "reschedule")?.status, "APPROVED");
  assert.equal(await applyTemplateStatusUpdate({ wabaId: WABA, name: "booking_confirmation", language: "en", status: "REJECTED", reason: "INVALID_FORMAT" }), true, "Meta's name maps to our key");
  const confirmation = (await getConnectionView(a))?.templates.find((t) => t.name === "booking-confirmation");
  assert.deepEqual([confirmation?.status, confirmation?.reason], ["REJECTED", "INVALID_FORMAT"]);
  assert.equal(await applyTemplateStatusUpdate({ wabaId: WABA, name: "not-ours", language: "en", status: "APPROVED" }), false);
  assert.equal(await applyTemplateStatusUpdate({ wabaId: WABA, name: "booking-confirmation", language: "en", status: "APPROVED" }), false, "our key is not a name Meta uses");
  assert.equal(await applyTemplateStatusUpdate({ wabaId: "000000", name: "reschedule", language: "en", status: "APPROVED" }), false);
});

test("a template status update for another language of the same name is ignored", { skip }, async () => {
  const lang = process.env.WHATSAPP_TEMPLATE_LANGUAGE || "en";
  const other = lang === "hi" ? "ta" : "hi";
  const status = async () => (await getConnectionView(a))?.templates.find((t) => t.name === "cancellation");
  await applyTemplateStatusUpdate({ wabaId: WABA, name: "cancellation", language: lang, status: "APPROVED" });
  assert.equal((await status())?.status, "APPROVED");
  // The influencer added their own cancellation template in another language and Meta rejected it: ours is unaffected.
  assert.equal(await applyTemplateStatusUpdate({ wabaId: WABA, name: "cancellation", language: other, status: "REJECTED", reason: "INVALID_FORMAT" }), false);
  assert.deepEqual([(await status())?.status, (await status())?.reason], ["APPROVED", null]);
  assert.equal(await applyTemplateStatusUpdate({ wabaId: WABA, name: "cancellation", language: lang, status: "PAUSED" }), true, "our language still updates");
  assert.equal((await status())?.status, "PAUSED");
  const stored = (await prisma.whatsAppConnection.findUniqueOrThrow({ where: { influencerId: a } })).templates as Record<string, { language?: string }>;
  assert.equal(stored.cancellation.language, lang, "the language is kept with the status");
});

test("the dashboard attention list includes a WhatsApp connection that stopped working", { skip }, async () => {
  const attention = async () => (await getOverview(a, true)).attention.filter((x) => x.kind === "whatsapp");
  await prisma.whatsAppConnection.update({ where: { influencerId: a }, data: { status: "ACTIVE", lastError: null } });
  assert.deepEqual(await attention(), [], "a healthy connection needs no attention");
  await prisma.whatsAppConnection.update({ where: { influencerId: a }, data: { status: "ERROR", lastError: "token expired" } });
  const [item] = await attention();
  assert.equal(item.title, "Reconnect WhatsApp");
  assert.match(item.detail, /token expired/);
  assert.equal(item.href, "/dashboard/settings#whatsapp");
  assert.deepEqual((await getOverview(b, true)).attention.filter((x) => x.kind === "whatsapp"), [], "another influencer's connection is not shown");
  await prisma.whatsAppConnection.update({ where: { influencerId: a }, data: { status: "ACTIVE", lastError: null } });
});

test("one Graph API version, overridable with WHATSAPP_GRAPH_VERSION, for every call", async () => {
  assert.match(DEFAULT_GRAPH_VERSION, /^v\d+\.\d+$/);
  assert.equal(graphVersion({}), DEFAULT_GRAPH_VERSION);
  assert.equal(graphVersion({ WHATSAPP_GRAPH_VERSION: " v27.0 " }), "v27.0");
  assert.equal(graphVersion({ WHATSAPP_GRAPH_VERSION: "latest" }), DEFAULT_GRAPH_VERSION, "a malformed value falls back (the env check reports it)");
  assert.equal(graphBase({ WHATSAPP_GRAPH_VERSION: "v27.0" }), "https://graph.facebook.com/v27.0");
  assert.equal(embeddedSignupConfig({ META_APP_ID: "a", META_ES_CONFIG_ID: "c", META_APP_SECRET: "s", WHATSAPP_GRAPH_VERSION: "v27.0" } as unknown as NodeJS.ProcessEnv)?.graphVersion, "v27.0", "the sign-up window gets it too");

  // The management calls and the send both go to the configured version.
  const prev = { v: process.env.WHATSAPP_GRAPH_VERSION, dry: process.env.MESSAGING_DRY_RUN, off: process.env.WHATSAPP_DISABLED };
  process.env.WHATSAPP_GRAPH_VERSION = "v27.0";
  delete process.env.MESSAGING_DRY_RUN;
  delete process.env.WHATSAPP_DISABLED;
  try {
    const urls: string[] = [];
    const fetchImpl = (async (u: string) => (urls.push(u), json(200, { id: "1", messages: [{ id: "wamid.1" }], data: [] }))) as unknown as typeof fetch;
    await getPhoneNumber("111", "tok", fetchImpl);
    await listTemplates("222", "tok", fetchImpl);
    await sendWhatsApp({ to: "+919876543210", template: "reschedule", credentials: { token: "t", phoneNumberId: "333" } }, fetchImpl);
    assert.equal(urls.length, 3);
    for (const u of urls) assert.ok(u.startsWith("https://graph.facebook.com/v27.0/"), u);
    delete process.env.WHATSAPP_GRAPH_VERSION;
    await getPhoneNumber("111", "tok", fetchImpl);
    assert.ok(urls[3].startsWith(`https://graph.facebook.com/${DEFAULT_GRAPH_VERSION}/`));
  } finally {
    for (const [name, v] of [["WHATSAPP_GRAPH_VERSION", prev.v], ["MESSAGING_DRY_RUN", prev.dry], ["WHATSAPP_DISABLED", prev.off]] as const) {
      if (v === undefined) delete process.env[name];
      else process.env[name] = v;
    }
  }
});

/** Sends `template` for a fresh booking of influencer `b` through the real wiring (credentials from the database), SMS faked. */
async function sendThroughDefaultWiring(template: string) {
  const prev = { dry: process.env.MESSAGING_DRY_RUN, fb: process.env.WHATSAPP_PLATFORM_FALLBACK };
  process.env.MESSAGING_DRY_RUN = "false";
  delete process.env.WHATSAPP_PLATFORM_FALLBACK;
  try {
    const service = await prisma.service.create({ data: { influencerId: b, title: "Call", durationMin: 30, priceMinor: 1000 } });
    const start = new Date(Date.now() + 3 * 86_400_000);
    const session = await prisma.session.create({ data: { serviceId: service.id, startTime: start, endTime: new Date(start.getTime() + 1_800_000) } });
    const booking = await prisma.booking.create({
      data: { sessionId: session.id, status: "SCHEDULED", customerName: "C", customerEmail: `c-${run}@example.com`, whatsappE164: "+919876543210", whatsappOptIn: true, meetLink: "https://meet.google.com/abc-defg-hij" },
    });
    const sms: string[] = [];
    const outcome = await sendMessageForBooking(booking.id, template, {
      sendSMS: async (i) => (sms.push(i.body), { providerMessageId: "sms-1" }),
      alert: async () => {},
    });
    return { outcome, sms, rows: await prisma.message.findMany({ where: { bookingId: booking.id } }) };
  } finally {
    if (prev.dry === undefined) delete process.env.MESSAGING_DRY_RUN;
    else process.env.MESSAGING_DRY_RUN = prev.dry;
    if (prev.fb !== undefined) process.env.WHATSAPP_PLATFORM_FALLBACK = prev.fb;
  }
}

test("without a connection a booking message goes straight to SMS, with no failed WhatsApp row (default sender wiring, no network)", { skip }, async () => {
  const { outcome, sms, rows } = await sendThroughDefaultWiring("booking-confirmation");
  assert.equal(outcome, "sent");
  assert.equal(sms.length, 1, "SMS carried the message");
  assert.equal(rows.find((r) => r.channel === "WHATSAPP"), undefined, "WhatsApp was not tried, so there is no attempt to record");
  assert.equal(rows.find((r) => r.channel === "SMS")?.status, "SENT");
});

test("a template that is not approved is not attempted over WhatsApp: straight to SMS, no failure row", { skip }, async () => {
  const phone = String(Number(PHONE) + 10);
  // booking-confirmation is in review, reschedule was rejected, the rest were approved, cancellation was never submitted.
  const templates = {
    "booking-confirmation": { status: "PENDING", language: "en" },
    "reminder-24h": { status: "APPROVED", language: "en" },
    "reminder-15m": { status: "APPROVED", language: "en" },
    reschedule: { status: "REJECTED", language: "en" },
  };
  await connectManual(b, { wabaId: WABA, phoneNumberId: phone, accessToken: "EAAG-unapproved-token-for-tests-1234567890" }, fakeDeps({ ensureTemplates: async () => ({ templates, submitted: [], failed: [] }) }));
  const env = {} as unknown as NodeJS.ProcessEnv;

  // The credentials are handed out per template.
  assert.ok((await resolveSendCredentials(b, env, "reminder-24h"))?.token, "an approved template can be sent");
  assert.ok((await resolveSendCredentials(b, env))?.token, "without naming a template the connection alone decides");
  for (const [template, status] of [["booking-confirmation", "PENDING"], ["reschedule", "REJECTED"], ["cancellation", "NOT_SUBMITTED"]] as const) {
    await assert.rejects(
      resolveSendCredentials(b, env, template),
      (e: unknown) => e instanceof WhatsAppNotConnectedError && e.message.includes(`"${template}"`) && e.message.includes(status),
      `${template} is ${status}`,
    );
  }

  const { outcome, sms, rows } = await sendThroughDefaultWiring("booking-confirmation");
  assert.equal(outcome, "sent");
  assert.equal(sms.length, 1, "customers still get the message, by SMS");
  assert.equal(rows.find((r) => r.channel === "WHATSAPP"), undefined, "no failed WhatsApp row for a message that was never attempted");
  assert.equal(rows.find((r) => r.channel === "SMS")?.status, "SENT");
  assert.equal(rows.find((r) => r.channel === "SMS")?.error, null);
  await disconnect(b);
});
