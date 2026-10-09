import "dotenv/config";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { prisma } from "../lib/db";
import { KNOWN_TEMPLATES, TEMPLATE_SPECS, templateParams } from "../lib/message-templates";
import { sendMessageForBooking } from "../lib/messaging";
import { parseTemplateStatusUpdates } from "../lib/whatsapp-webhook";
import {
  WhatsAppGraphError,
  embeddedSignupConfig,
  ensureTemplates,
  exchangeEmbeddedCode,
  getPhoneNumber,
  templatePayload,
  wabaOwnsNumber,
} from "../lib/whatsapp-connect";
import {
  WhatsAppConnectError,
  WhatsAppNotConnectedError,
  applyTemplateStatusUpdate,
  connectEmbedded,
  connectManual,
  disconnect,
  getConnectionView,
  markTokenInvalid,
  resolveSendCredentials,
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

test("the submitted payload is a UTILITY template with examples", () => {
  const p = templatePayload("booking-confirmation", TEMPLATE_SPECS["booking-confirmation"], "en");
  assert.equal(p.category, "UTILITY");
  assert.equal(p.name, "booking-confirmation");
  assert.equal(p.components[0].type, "BODY");
  assert.equal(p.components[0].example.body_text[0].length, 4);
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
      if (name === "reminder-15m") return json(400, { error: { message: "Invalid parameter", code: 100 } });
      if (name === "cancellation") return json(400, { error: { message: "Content in this language already exists", code: 100, error_subcode: 2388024 } });
      return json(200, { id: `t_${name}`, status: "PENDING" });
    }
    return json(200, { data: [{ name: "booking-confirmation", language: "en", status: "APPROVED" }, { name: "other-template", language: "en", status: "APPROVED" }] });
  }) as unknown as typeof fetch;

  const r = await ensureTemplates("waba1", "tok", "en", fetchImpl);
  assert.ok(!posted.includes("booking-confirmation"), "an existing template is not submitted again");
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
  assert.deepEqual(embeddedSignupConfig(env), { appId: "app", configId: "cfg" });
  assert.equal(embeddedSignupConfig({ META_APP_ID: "app" } as unknown as NodeJS.ProcessEnv), null);
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
  assert.equal(await applyTemplateStatusUpdate({ wabaId: WABA, name: "not-ours", language: "en", status: "APPROVED" }), false);
  assert.equal(await applyTemplateStatusUpdate({ wabaId: "000000", name: "reschedule", language: "en", status: "APPROVED" }), false);
});

test("without a connection a booking message goes to SMS (default sender wiring, no network)", { skip }, async () => {
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
    const outcome = await sendMessageForBooking(booking.id, "booking-confirmation", {
      sendSMS: async (i) => (sms.push(i.body), { providerMessageId: "sms-1" }),
      alert: async () => {},
    });
    assert.equal(outcome, "sent");
    assert.equal(sms.length, 1, "SMS carried the message");
    const rows = await prisma.message.findMany({ where: { bookingId: booking.id } });
    assert.equal(rows.find((r) => r.channel === "WHATSAPP")?.status, "PENDING", "the WhatsApp attempt is recorded");
    assert.match(rows.find((r) => r.channel === "WHATSAPP")?.error ?? "", /not connected/i);
    assert.equal(rows.find((r) => r.channel === "SMS")?.status, "SENT");
  } finally {
    if (prev.dry === undefined) delete process.env.MESSAGING_DRY_RUN;
    else process.env.MESSAGING_DRY_RUN = prev.dry;
    if (prev.fb !== undefined) process.env.WHATSAPP_PLATFORM_FALLBACK = prev.fb;
  }
});
