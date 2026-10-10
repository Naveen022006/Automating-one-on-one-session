import "dotenv/config";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { decryptSecret, encryptSecret } from "../lib/crypto";
import { getOverview } from "../lib/dashboard-data";
import { prisma } from "../lib/db";
import { ENCRYPTED_COLUMNS } from "../lib/key-rotation-db";
import { KNOWN_TEMPLATES, TEMPLATE_SPECS, isMetaTemplateName, isSendableStatus, metaTemplateName, normalizeTemplateStatus, templateConflict, templateKeyFromMetaName, templateParams, templateState } from "../lib/message-templates";
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
  inspectToken,
  listTemplates,
  metaAppCredentials,
  registerNumber,
  subscribeApp,
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
  whatsappLegacyPinAad,
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
  assert.equal(metaTemplateName("booking-confirmation"), "sa_booking_confirmation");
  assert.equal(metaTemplateName("reminder-24h"), "sa_reminder_24h");
  assert.equal(metaTemplateName("reminder-15m"), "sa_reminder_15m");
  assert.equal(templateKeyFromMetaName("not_ours"), null);
  assert.equal(metaTemplateName("something-else"), "something-else", "a key we do not know passes through");
  assert.throws(() => templatePayload({ ...TEMPLATE_SPECS.reschedule, name: "re-schedule" }, "en"), /not a valid WhatsApp template name/);
});

test("the submitted payload is a UTILITY template with examples", () => {
  const p = templatePayload(TEMPLATE_SPECS["booking-confirmation"], "en");
  assert.equal(p.category, "UTILITY");
  assert.equal(p.name, "sa_booking_confirmation");
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

interface FakeTemplate {
  name: string;
  language?: string;
  status: string;
  body?: string;
  reason?: string;
}

/**
 * A fake WhatsApp Business Account's message templates. The list is paged (`pageSize`) the way Graph pages it, a name
 * filter works, `hidden` templates exist but are left out of the plain list (created a moment ago, or on a page we
 * did not read), creating a template that exists answers "already exists", and names in `rejectCreate` are refused.
 */
function fakeWaba(initial: FakeTemplate[], opts: { pageSize?: number; hidden?: string[]; rejectCreate?: string[]; lookupFails?: boolean; alwaysExists?: string[] } = {}) {
  const rows = initial.map((t) => ({ language: "en", ...t }));
  const requests: string[] = [];
  const posted: string[] = [];
  const asGraph = (t: (typeof rows)[number]) => ({
    name: t.name,
    language: t.language,
    status: t.status,
    ...(t.reason ? { rejected_reason: t.reason } : {}),
    ...(t.body === undefined ? {} : { components: [{ type: "BODY", text: t.body }] }),
  });
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    requests.push(`${init?.method ?? "GET"} ${url}`);
    const u = new URL(url);
    if (init?.method === "POST") {
      const sent = JSON.parse(String(init.body)) as { name: string; language: string; components: { text: string }[] };
      posted.push(sent.name);
      if (opts.alwaysExists?.includes(sent.name) || rows.some((t) => t.name === sent.name && t.language === sent.language)) return json(400, { error: { message: "Content in this language already exists", code: 100, error_subcode: 2388024 } });
      if (opts.rejectCreate?.includes(sent.name)) return json(400, { error: { message: "Invalid parameter", code: 100 } });
      rows.push({ name: sent.name, language: sent.language, status: "PENDING", body: sent.components[0].text });
      return json(200, { id: `t_${sent.name}`, status: "PENDING" });
    }
    const byName = u.searchParams.get("name");
    if (byName) {
      if (opts.lookupFails) return json(500, { error: { message: "Meta is down", code: 2 } });
      return json(200, { data: rows.filter((t) => t.name.includes(byName)).map(asGraph) });
    }
    const visible = rows.filter((t) => !opts.hidden?.includes(t.name));
    const size = opts.pageSize ?? 100;
    const start = Number(u.searchParams.get("after") ?? 0);
    const page = visible.slice(start, start + size);
    const more = start + size < visible.length;
    return json(200, { data: page.map(asGraph), ...(more ? { paging: { cursors: { after: String(start + size) }, next: `${url}&more` } } : { paging: { cursors: { after: String(start + size) } } }) });
  }) as unknown as typeof fetch;
  return { rows, requests, posted, fetchImpl };
}

const spec = (key: string) => TEMPLATE_SPECS[key];

test("ensureTemplates submits only what is missing and survives per-template failures", async () => {
  const waba = fakeWaba(
    [
      { name: spec("booking-confirmation").name, status: "APPROVED", body: spec("booking-confirmation").body },
      { name: "other-template", status: "APPROVED", body: "Hello {{1}}" },
    ],
    { rejectCreate: [spec("reminder-15m").name] },
  );
  const r = await ensureTemplates("waba1", "tok", "en", waba.fetchImpl);
  assert.ok(waba.posted.every(isMetaTemplateName), `every submitted name is one Meta accepts: ${waba.posted.join(", ")}`);
  assert.ok(!waba.posted.includes(spec("booking-confirmation").name), "an existing template is not submitted again");
  assert.deepEqual(r.submitted.sort(), ["cancellation", "reminder-24h", "reschedule"]);
  assert.deepEqual(r.failed.map((f) => f.name), ["reminder-15m"]);
  assert.equal(r.templates["booking-confirmation"].status, "APPROVED");
  assert.equal(r.templates["reminder-24h"].status, "PENDING");
  assert.equal(r.templates["reminder-15m"], undefined, "a failed submission is not reported as present");
  assert.ok(!("other-template" in r.templates), "templates we do not own are ignored");
});

test("every page of the template list is read, so a template on a later page is not submitted again", async () => {
  const others = Array.from({ length: 7 }, (_, i) => ({ name: `their_template_${i}`, status: "APPROVED", body: "Hi {{1}}" }));
  const waba = fakeWaba([...others, { name: spec("reschedule").name, status: "APPROVED", body: spec("reschedule").body }, { name: spec("cancellation").name, status: "REJECTED", body: spec("cancellation").body, reason: "INVALID_FORMAT" }], { pageSize: 3 });
  const listed = await listTemplates("waba1", "tok", waba.fetchImpl);
  assert.equal(listed.length, 9, "all three pages");
  assert.ok(waba.requests.filter((q) => q.includes("after=")).length >= 2, "followed the cursor");

  const r = await ensureTemplates("waba1", "tok", "en", waba.fetchImpl);
  assert.ok(!waba.posted.includes(spec("reschedule").name) && !waba.posted.includes(spec("cancellation").name), "the two on the last page were found, not submitted again");
  assert.equal(r.templates.reschedule.status, "APPROVED");
  assert.deepEqual([r.templates.cancellation.status, r.templates.cancellation.reason], ["REJECTED", "INVALID_FORMAT"]);
});

test("when Meta says a template already exists, its real status is fetched by name and recorded", async () => {
  // The list we read does not show it (hidden), but creating it says it exists.
  const waba = fakeWaba([{ name: spec("cancellation").name, status: "APPROVED", body: spec("cancellation").body }], { hidden: [spec("cancellation").name] });
  const r = await ensureTemplates("waba1", "tok", "en", waba.fetchImpl);
  assert.equal(r.templates.cancellation?.status, "APPROVED", "recorded as it is, not left unknown (which would read as not sendable)");
  assert.ok(!r.submitted.includes("cancellation") && !r.failed.some((f) => f.name === "cancellation"));
  assert.ok(waba.requests.some((q) => q.startsWith("GET") && q.includes(`name=${spec("cancellation").name}`)), "asked for it by name");

  // If it cannot be found by name either, that is reported, not swallowed.
  const gone = fakeWaba([], { alwaysExists: [spec("cancellation").name] });
  const g = await ensureTemplates("waba1", "tok", "en", gone.fetchImpl);
  assert.equal(g.templates.cancellation, undefined);
  assert.ok(g.failed.some((f) => f.name === "cancellation"));
  const down = fakeWaba([{ name: spec("cancellation").name, status: "APPROVED", body: "x" }], { hidden: [spec("cancellation").name], lookupFails: true });
  assert.ok((await ensureTemplates("waba1", "tok", "en", down.fetchImpl)).failed.some((f) => f.name === "cancellation"), "a failed lookup is reported too");
});

test("our Meta names carry the sa_ prefix, so they cannot be mistaken for the influencer's own templates", () => {
  for (const key of KNOWN_TEMPLATES) {
    const name = TEMPLATE_SPECS[key].name;
    assert.ok(name.startsWith("sa_"), name);
    assert.ok(isMetaTemplateName(name), `${name} is still a name Meta accepts`);
  }
  // The plain names are no longer ours: a status for "reschedule" is about someone else's template.
  for (const plain of ["booking_confirmation", "reminder_24h", "reminder_15m", "reschedule", "cancellation"]) assert.equal(templateKeyFromMetaName(plain), null, plain);
});

test("a template already on the account under our name is adopted only if it says what ours says", () => {
  const s = spec("reschedule");
  assert.equal(templateConflict(s.body, s), null, "identical");
  assert.equal(templateConflict(`  ${s.body.replace(/ /g, "  ")}\n`, s), null, "whitespace does not matter");
  assert.match(templateConflict("Your session moved to {{1}}.", s) ?? "", /has 1 variable and our message needs 4/);
  assert.match(templateConflict(s.body + " {{5}}", s) ?? "", /has 5 variables and our message needs 4/);
  assert.match(templateConflict(s.body.replace("rescheduled", "moved"), s) ?? "", /text is different/);
  assert.match(templateConflict("Hello", s) ?? "", /has 0 variables/);
  assert.match(templateConflict(null, s) ?? "", /did not show its text/, "unreadable counts as different");
  assert.match(templateConflict(undefined, s) ?? "", /did not show its text/);
});

test("ensureTemplates does not adopt a same-named template with other text, reports it, and still adopts a real match", async () => {
  const waba = fakeWaba([
    { name: spec("reschedule").name, status: "APPROVED", body: "Your session moved to {{1}}." }, // theirs: 1 variable
    { name: spec("cancellation").name, status: "APPROVED", body: spec("cancellation").body.replace("cancelled", "called off") }, // theirs: same count, other text
    { name: spec("booking-confirmation").name, status: "PAUSED", body: spec("booking-confirmation").body }, // ours
    { name: "reschedule", status: "APPROVED", body: "A plain-named template of theirs {{1}}" }, // not even our name now
  ]);
  const r = await ensureTemplates("waba1", "tok", "en", waba.fetchImpl);

  for (const key of ["reschedule", "cancellation"]) {
    assert.equal(r.templates[key].status, "CONFLICT", `${key} is not adopted`);
    assert.match(r.templates[key].reason ?? "", new RegExp(`"${spec(key).name}" already exists on your WhatsApp account and is not ours`));
    assert.match(r.templates[key].reason ?? "", /WhatsApp Manager/);
  }
  assert.match(r.templates.reschedule.reason ?? "", /has 1 variable and our message needs 4/);
  assert.match(r.templates.cancellation.reason ?? "", /text is different/);
  assert.equal(r.templates["booking-confirmation"].status, "PAUSED", "a template that is ours is adopted with its real status");
  assert.ok(!waba.posted.includes(spec("reschedule").name) && !waba.posted.includes(spec("cancellation").name), "we do not try to create over it");
  assert.deepEqual(r.submitted.sort(), ["reminder-15m", "reminder-24h"]);
  assert.equal(templateState(Object.values(r.templates).map((t) => t.status)), "rejected", "so the card and checklist ask for attention");

  // The same check applies to one found by name after 'already exists'.
  const hidden = fakeWaba([{ name: spec("cancellation").name, status: "APPROVED", body: "Something else {{1}} {{2}} {{3}}" }], { hidden: [spec("cancellation").name] });
  assert.equal((await ensureTemplates("waba1", "tok", "en", hidden.fetchImpl)).templates.cancellation.status, "CONFLICT");

  // Their own template under the old plain name is simply not ours: ours is created beside it.
  const plain = fakeWaba([{ name: "reschedule", status: "APPROVED", body: "Their text" }]);
  const p = await ensureTemplates("waba1", "tok", "en", plain.fetchImpl);
  assert.ok(plain.posted.includes(spec("reschedule").name));
  assert.equal(p.templates.reschedule.status, "PENDING");

  // Once the clash is cleared the next sync adopts or creates ours.
  waba.rows.splice(waba.rows.findIndex((t) => t.name === spec("reschedule").name), 1);
  const again = await ensureTemplates("waba1", "tok", "en", waba.fetchImpl);
  assert.equal(again.templates.reschedule.status, "PENDING");
  assert.ok(again.submitted.includes("reschedule"));
});

test("a template that Meta flagged is still sent; a reinstated one is approved; the rule is one function", () => {
  for (const [status, sendable] of [["APPROVED", true], ["FLAGGED", true], ["PENDING", false], ["IN_APPEAL", false], ["REJECTED", false], ["PAUSED", false], ["DISABLED", false], ["DELETED", false], ["PENDING_DELETION", false], ["LIMIT_EXCEEDED", false], ["NOT_SUBMITTED", false], ["CONFLICT", false], [undefined, false]] as const) {
    assert.equal(isSendableStatus(status), sendable, String(status));
  }
  assert.equal(normalizeTemplateStatus("REINSTATED"), "APPROVED");
  assert.equal(normalizeTemplateStatus("flagged"), "FLAGGED");
  assert.equal(normalizeTemplateStatus("Paused"), "PAUSED");

  // The checklist and the card follow the same rule: all sendable is ready, flagged included.
  assert.equal(templateState(["APPROVED", "FLAGGED"]), "ready");
  assert.equal(templateState(["APPROVED", "PENDING_DELETION"]), "rejected");
  assert.equal(templateState(["APPROVED", "LIMIT_EXCEEDED"]), "rejected");
  assert.equal(templateState(["APPROVED", "CONFLICT"]), "rejected");

  // The webhook stores Meta's event as the status, with REINSTATED meaning approved again.
  const updates = parseTemplateStatusUpdates({
    entry: [{ id: "w", changes: ["REINSTATED", "FLAGGED", "PAUSED"].map((event) => ({ field: "message_template_status_update", value: { event, message_template_name: "n", message_template_language: "en" } })) }],
  });
  assert.deepEqual(updates.map((u) => u.status), ["APPROVED", "FLAGGED", "PAUSED"]);
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

const OUR_APP = "1234567890";
const appEnv = { META_APP_ID: OUR_APP, META_APP_SECRET: "app-secret" } as unknown as NodeJS.ProcessEnv;

/** A fake Graph for the subscribed_apps calls of one account: `apps` is what GET lists. */
function fakeSubscriptions(apps: unknown[] | "fail", opts: { postFails?: boolean } = {}) {
  const calls: string[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    calls.push(`${init?.method ?? "GET"} ${new URL(url).pathname.replace(/^\/v[\d.]+/, "")}`);
    if (init?.method === "POST") return opts.postFails ? json(403, { error: { message: "(#200) no permission", code: 200 } }) : json(200, { success: true });
    return apps === "fail" ? json(500, { error: { message: "Meta is down", code: 2 } }) : json(200, { data: apps });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

test("subscribing: 'subscribed' is reported only when OUR Meta app is among the subscribed apps", async () => {
  const mine = fakeSubscriptions([{ whatsapp_business_api_data: { id: OUR_APP, name: "Session Automation" } }]);
  assert.deepEqual(await subscribeApp("waba1", "tok", mine.fetchImpl, appEnv), { subscribed: true, reason: null });
  assert.deepEqual(mine.calls, ["POST /waba1/subscribed_apps", "GET /waba1/subscribed_apps"], "subscribes, then reads the list back");

  const flat = fakeSubscriptions([{ id: OUR_APP }]);
  assert.equal((await subscribeApp("waba1", "tok", flat.fetchImpl, appEnv)).subscribed, true, "either shape of the list");

  // The pasted token belongs to the influencer's own app: it is theirs that got subscribed.
  const theirs = fakeSubscriptions([{ whatsapp_business_api_data: { id: "999", name: "Their App" } }]);
  const other = await subscribeApp("waba1", "tok", theirs.fetchImpl, appEnv);
  assert.equal(other.subscribed, false);
  assert.match(other.reason ?? "", /different Meta app than ours/);

  const empty = await subscribeApp("waba1", "tok", fakeSubscriptions([]).fetchImpl, appEnv);
  assert.equal(empty.subscribed, false);

  // Without our app id there is nothing to compare with, so it cannot be called subscribed.
  const unknown = await subscribeApp("waba1", "tok", fakeSubscriptions([{ id: OUR_APP }]).fetchImpl, {} as unknown as NodeJS.ProcessEnv);
  assert.equal(unknown.subscribed, false);
  assert.match(unknown.reason ?? "", /META_APP_ID is not set/);

  // The list cannot be read back: unconfirmed, not assumed.
  const unreadable = await subscribeApp("waba1", "tok", fakeSubscriptions("fail").fetchImpl, appEnv);
  assert.equal(unreadable.subscribed, false);
  assert.match(unreadable.reason ?? "", /could not confirm/);

  // The subscribe call itself failing is an error for the caller to record.
  await assert.rejects(subscribeApp("waba1", "tok", fakeSubscriptions([], { postFails: true }).fetchImpl, appEnv), (e: unknown) => e instanceof WhatsAppGraphError && e.code === 200);
});

/** A fake debug_token: `byAuth` answers per Authorization header ("Bearer app|secret" is our app, "Bearer <token>" the token itself). */
function fakeDebug(byAuth: Record<string, () => Response>) {
  const asked: string[] = [];
  const fetchImpl = (async (_url: string, init?: RequestInit) => {
    const auth = new Headers(init?.headers).get("authorization") ?? "";
    asked.push(auth.replace("Bearer ", ""));
    const answer = byAuth[auth.replace("Bearer ", "")];
    return answer ? answer() : json(400, { error: { message: "unexpected", code: 100 } });
  }) as unknown as typeof fetch;
  return { asked, fetchImpl };
}

const APP_AUTH = `${OUR_APP}|app-secret`;
const dayToken = () => json(200, { data: { is_valid: true, app_id: "999", expires_at: Math.floor((Date.now() + 23 * 3_600_000) / 1000), scopes: [...REQUIRED_SCOPES] } });

test("inspecting a token: our app first, then the token inspecting itself when our app cannot", async () => {
  // Our app can inspect it: one question.
  const ours = fakeDebug({ [APP_AUTH]: () => json(200, { data: { is_valid: true, app_id: OUR_APP, expires_at: 0, scopes: [...REQUIRED_SCOPES] } }) });
  assert.equal((await inspectToken("TOK", appEnv, ours.fetchImpl)).valid, true);
  assert.deepEqual(ours.asked, [APP_AUTH]);

  // A token of the influencer's own app: asking as our app is refused (app mismatch), so it inspects itself, and the
  // 24-hour API Setup token is seen for what it is.
  const mismatch = fakeDebug({ [APP_AUTH]: () => json(400, { error: { message: "(#100) You must use an app access token of the app that issued this token", code: 100 } }), TOK: dayToken });
  const short = await inspectToken("TOK", appEnv, mismatch.fetchImpl);
  assert.deepEqual(mismatch.asked, [APP_AUTH, "TOK"], "retried with the token as its own access token");
  assert.equal(short.valid, true);
  const verdict = checkTokenInfo(short);
  assert.ok(!verdict.ok && /expires in 23 hour/.test(verdict.message), "the 24-hour token is refused, not waved through with a note");

  // Our app answers 200 but says not valid (it cannot see another app's token), or names another app: same retry.
  const invalid = fakeDebug({ [APP_AUTH]: () => json(200, { data: { is_valid: false, scopes: [] } }), TOK: dayToken });
  assert.equal((await inspectToken("TOK", appEnv, invalid.fetchImpl)).appId, "999");
  assert.deepEqual(invalid.asked, [APP_AUTH, "TOK"]);
  const foreign = fakeDebug({ [APP_AUTH]: () => json(200, { data: { is_valid: true, app_id: "999", expires_at: 0, scopes: [] } }), TOK: dayToken });
  await inspectToken("TOK", appEnv, foreign.fetchImpl);
  assert.deepEqual(foreign.asked, [APP_AUTH, "TOK"]);

  // No app credentials here at all: the token inspects itself.
  const noApp = fakeDebug({ TOK: dayToken });
  assert.equal((await inspectToken("TOK", {} as unknown as NodeJS.ProcessEnv, noApp.fetchImpl)).valid, true);
  assert.deepEqual(noApp.asked, ["TOK"]);

  // A token that truly is not valid says so about itself too.
  const dead = fakeDebug({ [APP_AUTH]: () => json(200, { data: { is_valid: false } }), TOK: () => json(200, { data: { is_valid: false, scopes: [] } }) });
  assert.equal((await inspectToken("TOK", appEnv, dead.fetchImpl)).valid, false);

  // Only when both fail does it throw, which the connect flow turns into a note rather than a refusal.
  const neither = fakeDebug({ [APP_AUTH]: () => json(400, { error: { message: "mismatch", code: 100 } }), TOK: () => json(400, { error: { message: "Invalid OAuth access token", code: 190 } }) });
  await assert.rejects(inspectToken("TOK", appEnv, neither.fetchImpl), WhatsAppGraphError);
  assert.deepEqual(neither.asked, [APP_AUTH, "TOK"]);
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

test("the PIN is encrypted bound to its phone number, and listed for key rotation", { skip: process.env.TOKEN_ENCRYPTION_KEY ? false : "TOKEN_ENCRYPTION_KEY not set" }, () => {
  const enc = encryptSecret("482913", whatsappPinAad("109283746501928"));
  assert.ok(!enc.includes("482913"));
  assert.equal(decryptSecret(enc, whatsappPinAad("109283746501928")), "482913", "round trip");
  assert.throws(() => decryptSecret(enc, whatsappPinAad("109283746501929")), "another number's AAD does not decrypt it");
  assert.throws(() => decryptSecret(enc, whatsappTokenAad("109283746501928")), "nor does the token's AAD");
  assert.ok(whatsappPinAad("109283746501928").includes("109283746501928"), "the AAD names the phone number");

  const col = ENCRYPTED_COLUMNS.find((c) => c.name === "whatsapp_registration_pins.pin_enc");
  assert.ok(col, "listed for key rotation");
  assert.deepEqual([col.table, col.column, col.ownerColumn, col.idColumn], ["whatsapp_registration_pins", "pin_enc", "phone_number_id", "phone_number_id"]);
  assert.equal(col.aad("109283746501928"), whatsappPinAad("109283746501928"), "rotation uses the AAD the app writes with");

  // The superseded column on the connection (bound to the influencer) is still rotated until it is gone.
  const old = ENCRYPTED_COLUMNS.find((c) => c.name === "whatsapp_connections.registration_pin_enc");
  assert.ok(old);
  assert.equal(old.aad("inf-1"), whatsappLegacyPinAad("inf-1"));
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
    subscribeApp: async () => ({ subscribed: true, reason: null }),
    registerNumber: async () => {},
    setPin: async () => {},
    inspectToken: async () => ({ valid: true, expiresAt: null, scopes: [...REQUIRED_SCOPES, "business_management"] }),
    ...over,
  };
}

const NO_ENV = {} as unknown as NodeJS.ProcessEnv;

/**
 * A fake Meta as strict about two-step PINs as the real one. A number that has a PIN refuses to register with any other
 * (133005, as Meta answers), registering sets the PIN of a number that has none, and set-PIN changes it whatever it was.
 * `initial` is the PIN each number already holds. A fake that accepts any PIN would hide a lost PIN.
 */
function strictMeta(initial: Record<string, string> = {}) {
  const onNumber = new Map(Object.entries(initial));
  const calls: string[] = [];
  const deps = {
    registerNumber: async (phone: string, _token: string, pin: string) => {
      calls.push(`register:${pin}`);
      const have = onNumber.get(phone);
      if (have !== undefined && have !== pin) throw new WhatsAppGraphError("Two step verification PIN Mismatch", 400, 133005);
      onNumber.set(phone, pin);
    },
    setPin: async (phone: string, _token: string, pin: string) => {
      calls.push(`setpin:${pin}`);
      onNumber.set(phone, pin);
    },
  };
  return { deps, onNumber, calls };
}

const pinRow = (phone: string) => prisma.whatsAppRegistrationPin.findUnique({ where: { phoneNumberId: phone } });
/** What is saved for a number, decrypted the way the app does. */
async function storedPin(phone: string) {
  const r = await pinRow(phone);
  return r ? { pin: decryptSecret(r.pinEnc, whatsappPinAad(phone)), generated: r.generated } : null;
}

before(async () => {
  if (skip) return;
  a = (await prisma.influencer.create({ data: { slug: `wa-a-${run}`, name: "Alpha", email: `wa-a-${run}@example.com` } })).id;
  b = (await prisma.influencer.create({ data: { slug: `wa-b-${run}`, name: "Beta", email: `wa-b-${run}@example.com` } })).id;
});

after(async () => {
  if (!skip) {
    await prisma.influencer.deleteMany({ where: { id: { in: [a, b].filter(Boolean) } } });
    // A saved PIN outlives the connection by design, so the test numbers' PINs are removed by hand.
    await prisma.whatsAppRegistrationPin.deleteMany({ where: { phoneNumberId: { in: Array.from({ length: 40 }, (_, i) => String(Number(PHONE) + i)) } } });
  }
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
  const deps = fakeDeps({ subscribeApp: async (w) => (calls.push(`subscribe:${w}`), { subscribed: true, reason: null }), registerNumber: async (p, _t, pin) => void calls.push(`register:${p}:${pin}`) });
  const phone = String(Number(PHONE) + 3);
  const view = await connectEmbedded(b, { code: "code-123456", wabaId: WABA, phoneNumberId: phone }, deps, { WHATSAPP_REGISTRATION_PIN: "123456" } as unknown as NodeJS.ProcessEnv);
  assert.equal(view.source, "embedded");
  assert.deepEqual(calls, [`subscribe:${WABA}`, `register:${phone}:123456`]);
  await assert.rejects(connectEmbedded(b, { code: "c", wabaId: "x", phoneNumberId: "y" }, deps), WhatsAppConnectError);
  await disconnect(b);
});

test("every Embedded Signup number gets its own random PIN, saved before it is registered and kept across a disconnect", { skip }, async () => {
  const phone = String(Number(PHONE) + 20);
  const meta = strictMeta();
  const savedWhenRegistering: boolean[] = [];
  const deps = fakeDeps({
    ...meta.deps,
    registerNumber: async (p, t, pin) => {
      savedWhenRegistering.push((await pinRow(p)) !== null);
      return meta.deps.registerNumber(p, t, pin);
    },
  });
  const connect = () => connectEmbedded(b, { code: "code-123456", wabaId: WABA, phoneNumberId: phone }, deps, NO_ENV);

  // No WHATSAPP_REGISTRATION_PIN at all: the number is still registered (it used to be skipped, so sends failed).
  const view = await connect();
  assert.equal(view.status, "ACTIVE");
  const pin = meta.onNumber.get(phone)!;
  assert.match(pin, /^\d{6}$/);
  assert.deepEqual(savedWhenRegistering, [true], "the PIN was saved before Meta was asked to register with it");
  const row = await pinRow(phone);
  assert.ok(row && !row.pinEnc.includes(pin), "stored encrypted, not in plaintext");
  assert.deepEqual(await storedPin(phone), { pin, generated: true });
  assert.throws(() => decryptSecret(row.pinEnc, whatsappPinAad(String(Number(phone) + 1))), "bound to its phone number");
  assert.equal(JSON.stringify(await getConnectionView(b)).includes(pin), false, "the PIN never leaves the server");
  assert.equal((await prisma.whatsAppConnection.findUniqueOrThrow({ where: { influencerId: b } })).registrationPinEnc, null, "no longer kept on the connection");

  // Disconnect deletes the connection, not the PIN: Meta still holds it on the number, and only we know what it is.
  await disconnect(b);
  assert.deepEqual(await storedPin(phone), { pin, generated: true });
  await connect();
  assert.deepEqual(meta.calls, [`register:${pin}`, `register:${pin}`], "reconnected with the same PIN (the strict fake refuses any other), with no reset needed");
  await disconnect(b);
});

test("the shared development PIN is used outside production only", { skip }, async () => {
  const meta = strictMeta();
  const deps = fakeDeps(meta.deps);
  const dev = String(Number(PHONE) + 21);
  const prod = String(Number(PHONE) + 22);
  await connectEmbedded(b, { code: "code-123456", wabaId: WABA, phoneNumberId: dev }, deps, { WHATSAPP_REGISTRATION_PIN: "654321" } as unknown as NodeJS.ProcessEnv);
  assert.equal(meta.onNumber.get(dev), "654321");
  await disconnect(b);
  // In production one shared PIN would become every influencer's two-step PIN, so it is ignored.
  await connectEmbedded(b, { code: "code-123456", wabaId: WABA, phoneNumberId: prod }, deps, { NODE_ENV: "production", WHATSAPP_REGISTRATION_PIN: "654321" } as unknown as NodeJS.ProcessEnv);
  assert.match(meta.onNumber.get(prod)!, /^\d{6}$/);
  assert.notEqual(meta.onNumber.get(prod), "654321");
  await disconnect(b);
});

test("a PIN the influencer typed is used as typed, kept, never overwritten, and a wrong one is explained", { skip }, async () => {
  const phone = String(Number(PHONE) + 23);
  const meta = strictMeta({ [phone]: "135790" });
  let exchanged = 0;
  const deps = fakeDeps({ ...meta.deps, exchangeCode: async () => (exchanged++, "business-token-from-meta-0123456789") });
  const connect = (pin?: string) => connectEmbedded(b, { code: "code-123456", wabaId: WABA, phoneNumberId: phone, pin }, deps, NO_ENV);

  // Wrong PIN: refused with where to find or reset it. It is not "fixed" behind their back, and nothing is saved.
  await assert.rejects(
    connect("000000"),
    (e: unknown) => e instanceof WhatsAppConnectError && e.field === "pin" && /does not match/.test(e.message) && /WhatsApp Manager/.test(e.message) && /Two-step verification/.test(e.message),
  );
  assert.ok(!meta.calls.some((c) => c.startsWith("setpin")), "a PIN the influencer typed is never overwritten");
  assert.equal(meta.onNumber.get(phone), "135790");
  assert.equal(await prisma.whatsAppConnection.count({ where: { influencerId: b } }), 0, "nothing saved");
  assert.equal(await pinRow(phone), null, "a wrong PIN is not remembered");

  // A malformed PIN is refused before the single-use sign-up code is spent.
  const used = exchanged;
  await assert.rejects(connect("12ab"), (e: unknown) => e instanceof WhatsAppConnectError && e.field === "pin");
  assert.equal(exchanged, used);

  assert.equal((await connect("135790")).status, "ACTIVE");
  assert.deepEqual(await storedPin(phone), { pin: "135790", generated: false });
  await disconnect(b);
  await connect(); // reconnecting does not ask for it again
  assert.equal(meta.calls.filter((c) => c === "register:135790").length, 2);
  assert.ok(!meta.calls.some((c) => c.startsWith("setpin")));
  await disconnect(b);
});

test("a PIN we generated that the number no longer accepts is reset with Meta's set-PIN call, then registered again", { skip }, async () => {
  const connect = (phone: string, deps: ConnectDeps) => connectEmbedded(b, { code: "code-123456", wabaId: WABA, phoneNumberId: phone }, deps, NO_ENV);

  // The number holds a PIN nobody here knows (a previous run lost track of it).
  const phone = String(Number(PHONE) + 24);
  const meta = strictMeta({ [phone]: "777777" });
  assert.equal((await connect(phone, fakeDeps(meta.deps))).status, "ACTIVE");
  const pin = (await storedPin(phone))!.pin;
  assert.deepEqual(meta.calls, [`register:${pin}`, `setpin:${pin}`, `register:${pin}`]);
  assert.equal(meta.onNumber.get(phone), pin);
  await disconnect(b);

  // Meta pausing PIN attempts (133008) is handled the same way.
  const locked = String(Number(PHONE) + 25);
  const lockedMeta = strictMeta({ [locked]: "777777" });
  let first = true;
  await connect(
    locked,
    fakeDeps({
      ...lockedMeta.deps,
      registerNumber: async (p, t, pin2) => {
        if (first) {
          first = false;
          throw new WhatsAppGraphError("Too many two-step verification PIN guesses", 400, 133008);
        }
        return lockedMeta.deps.registerNumber(p, t, pin2);
      },
    }),
  );
  assert.deepEqual(lockedMeta.calls.map((c) => c.split(":")[0]), ["setpin", "register"]);
  await disconnect(b);

  // When Meta refuses the reset too, the influencer is asked for the PIN and told where to find or change it.
  const stuck = String(Number(PHONE) + 26);
  const stuckMeta = strictMeta({ [stuck]: "777777" });
  await assert.rejects(
    connect(stuck, fakeDeps({ ...stuckMeta.deps, setPin: async () => { throw new WhatsAppGraphError("(#100) The PIN cannot be changed", 400, 100); } })),
    (e: unknown) => e instanceof WhatsAppConnectError && e.field === "pin" && /does not match the one we have/.test(e.message) && /WhatsApp Manager/.test(e.message),
  );
  assert.equal(await prisma.whatsAppConnection.count({ where: { influencerId: b } }), 0, "nothing saved");

  // A PIN the influencer typed earlier that the number has since moved on from is theirs to correct: no reset.
  const theirs = String(Number(PHONE) + 27);
  const theirsMeta = strictMeta({ [theirs]: "555555" });
  await prisma.whatsAppRegistrationPin.create({ data: { phoneNumberId: theirs, pinEnc: encryptSecret("246810", whatsappPinAad(theirs)), generated: false } });
  await assert.rejects(connect(theirs, fakeDeps(theirsMeta.deps)), (e: unknown) => e instanceof WhatsAppConnectError && e.field === "pin");
  assert.deepEqual(theirsMeta.calls, ["register:246810"], "no set-PIN call");
});

test("the PIN survives the connection failing to save after the number was registered", { skip }, async () => {
  const phone = String(Number(PHONE) + 28);
  const c = (await prisma.influencer.create({ data: { slug: `wa-c-${run}`, name: "Gamma", email: `wa-c-${run}@example.com` } })).id;
  try {
    const meta = strictMeta();
    // Another account claims the number while we talk to Meta, so the unique key on the number refuses our save.
    const racing = fakeDeps({
      ...meta.deps,
      registerNumber: async (p, t, pin) => {
        await meta.deps.registerNumber(p, t, pin);
        await prisma.whatsAppConnection.create({ data: { influencerId: c, wabaId: WABA, phoneNumberId: p, tokenEnc: "x" } });
      },
    });
    await assert.rejects(connectEmbedded(b, { code: "code-123456", wabaId: WABA, phoneNumberId: phone }, racing, NO_ENV));
    const pin = meta.onNumber.get(phone)!;
    assert.equal(await prisma.whatsAppConnection.count({ where: { influencerId: b } }), 0, "nothing saved");
    assert.deepEqual(await storedPin(phone), { pin, generated: true }, "but the PIN the number now holds is saved");

    // The clash goes away. Connecting again registers with the same PIN, not a new one that Meta would refuse.
    await prisma.whatsAppConnection.deleteMany({ where: { influencerId: c } });
    assert.equal((await connectEmbedded(b, { code: "code-123456", wabaId: WABA, phoneNumberId: phone }, fakeDeps(meta.deps), NO_ENV)).status, "ACTIVE");
    assert.deepEqual(meta.calls, [`register:${pin}`, `register:${pin}`], "same PIN, no reset");
    await disconnect(b);
  } finally {
    await prisma.influencer.delete({ where: { id: c } });
  }
});

test("a PIN kept only on the connection by the earlier version is moved to the number's own record when needed", { skip }, async () => {
  const phone = String(Number(PHONE) + 29);
  const meta = strictMeta({ [phone]: "314159" });
  await connectManual(b, { wabaId: WABA, phoneNumberId: phone, accessToken: "EAAG-legacy-pin-token-for-tests-1234567890" }, fakeDeps());
  await prisma.whatsAppConnection.update({ where: { influencerId: b }, data: { registrationPinEnc: encryptSecret("314159", whatsappLegacyPinAad(b)) } });
  assert.equal(await pinRow(phone), null);
  await connectEmbedded(b, { code: "code-123456", wabaId: WABA, phoneNumberId: phone }, fakeDeps(meta.deps), NO_ENV);
  assert.deepEqual(meta.calls, ["register:314159"], "registered with the old PIN, no reset");
  assert.deepEqual(await storedPin(phone), { pin: "314159", generated: true });
  await disconnect(b);
});

test("a manual connection registers the number only when given a PIN", { skip }, async () => {
  const phone = String(Number(PHONE) + 30);
  const meta = strictMeta();
  const deps = fakeDeps(meta.deps);
  const input = { wabaId: WABA, phoneNumberId: phone, accessToken: "EAAG-manual-pin-token-for-tests-1234567890" };
  await connectManual(b, input, deps);
  assert.deepEqual(meta.calls, [], "no PIN: the number is left as it is");
  assert.equal(await pinRow(phone), null);
  await connectManual(b, { ...input, pin: "112233" }, deps);
  assert.deepEqual(meta.calls, ["register:112233"]);
  assert.deepEqual(await storedPin(phone), { pin: "112233", generated: false });
  await connectManual(b, input, deps);
  assert.deepEqual(meta.calls, ["register:112233"], "reconnecting without a PIN leaves the number alone");
  assert.deepEqual(await storedPin(phone), { pin: "112233", generated: false });
  await assert.rejects(connectManual(b, { ...input, pin: "12" }, deps), (e: unknown) => e instanceof WhatsAppConnectError && e.field === "pin");
  await disconnect(b);
});

test("connecting subscribes to the account's webhooks (manual too) and records the outcome, shown to the influencer", { skip }, async () => {
  const phone = String(Number(PHONE) + 7);
  const subscribed: string[] = [];
  const input = { wabaId: WABA, phoneNumberId: phone, accessToken: "EAAG-subscribe-token-for-tests-1234567890" };
  const view = await connectManual(b, input, fakeDeps({ subscribeApp: async (w) => (subscribed.push(w), { subscribed: true, reason: null }) }));
  assert.deepEqual(subscribed, [WABA], "manual connect subscribes too, not only Embedded Signup");
  assert.deepEqual(view.webhook, { subscribed: true, error: null });
  assert.ok(!/live updates/i.test(view.lastError ?? ""), "nothing to warn about");
  assert.ok((await prisma.whatsAppConnection.findUniqueOrThrow({ where: { influencerId: b } })).webhookSubscribedAt);

  // A failing subscription does not block connecting; it is recorded and shown, and "Check template status" retries it.
  const failing = await connectManual(b, input, fakeDeps({ subscribeApp: async () => { throw new WhatsAppGraphError("(#200) Requires whatsapp_business_management permission", 403, 200); } }));
  assert.equal(failing.status, "ACTIVE");
  assert.equal(failing.webhook.subscribed, false);
  assert.match(failing.webhook.error ?? "", /whatsapp_business_management/);
  assert.match(failing.lastError ?? "", /Live updates from Meta are not available.*whatsapp_business_management.*every 30 minutes/);

  const retried: string[] = [];
  const ok = { subscribed: true, reason: null };
  await refreshTemplates(b, fakeDeps({ subscribeApp: async (w) => (retried.push(w), ok), ensureTemplates: async () => ({ templates: {}, submitted: [], failed: [] }) }));
  assert.deepEqual(retried, [WABA]);
  const healed = await getConnectionView(b);
  assert.deepEqual(healed?.webhook, { subscribed: true, error: null });
  assert.ok(!/live updates/i.test(healed?.lastError ?? ""));
  await refreshTemplates(b, fakeDeps({ subscribeApp: async () => (retried.push("again"), ok), ensureTemplates: async () => ({ templates: {}, submitted: [], failed: [] }) }));
  assert.deepEqual(retried, [WABA], "already subscribed: not asked again");
  await disconnect(b);
});

test("the 24-hour token of the influencer's own Meta app is refused although our app cannot inspect it", { skip }, async () => {
  const token = "EAAG-own-app-day-token-1234567890";
  const mismatch = fakeDebug({ [APP_AUTH]: () => json(400, { error: { message: "(#100) You must use an app access token of the app that issued this token", code: 100 } }), [token]: dayToken });
  await assert.rejects(
    connectManual(b, { wabaId: WABA, phoneNumberId: String(Number(PHONE) + 32), accessToken: token }, fakeDeps({ inspectToken: (t) => inspectToken(t, appEnv, mismatch.fetchImpl) })),
    (e: unknown) => e instanceof WhatsAppConnectError && e.field === "accessToken" && /expires in 23 hour/.test(e.message),
  );
  assert.deepEqual(mismatch.asked, [APP_AUTH, token]);
  assert.equal(await prisma.whatsAppConnection.count({ where: { influencerId: b } }), 0, "nothing saved");

  // Both ways of asking failing is a note on a connection that goes ahead, not a refusal.
  const neither = fakeDebug({});
  const view = await connectManual(b, { wabaId: WABA, phoneNumberId: String(Number(PHONE) + 32), accessToken: token }, fakeDeps({ inspectToken: (t) => inspectToken(t, appEnv, neither.fetchImpl) }));
  assert.match(view.notes.join(" "), /could not check this token/);
  await disconnect(b);
});

test("a token of the influencer's own Meta app subscribes THEIR app: not recorded as subscribed, with a clear note", { skip }, async () => {
  const phone = String(Number(PHONE) + 31);
  const ownApp = { subscribed: false, reason: "the access token belongs to a different Meta app than ours, so Meta's updates do not reach us" };
  const view = await connectManual(b, { wabaId: WABA, phoneNumberId: phone, accessToken: "EAAG-their-own-app-token-for-tests-1234567890" }, fakeDeps({ subscribeApp: async () => ownApp }));
  assert.equal(view.status, "ACTIVE", "the number still connects");
  assert.deepEqual(view.webhook, { subscribed: false, error: ownApp.reason });
  assert.equal((await prisma.whatsAppConnection.findUniqueOrThrow({ where: { influencerId: b } })).webhookSubscribedAt, null);
  assert.match(view.lastError ?? "", /Live updates from Meta are not available for this connection \(the access token belongs to a different Meta app/);
  assert.match(view.lastError ?? "", /every 30 minutes/, "says the periodic sync keeps statuses fresh");
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
  assert.equal(await applyTemplateStatusUpdate({ wabaId: WABA, name: "sa_reschedule", language: "en", status: "APPROVED" }), true);
  assert.equal((await getConnectionView(a))?.templates.find((t) => t.name === "reschedule")?.status, "APPROVED");
  assert.equal(await applyTemplateStatusUpdate({ wabaId: WABA, name: "sa_booking_confirmation", language: "en", status: "REJECTED", reason: "INVALID_FORMAT" }), true, "Meta's name maps to our key");
  const confirmation = (await getConnectionView(a))?.templates.find((t) => t.name === "booking-confirmation");
  assert.deepEqual([confirmation?.status, confirmation?.reason], ["REJECTED", "INVALID_FORMAT"]);
  assert.equal(await applyTemplateStatusUpdate({ wabaId: WABA, name: "not-ours", language: "en", status: "APPROVED" }), false);
  assert.equal(await applyTemplateStatusUpdate({ wabaId: WABA, name: "booking-confirmation", language: "en", status: "APPROVED" }), false, "our key is not a name Meta uses");
  assert.equal(await applyTemplateStatusUpdate({ wabaId: "000000", name: "sa_reschedule", language: "en", status: "APPROVED" }), false);
});

test("a template status update for another language of the same name is ignored", { skip }, async () => {
  const lang = process.env.WHATSAPP_TEMPLATE_LANGUAGE || "en";
  const other = lang === "hi" ? "ta" : "hi";
  const waba = String(Number(WABA) + 1); // its own account, so the other tests' connections are not touched
  await connectManual(b, { wabaId: waba, phoneNumberId: String(Number(PHONE) + 11), accessToken: "EAAG-language-token-for-tests-1234567890" }, fakeDeps());
  const status = async () => (await getConnectionView(b))?.templates.find((t) => t.name === "cancellation");
  await applyTemplateStatusUpdate({ wabaId: waba, name: "sa_cancellation", language: lang, status: "APPROVED" });
  assert.equal((await status())?.status, "APPROVED");
  // The influencer added their own cancellation template in another language and Meta rejected it: ours is unaffected.
  assert.equal(await applyTemplateStatusUpdate({ wabaId: waba, name: "sa_cancellation", language: other, status: "REJECTED", reason: "INVALID_FORMAT" }), false);
  assert.deepEqual([(await status())?.status, (await status())?.reason], ["APPROVED", null]);
  assert.equal(await applyTemplateStatusUpdate({ wabaId: waba, name: "sa_cancellation", language: lang, status: "PAUSED" }), true, "our language still updates");
  assert.equal((await status())?.status, "PAUSED");
  const stored = (await prisma.whatsAppConnection.findUniqueOrThrow({ where: { influencerId: b } })).templates as Record<string, { language?: string }>;
  assert.equal(stored.cancellation.language, lang, "the language is kept with the status");
  await disconnect(b);
});

test("the dashboard attention list includes a WhatsApp connection that stopped working", { skip }, async () => {
  const attention = async (id: string) => (await getOverview(id, true)).attention.filter((x) => x.kind === "whatsapp");
  await connectManual(b, { wabaId: WABA, phoneNumberId: String(Number(PHONE) + 12), accessToken: "EAAG-attention-token-for-tests-1234567890" }, fakeDeps());
  assert.deepEqual(await attention(b), [], "a healthy connection needs no attention");
  await prisma.whatsAppConnection.update({ where: { influencerId: b }, data: { status: "ERROR", lastError: "token expired" } });
  const [item] = await attention(b);
  assert.equal(item.title, "Reconnect WhatsApp");
  assert.match(item.detail, /token expired/);
  assert.equal(item.href, "/dashboard/settings#whatsapp");
  assert.ok(!(await attention(a)).some((x) => /token expired/.test(x.detail)), "another influencer's connection is not shown");
  await disconnect(b);
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
    "reminder-15m": { status: "FLAGGED", language: "en" }, // low quality, but Meta still delivers it
    reschedule: { status: "REJECTED", language: "en" },
  };
  await connectManual(b, { wabaId: WABA, phoneNumberId: phone, accessToken: "EAAG-unapproved-token-for-tests-1234567890" }, fakeDeps({ ensureTemplates: async () => ({ templates, submitted: [], failed: [] }) }));
  const env = {} as unknown as NodeJS.ProcessEnv;

  // The credentials are handed out per template.
  assert.ok((await resolveSendCredentials(b, env, "reminder-24h"))?.token, "an approved template can be sent");
  assert.ok((await resolveSendCredentials(b, env, "reminder-15m"))?.token, "a flagged template is still sent");
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
