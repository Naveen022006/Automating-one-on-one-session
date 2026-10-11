import { META_APP_ID, META_APP_SECRET, OWN_APP_ID, OWN_APP_NAME, PLATFORM_APP_NAME, SCOPE_MANAGEMENT, SCOPE_MESSAGING } from "./fixtures";
import { faultValue, takeFault } from "./faults";
import { HttpError, addControl, randomHex, type Ctx, type Router, type Runtime } from "./http";
import type { MockMetaToken, MockPhone, MockTemplate, MockWaba, MockWhatsAppMessage } from "./state";

/**
 * Mock of the Meta Graph API calls the app makes for WhatsApp (doc/11-provider-simulator.md, 3.4): phone and account reads, message
 * templates with a review timer, token inspection, the Embedded Signup code exchange, webhook subscription, the two-step PIN and
 * number registration, and template message sends with a delivery-status timeline. Response shapes follow what lib/whatsapp.ts
 * and lib/whatsapp-connect.ts read. Reference: https://developers.facebook.com/docs/whatsapp/cloud-api/reference
 * Error codes other than 190, 10, 133005 and 133008 are approximations (see "What this does not prove" on the control page).
 */

const V = String.raw`/meta/v\d+\.\d+`;
const re = (tail: string) => new RegExp(`^${V}${tail}$`);
const TEMPLATE_PAGE_MAX = 100;
const ES_CODE_TTL_MS = 10 * 60_000;
const PIN_LOCK_AFTER = 5;
const PIN_LOCK_MS = 5 * 60_000;

/* ---------- Graph errors ---------- */

interface GraphErrorOptions {
  subcode?: number;
  title?: string;
  userMessage?: string;
}

function graphError(status: number, code: number, message: string, o: GraphErrorOptions = {}): HttpError {
  return new HttpError(status, {
    error: {
      message,
      type: "OAuthException",
      code,
      ...(o.subcode ? { error_subcode: o.subcode } : {}),
      ...(o.title ? { error_user_title: o.title } : {}),
      ...(o.userMessage ? { error_user_msg: o.userMessage } : {}),
      fbtrace_id: `MOCK${randomHex(6)}`,
    },
  });
}

const badToken = () => graphError(400, 190, "Invalid OAuth access token - Cannot parse access token");
const noAccess = (id: string) =>
  graphError(400, 100, `Unsupported get request. Object with ID '${id}' does not exist, cannot be loaded due to missing permissions, or does not support this operation`, { subcode: 33 });
const noPermission = () => graphError(403, 10, "(#10) Application does not have permission for this action");
const invalidParameter = (message: string, userMessage?: string) => graphError(400, 100, `(#100) ${message}`, userMessage ? { userMessage } : {});

function appName(appId: string): string {
  return appId === META_APP_ID ? PLATFORM_APP_NAME : appId === OWN_APP_ID ? OWN_APP_NAME : "Mock App";
}

/* ---------- tokens ---------- */

export const PLATFORM_APP_TOKEN = `${META_APP_ID}|${META_APP_SECRET}`;

type TokenProblem = "unknown" | "revoked" | "expired";

function tokenProblem(rt: Runtime, rec: MockMetaToken | undefined): TokenProblem | null {
  if (!rec) return "unknown";
  if (rec.revokedAt) return "revoked";
  if (rec.expiresAt !== null && rec.expiresAt * 1000 <= rt.now()) return "expired";
  return null;
}

function tokenError(problem: TokenProblem): HttpError {
  if (problem === "revoked") {
    return graphError(400, 190, "Error validating access token: The session has been invalidated because the user changed their password or Facebook has changed the session for security reasons.", { subcode: 460 });
  }
  if (problem === "expired") return graphError(400, 190, "Error validating access token: Session has expired.", { subcode: 463 });
  return badToken();
}

/** The business token of the request: must be one the mock minted, live. */
function requireToken(c: Ctx): { token: string; rec: MockMetaToken } {
  const token = c.bearer();
  if (!token) throw graphError(400, 104, "An access token is required to request this resource.");
  const rec = c.rt.state.meta.tokens[token];
  const problem = tokenProblem(c.rt, rec);
  if (problem) throw tokenError(problem);
  return { token, rec };
}

function requireScope(rec: MockMetaToken, ...anyOf: string[]): void {
  if (!anyOf.some((s) => rec.scopes.includes(s))) throw noPermission();
}

function wabaFor(c: Ctx, rec: MockMetaToken, id: string): MockWaba {
  const waba = c.rt.state.meta.wabas[id];
  if (!waba || !rec.wabaIds.includes(id)) throw noAccess(id);
  return waba;
}

function phoneFor(c: Ctx, rec: MockMetaToken, id: string): MockPhone {
  const phone = c.rt.state.meta.phones[id];
  if (!phone || !rec.wabaIds.includes(phone.wabaId)) throw noAccess(id);
  return phone;
}

export function mintToken(rt: Runtime, o: { appId: string; scopes: string[]; wabaIds: string[]; expiresInDays: number; label: string }): string {
  const token = `MOCK-NOT-REAL-meta-${randomHex(12)}`;
  rt.state.meta.tokens[token] = {
    appId: o.appId,
    type: "SYSTEM_USER",
    scopes: o.scopes,
    wabaIds: o.wabaIds,
    expiresAt: o.expiresInDays > 0 ? Math.floor(rt.now() / 1000) + o.expiresInDays * 86_400 : null,
    revokedAt: null,
    label: o.label,
  };
  rt.save();
  return token;
}

/* ---------- reads ---------- */

function phoneJson(phone: MockPhone, fields?: string[]): Record<string, unknown> {
  const all: Record<string, unknown> = { id: phone.id, display_phone_number: phone.display, verified_name: phone.verifiedName, quality_rating: phone.quality };
  if (!fields || fields.length === 0) return all;
  return Object.fromEntries(Object.entries(all).filter(([k]) => k === "id" || fields.includes(k)));
}

const fieldsOf = (c: Ctx) => (c.query.get("fields") ?? "").split(",").map((s) => s.trim()).filter(Boolean);

function getPhone(c: Ctx): void {
  const { rec } = requireToken(c);
  requireScope(rec, SCOPE_MANAGEMENT, SCOPE_MESSAGING);
  c.sendJson(200, phoneJson(phoneFor(c, rec, c.params.id), fieldsOf(c)));
}

function getPhoneNumbers(c: Ctx): void {
  const { rec } = requireToken(c);
  requireScope(rec, SCOPE_MANAGEMENT, SCOPE_MESSAGING);
  const waba = wabaFor(c, rec, c.params.id);
  c.sendJson(200, { data: waba.phoneIds.map((id) => phoneJson(c.rt.state.meta.phones[id], fieldsOf(c))) });
}

function inspectData(rt: Runtime, rec: MockMetaToken | undefined, appId: string) {
  const problem = tokenProblem(rt, rec);
  if (problem || !rec) {
    const error = problem === "revoked" ? { code: 190, message: "Error validating access token: The session has been invalidated.", subcode: 460 } : problem === "expired" ? { code: 190, message: "Error validating access token: Session has expired.", subcode: 463 } : { code: 190, message: "Invalid OAuth access token - Cannot parse access token" };
    return { data: { app_id: appId, is_valid: false, error, scopes: [] } };
  }
  return {
    data: {
      app_id: rec.appId,
      type: rec.type,
      application: appName(rec.appId),
      data_access_expires_at: 0,
      expires_at: rec.expiresAt ?? 0,
      is_valid: true,
      scopes: rec.scopes,
      granular_scopes: rec.scopes.map((scope) => ({ scope, target_ids: rec.wabaIds })),
    },
  };
}

/**
 * debug_token. Authorised by our app token (app id|secret) or by a token that inspects ITSELF (what lib/whatsapp-connect.ts falls
 * back to for a token issued to the influencer's own Meta app, which our app is not allowed to inspect: the app-mismatch error).
 */
function debugToken(c: Ctx): void {
  const rt = c.rt;
  const viewer = c.bearer();
  if (!viewer) throw graphError(400, 104, "An access token is required to request this resource.");
  const input = c.query.get("input_token") ?? "";
  const subject = rt.state.meta.tokens[input];
  if (viewer === PLATFORM_APP_TOKEN) {
    if (subject && subject.appId !== META_APP_ID) throw invalidParameter("The App_id in the input_token did not match the Viewing App");
    return c.sendJson(200, inspectData(rt, subject, META_APP_ID));
  }
  const viewerRec = rt.state.meta.tokens[viewer];
  const problem = tokenProblem(rt, viewerRec);
  if (problem) throw tokenError(problem);
  if (subject && subject.appId !== viewerRec.appId) throw invalidParameter("The App_id in the input_token did not match the Viewing App");
  c.sendJson(200, inspectData(rt, subject, viewerRec.appId));
}

function exchangeEsCode(c: Ctx): void {
  const rt = c.rt;
  if (c.query.get("client_id") !== META_APP_ID) throw graphError(400, 101, "Error validating application. Invalid application ID.");
  if (c.query.get("client_secret") !== META_APP_SECRET) throw graphError(400, 1, "Error validating client secret.");
  const rec = rt.state.meta.esCodes[c.query.get("code") ?? ""];
  if (!rec) throw invalidParameter("Invalid verification code format.");
  if (rec.used) throw invalidParameter("This authorization code has been used.");
  if (rec.expiresAt <= rt.now()) throw invalidParameter("This authorization code has expired.");
  rec.used = true;
  const token = mintToken(rt, { appId: rec.appId, scopes: [SCOPE_MANAGEMENT, SCOPE_MESSAGING], wabaIds: [rec.wabaId], expiresInDays: 0, label: `Embedded Signup token for account ${rec.wabaId}` });
  rt.activity(`Meta: the app exchanged the Embedded Signup code for a business token (account ${rec.wabaId})`, "/__mock/meta");
  c.sendJson(200, { access_token: token, token_type: "bearer" });
}

/* ---------- subscriptions, PIN, registration ---------- */

function listSubscribedApps(c: Ctx): void {
  const { rec } = requireToken(c);
  requireScope(rec, SCOPE_MANAGEMENT);
  const waba = wabaFor(c, rec, c.params.id);
  c.sendJson(200, { data: waba.subscribedApps.map((id) => ({ whatsapp_business_api_data: { id, name: appName(id), link: `https://www.facebook.com/games/?app_id=${id}` } })) });
}

/** Subscribes the app that issued the token (its OWN app id), which is why a pasted token of another app subscribes the wrong one. */
function subscribeApp(c: Ctx): void {
  const { rec } = requireToken(c);
  requireScope(rec, SCOPE_MANAGEMENT);
  const waba = wabaFor(c, rec, c.params.id);
  if (!waba.subscribedApps.includes(rec.appId)) waba.subscribedApps.push(rec.appId);
  c.rt.save();
  c.rt.activity(`Meta: ${appName(rec.appId)} subscribed to the webhooks of account ${waba.id}${rec.appId === META_APP_ID ? "" : " (not the platform app, so nothing will reach the app)"}`, "/__mock/meta");
  c.sendJson(200, { success: true });
}

const PIN = /^\d{6}$/;
const locked = (rt: Runtime, p: MockPhone) => p.lockedUntil !== null && Date.parse(p.lockedUntil) > rt.now();
const pinLockedError = () => graphError(400, 133008, "Too many two step verification PIN guesses for this phone number", { userMessage: "Too many two step verification PIN guesses for this phone number. Try again later." });

async function setPin(c: Ctx): Promise<void> {
  const { rec } = requireToken(c);
  requireScope(rec, SCOPE_MANAGEMENT);
  const phone = phoneFor(c, rec, c.params.id);
  const body = await c.readJson<{ pin?: unknown }>();
  if (locked(c.rt, phone)) throw pinLockedError();
  if (typeof body.pin !== "string" || !PIN.test(body.pin)) throw invalidParameter("Parameter pin must be a 6-digit string", "The PIN must be 6 digits.");
  phone.pin = body.pin;
  phone.wrongAttempts = 0;
  phone.lockedUntil = null;
  c.rt.save();
  c.rt.activity(`Meta: the two-step PIN of ${phone.display} was set`, "/__mock/meta");
  c.sendJson(200, { success: true });
}

async function registerNumber(c: Ctx): Promise<void> {
  const rt = c.rt;
  const { rec } = requireToken(c);
  requireScope(rec, SCOPE_MANAGEMENT);
  const phone = phoneFor(c, rec, c.params.id);
  const body = await c.readJson<{ pin?: unknown; messaging_product?: unknown }>();
  if (body.messaging_product !== "whatsapp") throw invalidParameter("Param messaging_product is required");
  if (typeof body.pin !== "string" || !PIN.test(body.pin)) throw invalidParameter("Parameter pin must be a 6-digit string", "The PIN must be 6 digits.");
  if (locked(rt, phone)) throw pinLockedError();
  if (phone.pin === null || phone.pin === body.pin) {
    phone.pin = body.pin;
    phone.registered = true;
    phone.wrongAttempts = 0;
    rt.save();
    rt.activity(`Meta: ${phone.display} registered for the Cloud API`, "/__mock/meta");
    return c.sendJson(200, { success: true });
  }
  phone.wrongAttempts++;
  if (phone.wrongAttempts >= PIN_LOCK_AFTER) phone.lockedUntil = new Date(rt.now() + PIN_LOCK_MS).toISOString();
  rt.save();
  rt.activity(`Meta: registering ${phone.display} failed, the PIN does not match (attempt ${phone.wrongAttempts})`, "/__mock/meta");
  throw graphError(400, 133005, "Two step verification PIN Mismatch", { userMessage: "The two step verification PIN you entered does not match the one set on this phone number." });
}

/* ---------- templates ---------- */

const VARIABLE = /\{\{\s*(\d+)\s*\}\}/g;
const variableCount = (text: string) => new Set([...text.matchAll(VARIABLE)].map((m) => m[1])).size;

function templateJson(t: MockTemplate): Record<string, unknown> {
  return {
    id: t.id,
    name: t.name,
    language: t.language,
    status: t.status,
    category: t.category,
    rejected_reason: t.rejectedReason ?? "NONE",
    components: [{ type: "BODY", text: t.body }],
  };
}

function listTemplates(c: Ctx): void {
  const { rec } = requireToken(c);
  requireScope(rec, SCOPE_MANAGEMENT);
  const waba = wabaFor(c, rec, c.params.id);
  const name = c.query.get("name");
  const all = Object.values(waba.templates).filter((t) => !name || t.name === name);
  const limit = Math.min(Math.max(Number(c.query.get("limit")) || 25, 1), TEMPLATE_PAGE_MAX);
  const after = c.query.get("after");
  const offset = after ? Number.parseInt(Buffer.from(after, "base64url").toString("utf8"), 10) : 0;
  if (!Number.isInteger(offset) || offset < 0) throw invalidParameter("Invalid cursor");
  const page = all.slice(offset, offset + limit);
  const cursor = (n: number) => Buffer.from(String(n), "utf8").toString("base64url");
  const more = offset + limit < all.length;
  const nextQuery = new URLSearchParams(c.url.searchParams);
  nextQuery.set("after", cursor(offset + limit));
  c.sendJson(200, {
    data: page.map(templateJson),
    paging: { cursors: { before: cursor(offset), after: cursor(offset + page.length) }, ...(more ? { next: `${c.rt.origin}${c.path}?${nextQuery}` } : {}) },
  });
}

interface TemplateBody {
  name?: unknown;
  language?: unknown;
  category?: unknown;
  components?: { type?: unknown; text?: unknown; example?: { body_text?: unknown } }[];
}

async function createTemplate(c: Ctx): Promise<void> {
  const rt = c.rt;
  const { rec } = requireToken(c);
  requireScope(rec, SCOPE_MANAGEMENT);
  const waba = wabaFor(c, rec, c.params.id);
  const injected = takeFault(rt, "meta.templates", c);
  if (injected === "10") throw noPermission();
  if (injected === "500") throw graphError(500, 2, "An unexpected error has occurred. Please retry your request later.");

  const body = await c.readJson<TemplateBody>();
  const name = typeof body.name === "string" ? body.name : "";
  if (!/^[a-z0-9_]{1,512}$/.test(name)) {
    throw invalidParameter("Invalid parameter", "Template name can only contain lowercase letters, numbers and underscores");
  }
  const language = typeof body.language === "string" ? body.language : "";
  if (!language) throw invalidParameter("Param language is required");
  const bodyComponent = (body.components ?? []).find((x) => String(x.type).toUpperCase() === "BODY");
  const text = typeof bodyComponent?.text === "string" ? bodyComponent.text : "";
  if (!text) throw invalidParameter("Param components[0][text] is required", "The template needs a body.");
  const trimmed = text.trim();
  if (/^\{\{\s*\d+\s*\}\}/.test(trimmed) || /\{\{\s*\d+\s*\}\}$/.test(trimmed)) {
    throw invalidParameter("Invalid parameter", "This template body starts or ends with a variable. Add some text before the first variable and after the last one.");
  }
  const variables = variableCount(text);
  const examples = Array.isArray(bodyComponent?.example?.body_text) && Array.isArray((bodyComponent!.example!.body_text as unknown[])[0]) ? ((bodyComponent!.example!.body_text as unknown[][])[0] as unknown[]).map(String) : [];
  if (examples.length !== variables) {
    throw invalidParameter("Invalid parameter", `The number of examples (${examples.length}) does not match the number of variables in the body (${variables}).`);
  }
  if (Object.values(waba.templates).some((t) => t.name === name && t.language === language)) {
    throw graphError(400, 100, "Invalid parameter", {
      subcode: 2388024,
      title: "Content in this language already exists",
      userMessage: "There is already English content for this template. You can create a new template and try again.",
    });
  }

  const id = `9900000${String(Math.floor(Math.random() * 1e8)).padStart(8, "0")}`;
  const template: MockTemplate = {
    id,
    name,
    language,
    category: typeof body.category === "string" ? body.category : "UTILITY",
    status: "PENDING",
    rejectedReason: null,
    body: text,
    examples,
    createdAt: new Date(rt.now()).toISOString(),
    decideAt: null,
  };
  waba.templates[id] = template;
  planReview(rt, waba, template);
  rt.save();
  rt.activity(`Meta: template ${name} (${language}) submitted for account ${waba.id}, in review`, "/__mock/meta");
  c.sendJson(200, { id, status: "PENDING", category: template.category });
}

/** The review timer (meta.review): approve or reject after N seconds, or wait for the control page. */
function planReview(rt: Runtime, waba: MockWaba, t: MockTemplate): void {
  const mode = faultValue(rt, "meta.review");
  if (mode === "manual") return;
  const reject = /^reject:([A-Za-z_]+)(?::(\d+))?$/.exec(mode);
  const auto = /^auto:(\d+)$/.exec(mode);
  const seconds = reject ? Number(reject[2] ?? 15) : Number(auto?.[1] ?? 15);
  t.planned = reject ? { status: "REJECTED", reason: reject[1].toUpperCase() } : { status: "APPROVED", reason: null };
  t.decideAt = new Date(rt.now() + seconds * 1000).toISOString();
  armReview(rt, waba.id, t.id);
}

function armReview(rt: Runtime, wabaId: string, templateId: string): void {
  const t = rt.state.meta.wabas[wabaId]?.templates[templateId];
  if (!t?.decideAt || !t.planned) return;
  const plan = t.planned;
  rt.later(Math.max(0, Date.parse(t.decideAt) - rt.now()), () => {
    const live = rt.state.meta.wabas[wabaId]?.templates[templateId];
    if (live && live.status === "PENDING" && live.decideAt) decide(rt, wabaId, templateId, plan.status, plan.reason);
  });
}

/** After a restart: the review timers that were running go on. */
export function resumeReviews(rt: Runtime): void {
  for (const waba of Object.values(rt.state.meta.wabas)) for (const t of Object.values(waba.templates)) if (t.decideAt) armReview(rt, waba.id, t.id);
}

const TEMPLATE_EVENTS: Record<MockTemplate["status"] | "REINSTATED", string> = { PENDING: "PENDING", APPROVED: "APPROVED", REJECTED: "REJECTED", PAUSED: "PAUSED", DISABLED: "DISABLED", FLAGGED: "FLAGGED", REINSTATED: "REINSTATED" };

/** Changes a template's status and tells the app by webhook, like Meta does (message_template_status_update). */
export function decide(rt: Runtime, wabaId: string, templateId: string, status: MockTemplate["status"] | "REINSTATED", reason: string | null): void {
  const waba = rt.state.meta.wabas[wabaId];
  const t = waba?.templates[templateId];
  if (!waba || !t) return;
  t.status = status === "REINSTATED" ? "APPROVED" : status;
  t.rejectedReason = status === "REJECTED" ? (reason ?? "INVALID_FORMAT") : null;
  t.decideAt = null;
  delete t.planned;
  rt.save();
  rt.activity(`Meta: template ${t.name} is now ${status}${t.rejectedReason ? ` (${t.rejectedReason})` : ""}`, "/__mock/meta");
  rt.webhooks.deliver({
    wabaId,
    kind: `template ${TEMPLATE_EVENTS[status]}`,
    payload: {
      object: "whatsapp_business_account",
      entry: [
        {
          id: wabaId,
          time: Math.floor(rt.now() / 1000),
          changes: [
            {
              field: "message_template_status_update",
              value: { event: TEMPLATE_EVENTS[status], message_template_id: Number(t.id), message_template_name: t.name, message_template_language: t.language, reason: t.rejectedReason ?? "NONE" },
            },
          ],
        },
      ],
    },
  });
}

/* ---------- sending ---------- */

interface SendBody {
  messaging_product?: unknown;
  to?: unknown;
  type?: unknown;
  template?: { name?: unknown; language?: { code?: unknown }; components?: { type?: unknown; parameters?: { type?: unknown; text?: unknown }[] }[] };
}

function renderBody(body: string, params: string[]): string {
  return body.replace(VARIABLE, (_m, n: string) => params[Number(n) - 1] ?? "");
}

async function sendMessage(c: Ctx): Promise<void> {
  const rt = c.rt;
  const injected = takeFault(rt, "meta.send", c);
  if (injected === "190") throw tokenError("revoked");
  if (injected === "10") throw noPermission();
  if (injected === "500") throw graphError(500, 2, "An unexpected error has occurred. Please retry your request later.");
  if (injected === "132001") throw graphError(404, 132001, "Template name does not exist in the translation", { title: "Template name does not exist in the translation", userMessage: "template name does not exist in the translation" });

  const { rec } = requireToken(c);
  requireScope(rec, SCOPE_MESSAGING);
  const phone = phoneFor(c, rec, c.params.id);
  const body = await c.readJson<SendBody>();
  if (body.messaging_product !== "whatsapp" || body.type !== "template" || typeof body.template?.name !== "string") {
    throw invalidParameter("The request must be a template message (messaging_product, type and template are required)");
  }
  if (!phone.registered) throw graphError(400, 133010, "Phone number not registered", { title: "Account not registered", userMessage: "Account not registered" });
  const to = typeof body.to === "string" ? body.to : "";
  if (!/^\+?\d{8,15}$/.test(to)) throw invalidParameter("Invalid parameter", `The recipient phone number "${to.slice(0, 20)}" is not valid.`);

  const waba = rt.state.meta.wabas[phone.wabaId];
  const code = typeof body.template.language?.code === "string" ? body.template.language.code : "";
  const template = Object.values(waba.templates).find((t) => t.name === body.template!.name && t.language === code);
  if (!template) {
    throw graphError(404, 132001, "Template name does not exist in the translation", { title: "Template name does not exist in the translation", userMessage: `template name (${String(body.template.name)}) does not exist in ${code || "the requested language"}` });
  }
  if (template.status === "PAUSED") throw graphError(400, 132015, "Template is paused", { title: "Template is paused", userMessage: "This template is paused due to low quality." });
  if (template.status === "DISABLED") throw graphError(400, 132016, "Template is permanently disabled", { title: "Template is disabled", userMessage: "This template was disabled." });
  if (template.status !== "APPROVED" && template.status !== "FLAGGED") {
    throw graphError(404, 132001, "Template name does not exist in the translation", { title: "Template name does not exist in the translation", userMessage: `template ${template.name} is ${template.status} and cannot be sent` });
  }

  const bodyComponent = (body.template.components ?? []).find((x) => String(x.type).toLowerCase() === "body");
  const params = (bodyComponent?.parameters ?? []).map((p) => String(p.text ?? ""));
  if (params.length !== variableCount(template.body)) {
    throw graphError(400, 132000, "Number of parameters does not match the expected number of params", { title: "Number of parameters does not match the expected number of params", userMessage: `number of localizable_params (${params.length}) does not match the expected number of params (${variableCount(template.body)})` });
  }
  if (params.some((p) => /[\r\n\t]| {5,}/.test(p) || p === "")) {
    throw graphError(400, 132018, "There's an issue with the parameters in your template.", { title: "Parameter format does not match format in the created template", userMessage: "Parameters cannot be empty, contain new-line or tab characters, or more than 4 consecutive spaces." });
  }

  const id = `wamid.MOCK-NOT-REAL-${randomHex(12)}`;
  const message: MockWhatsAppMessage = {
    id,
    phoneId: phone.id,
    wabaId: phone.wabaId,
    to,
    template: template.name,
    language: template.language,
    params,
    rendered: renderBody(template.body, params),
    at: new Date(rt.now()).toISOString(),
    statuses: [],
  };
  rt.state.meta.messages[id] = message;
  rt.save();
  rt.activity(`WhatsApp: ${template.name} to ${to}: "${message.rendered}"`, `/__mock/whatsapp#msg-${id}`);
  scheduleStatuses(c, message);
  c.sendJson(200, { messaging_product: "whatsapp", contacts: [{ input: to, wa_id: to.replace(/^\+/, "") }], messages: [{ id, message_status: "accepted" }] });
}

/** What happens to a sent message afterwards (meta.status): sent, delivered, read, or failed, each delivered to the app as a webhook. */
function scheduleStatuses(c: Ctx, message: MockWhatsAppMessage): void {
  const rt = c.rt;
  const [mode, stepText] = takeFault(rt, "meta.status", c).split(":");
  const step = stepText ? Number(stepText) : 1000;
  const plan: [string, number][] =
    mode === "sent_only" ? [["sent", 1]]
    : mode === "failed_131026" ? [["failed", 1]]
    : mode === "instant" ? [["sent", 0], ["delivered", 0], ["read", 0]]
    : mode === "out_of_order" ? [["sent", 1], ["read", 2], ["delivered", 3]]
    : [["sent", 1], ["delivered", 3], ["read", 8]];
  const phone = rt.state.meta.phones[message.phoneId];
  for (const [status, multiple] of plan) {
    rt.later(multiple * step, () => {
      const entry = { status, at: new Date(rt.now()).toISOString(), webhook: "queued" };
      message.statuses.push(entry);
      const failed = status === "failed";
      rt.webhooks.deliver({
        wabaId: message.wabaId,
        kind: `message ${status}`,
        onDone: (outcome) => {
          entry.webhook = outcome;
          rt.save();
        },
        payload: {
          object: "whatsapp_business_account",
          entry: [
            {
              id: message.wabaId,
              time: Math.floor(rt.now() / 1000),
              changes: [
                {
                  field: "messages",
                  value: {
                    messaging_product: "whatsapp",
                    metadata: { display_phone_number: phone.display, phone_number_id: phone.id },
                    statuses: [
                      {
                        id: message.id,
                        status,
                        timestamp: String(Math.floor(rt.now() / 1000)),
                        recipient_id: message.to.replace(/^\+/, ""),
                        ...(failed ? { errors: [{ code: 131026, title: "Message undeliverable", message: "Message undeliverable" }] } : {}),
                      },
                    ],
                  },
                },
              ],
            },
          ],
        },
      });
      rt.save();
    });
  }
}

/* ---------- the fake accounts the Embedded Signup popup can create ---------- */

/** A new, empty WhatsApp Business Account with one fresh number (the popup's "create a new account"). */
export function createWaba(rt: Runtime): { wabaId: string; phoneId: string } {
  const digits = () => String(Math.floor(Math.random() * 1e9)).padStart(9, "0");
  const wabaId = `99100${digits()}`;
  const phoneId = `99200${digits()}`;
  const n = Object.keys(rt.state.meta.wabas).length + 1;
  rt.state.meta.wabas[wabaId] = { id: wabaId, name: `Mock New Account ${n}`, phoneIds: [phoneId], subscribedApps: [], templates: {} };
  rt.state.meta.phones[phoneId] = { id: phoneId, wabaId, display: `+91 00000 ${phoneId.slice(-5)}`, verifiedName: `Mock New Account ${n}`, quality: "GREEN", registered: false, pin: null, wrongAttempts: 0, lockedUntil: null };
  rt.save();
  return { wabaId, phoneId };
}

export function mintEsCode(rt: Runtime, wabaId: string, phoneId: string): string {
  const code = `MOCK-NOT-REAL-escode-${randomHex(12)}`;
  rt.state.meta.esCodes[code] = { appId: META_APP_ID, wabaId, phoneId, used: false, expiresAt: rt.now() + ES_CODE_TTL_MS };
  rt.save();
  return code;
}

/* ---------- routes and control actions ---------- */

const asList = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : typeof v === "string" ? v.split(/[\s,]+/).filter(Boolean) : []);

export function registerMeta(router: Router): void {
  // debug_token and oauth/access_token first: they would otherwise match the `:id` routes.
  router.add("GET", re("/debug_token"), debugToken, "meta");
  router.add("GET", re("/oauth/access_token"), exchangeEsCode, "meta");
  router.add("GET", re("/(?<id>[^/]+)/phone_numbers"), getPhoneNumbers, "meta");
  router.add("GET", re("/(?<id>[^/]+)/message_templates"), listTemplates, "meta");
  router.add("POST", re("/(?<id>[^/]+)/message_templates"), createTemplate, "meta");
  router.add("GET", re("/(?<id>[^/]+)/subscribed_apps"), listSubscribedApps, "meta");
  router.add("POST", re("/(?<id>[^/]+)/subscribed_apps"), subscribeApp, "meta");
  router.add("POST", re("/(?<id>[^/]+)/register"), registerNumber, "meta");
  router.add("POST", re("/(?<id>[^/]+)/messages"), sendMessage, "meta");
  router.add("GET", re("/(?<id>[^/]+)"), getPhone, "meta");
  router.add("POST", re("/(?<id>[^/]+)"), setPin, "meta");

  addControl(router, "/__mock/meta/mint-token", (c, f) => {
    const app = f.app === "own" ? "own" : "platform";
    const wabaIds = asList(f.wabaIds);
    for (const id of wabaIds) if (!c.rt.state.meta.wabas[id]) throw new HttpError(400, { error: `No such account ${id}` });
    const days = Number(f.expiresInDays ?? 0);
    if (![0, 1, 30].includes(days)) throw new HttpError(400, { error: "expiresInDays must be 0 (never), 1 or 30" });
    const scopes = asList(f.scopes).filter((s) => s === SCOPE_MANAGEMENT || s === SCOPE_MESSAGING);
    const token = mintToken(c.rt, { appId: app === "own" ? OWN_APP_ID : META_APP_ID, scopes, wabaIds, expiresInDays: days, label: `${app === "own" ? "influencer's own app" : "platform app"}, ${days ? `${days} day` : "never expires"}` });
    c.rt.activity(`Meta: a ${days ? `${days}-day` : "permanent"} ${app} token was minted for accounts ${wabaIds.join(", ") || "none"}`, "/__mock/meta");
    return { token, redirectTo: `/__mock/meta?token=${encodeURIComponent(token)}#kit` };
  });
  addControl(router, "/__mock/meta/revoke-token", (c, f) => {
    const rec = c.rt.state.meta.tokens[String(f.token ?? "")];
    if (!rec) throw new HttpError(404, { error: "no such token" });
    rec.revokedAt = new Date(c.rt.now()).toISOString();
    c.rt.save();
    c.rt.activity(`Meta: a token (${rec.label}) was revoked, like removing the app in Business settings`, "/__mock/meta");
    return { ok: true };
  });
  addControl(router, "/__mock/meta/expire-token", (c, f) => {
    const rec = c.rt.state.meta.tokens[String(f.token ?? "")];
    if (!rec) throw new HttpError(404, { error: "no such token" });
    rec.expiresAt = Math.floor(c.rt.now() / 1000) - 1;
    c.rt.save();
    c.rt.activity(`Meta: a token (${rec.label}) was expired`, "/__mock/meta");
    return { ok: true };
  });
  addControl(router, "/__mock/meta/template", (c, f) => {
    const actions: Record<string, MockTemplate["status"] | "REINSTATED"> = { approve: "APPROVED", reject: "REJECTED", pause: "PAUSED", disable: "DISABLED", flag: "FLAGGED", reinstate: "REINSTATED" };
    const status = actions[String(f.action ?? "")];
    const wabaId = String(f.wabaId ?? "");
    const templateId = String(f.templateId ?? "");
    if (!status) throw new HttpError(400, { error: `action must be one of ${Object.keys(actions).join(", ")}` });
    if (!c.rt.state.meta.wabas[wabaId]?.templates[templateId]) throw new HttpError(404, { error: "no such template" });
    decide(c.rt, wabaId, templateId, status, typeof f.reason === "string" && f.reason ? f.reason.toUpperCase() : null);
    return { ok: true };
  });
  addControl(router, "/__mock/meta/phone", (c, f) => {
    const phone = c.rt.state.meta.phones[String(f.phoneId ?? "")];
    if (!phone) throw new HttpError(404, { error: "no such phone number" });
    const action = String(f.action ?? "");
    if (action === "set-pin") {
      if (typeof f.pin !== "string" || !PIN.test(f.pin)) throw new HttpError(400, { error: "pin must be 6 digits" });
      phone.pin = f.pin;
      phone.registered = true;
    } else if (action === "clear-pin") {
      phone.pin = null;
    } else if (action === "lock") {
      phone.lockedUntil = new Date(c.rt.now() + PIN_LOCK_MS).toISOString();
    } else if (action === "unlock") {
      phone.lockedUntil = null;
      phone.wrongAttempts = 0;
    } else if (action === "unregister") {
      phone.registered = false;
    } else {
      throw new HttpError(400, { error: "action must be set-pin, clear-pin, lock, unlock or unregister" });
    }
    c.rt.save();
    c.rt.activity(`Meta: ${phone.display}: ${action}${action === "set-pin" ? " (changed behind the app's back)" : ""}`, "/__mock/meta");
    return { ok: true };
  });
  addControl(router, "/__mock/meta/es-code", (c, f) => {
    const wabaId = String(f.wabaId ?? "");
    const phoneId = String(f.phoneId ?? "");
    if (c.rt.state.meta.phones[phoneId]?.wabaId !== wabaId) throw new HttpError(400, { error: "that number is not on that account" });
    return { code: mintEsCode(c.rt, wabaId, phoneId) };
  });
}
