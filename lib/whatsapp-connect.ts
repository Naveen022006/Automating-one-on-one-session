import { TEMPLATE_SPECS, isMetaTemplateName, normalizeTemplateStatus, templateConflict, type TemplateSpec } from "@/lib/message-templates";
import { graphBase, graphVersion } from "@/lib/whatsapp-graph-config";

/**
 * Meta Graph API calls for connecting an influencer's own WhatsApp Business number: checking credentials, reading and
 * submitting message templates, and the Embedded Signup token exchange. Plain fetch with an injectable fetch, like
 * the other provider clients, so everything is unit-tested without a network.
 */

export class WhatsAppGraphError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: number | null = null,
    readonly subcode: number | null = null,
  ) {
    super(message);
  }
  /**
   * The access token cannot be used any more: revoked, expired, wrong app, the user removed access (190, HTTP 401), or
   * it lacks a permission the call needs (10, and the 200-299 range, "API permission denied"). A permission error is
   * as final as an expired token, so it counts: otherwise every message would go by SMS forever, unflagged.
   */
  get invalidToken(): boolean {
    return this.status === 401 || this.code === 190 || this.code === 10 || (this.code !== null && this.code >= 200 && this.code <= 299);
  }
  /** Registering the number failed because it already has a two-step verification PIN, and not the one we sent. */
  get pinMismatch(): boolean {
    return this.code === 133005;
  }
  /** Meta is refusing PIN attempts on this number for a while (too many wrong guesses, or guesses too quickly). */
  get pinLocked(): boolean {
    return this.code === 133008 || this.code === 133009;
  }
}

type FetchFn = typeof fetch;

async function graph<T>(path: string, init: RequestInit & { token?: string } = {}, fetchFn: FetchFn = fetch): Promise<T> {
  const { token, ...rest } = init;
  let res: Response;
  try {
    res = await fetchFn(`${graphBase()}${path}`, {
      ...rest,
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(rest.body ? { "Content-Type": "application/json" } : {}), ...(rest.headers ?? {}) },
      signal: AbortSignal.timeout(20_000),
    });
  } catch (e) {
    throw new WhatsAppGraphError(`Could not reach WhatsApp: ${e instanceof Error ? e.message : String(e)}`, 0);
  }
  const text = await res.text().catch(() => "");
  let body: { error?: { message?: string; code?: number; error_subcode?: number; error_user_msg?: string } } & Record<string, unknown> = {};
  try {
    body = JSON.parse(text);
  } catch {
    /* non-JSON */
  }
  if (!res.ok) {
    const err = body.error;
    throw new WhatsAppGraphError(err?.error_user_msg ?? err?.message ?? (text.slice(0, 200) || `HTTP ${res.status}`), res.status, err?.code ?? null, err?.error_subcode ?? null);
  }
  return body as T;
}

export interface PhoneNumberInfo {
  id: string;
  displayPhone: string | null;
  verifiedName: string | null;
  qualityRating: string | null;
}

/** Reads the number with the given token. Throws WhatsAppGraphError (invalidToken) if the credentials are wrong. */
export async function getPhoneNumber(phoneNumberId: string, token: string, fetchFn?: FetchFn): Promise<PhoneNumberInfo> {
  const r = await graph<{ id?: string; display_phone_number?: string; verified_name?: string; quality_rating?: string }>(
    `/${encodeURIComponent(phoneNumberId)}?fields=display_phone_number,verified_name,quality_rating`,
    { token },
    fetchFn,
  );
  return { id: r.id ?? phoneNumberId, displayPhone: r.display_phone_number ?? null, verifiedName: r.verified_name ?? null, qualityRating: r.quality_rating ?? null };
}

/** True when `phoneNumberId` is one of the numbers on the WhatsApp Business Account (stops mixing up ids). */
export async function wabaOwnsNumber(wabaId: string, phoneNumberId: string, token: string, fetchFn?: FetchFn): Promise<boolean> {
  const r = await graph<{ data?: { id: string }[] }>(`/${encodeURIComponent(wabaId)}/phone_numbers?fields=id&limit=100`, { token }, fetchFn);
  return (r.data ?? []).some((n) => n.id === phoneNumberId);
}

export interface RemoteTemplate {
  name: string;
  language: string;
  status: string;
  rejectedReason?: string | null;
  /** The text of the BODY component, when Meta returned the components. */
  bodyText?: string | null;
}

type RemoteTemplateRow = { name: string; language: string; status: string; rejected_reason?: string; components?: { type?: string; text?: string }[] };

const TEMPLATE_FIELDS = "name,language,status,rejected_reason,components";
/** Pages of 100: more than this many pages means something is wrong, not that the account has 10,000 templates. */
const MAX_TEMPLATE_PAGES = 100;

function toRemoteTemplate(t: RemoteTemplateRow): RemoteTemplate {
  return {
    name: t.name,
    language: t.language,
    status: normalizeTemplateStatus(t.status),
    rejectedReason: t.rejected_reason && t.rejected_reason !== "NONE" ? t.rejected_reason : null,
    bodyText: t.components?.find((c) => c.type === "BODY")?.text ?? null,
  };
}

/** Every page of `/{waba}/message_templates` for `query`: an account with many templates does not fit in one answer. */
async function readTemplates(wabaId: string, token: string, query: string, fetchFn?: FetchFn): Promise<RemoteTemplate[]> {
  const out: RemoteTemplate[] = [];
  let after: string | undefined;
  for (let page = 0; page < MAX_TEMPLATE_PAGES; page++) {
    const cursor = after ? `&after=${encodeURIComponent(after)}` : "";
    const r = await graph<{ data?: RemoteTemplateRow[]; paging?: { cursors?: { after?: string }; next?: string } }>(
      `/${encodeURIComponent(wabaId)}/message_templates?fields=${TEMPLATE_FIELDS}&limit=100${query}${cursor}`,
      { token },
      fetchFn,
    );
    out.push(...(r.data ?? []).map(toRemoteTemplate));
    after = r.paging?.next ? r.paging.cursors?.after : undefined;
    if (!after) return out;
  }
  throw new WhatsAppGraphError("Meta kept returning more pages of templates than any account has", 0);
}

/** All the account's templates, every page. */
export async function listTemplates(wabaId: string, token: string, fetchFn?: FetchFn): Promise<RemoteTemplate[]> {
  return readTemplates(wabaId, token, "", fetchFn);
}

/** One template by exact name and language, or null. Used when Meta says it exists but the list did not show it. */
export async function getTemplateByName(wabaId: string, name: string, language: string, token: string, fetchFn?: FetchFn): Promise<RemoteTemplate | null> {
  const found = await readTemplates(wabaId, token, `&name=${encodeURIComponent(name)}`, fetchFn);
  return found.find((t) => t.name === name && t.language === language) ?? null;
}

/**
 * The Graph payload that submits one of our templates for approval as a UTILITY template. The name is the Meta name
 * (spec.name), and is checked here too: Meta refuses anything but lowercase letters, digits and underscores, and a
 * name it refuses means that template can never be approved.
 */
export function templatePayload(spec: TemplateSpec, language: string) {
  if (!isMetaTemplateName(spec.name)) throw new Error(`"${spec.name}" is not a valid WhatsApp template name (lowercase letters, digits and underscores only)`);
  return {
    name: spec.name,
    language,
    category: "UTILITY",
    components: [{ type: "BODY", text: spec.body, example: { body_text: [spec.examples] } }],
  };
}

/** True when Meta says this name + language already exists (so re-submitting is not an error). */
export function isAlreadyExists(e: unknown): boolean {
  return e instanceof WhatsAppGraphError && (e.subcode === 2388024 || e.subcode === 2388023 || /already exists/i.test(e.message));
}

export interface TemplateSyncResult {
  templates: Record<string, { status: string; language: string; reason?: string | null }>;
  submitted: string[];
  failed: { name: string; error: string }[];
}

/**
 * Makes sure every template the app sends exists on the influencer's account: reads what is there, submits what is
 * missing, and returns the status of each. Safe to run repeatedly.
 */
export async function ensureTemplates(wabaId: string, token: string, language: string, fetchFn?: FetchFn): Promise<TemplateSyncResult> {
  const remote = await listTemplates(wabaId, token, fetchFn);
  // Keyed by the name Meta knows (spec.name); everything we return is keyed by our own template key.
  const have = new Map(remote.filter((t) => t.language === language).map((t) => [t.name, t]));
  const submitted: string[] = [];
  const failed: { name: string; error: string }[] = [];
  /** Templates we just created: they say exactly what ours says, so only the ones found already there are compared. */
  const justCreated = new Set<string>();

  for (const [key, spec] of Object.entries(TEMPLATE_SPECS)) {
    if (have.has(spec.name)) continue;
    try {
      const created = await graph<{ id?: string; status?: string }>(`/${encodeURIComponent(wabaId)}/message_templates`, { method: "POST", token, body: JSON.stringify(templatePayload(spec, language)) }, fetchFn);
      have.set(spec.name, { name: spec.name, language, status: normalizeTemplateStatus(created.status ?? "PENDING") });
      justCreated.add(spec.name);
      submitted.push(key);
    } catch (e) {
      if (!isAlreadyExists(e)) {
        failed.push({ name: key, error: e instanceof Error ? e.message.slice(0, 200) : "failed" });
        continue;
      }
      // Meta says it is there but the list we read did not show it (created a moment ago, or on a page we could not
      // see). Ask for it by name and record what it really is, rather than leaving it unknown (which reads as "not sendable").
      try {
        const existing = await getTemplateByName(wabaId, spec.name, language, token, fetchFn);
        if (existing) have.set(spec.name, existing);
        else failed.push({ name: key, error: `Meta says a template like "${spec.name}" already exists, but it is not on this account's list in this language` });
      } catch (lookup) {
        failed.push({ name: key, error: lookup instanceof Error ? lookup.message.slice(0, 200) : "could not read the existing template" });
      }
    }
  }
  const templates: TemplateSyncResult["templates"] = {};
  for (const [key, spec] of Object.entries(TEMPLATE_SPECS)) {
    const t = have.get(spec.name);
    if (!t) continue;
    // A template that was already there under our name is used only if it takes as many variables as we send. One with
    // another number would be sent our parameters and fail, so it is reported and not used. Its wording is not compared
    // (see templateConflict), so rewording a message never flips approved templates.
    const clash = justCreated.has(spec.name) ? null : templateConflict(t.bodyText, spec);
    if (clash) {
      templates[key] = {
        status: "CONFLICT",
        language,
        reason: `A template named "${spec.name}" already exists on your WhatsApp account and is not ours: ${clash}. Rename or delete it in WhatsApp Manager, then press Check template status.`,
      };
      continue;
    }
    templates[key] = { status: t.status, language, ...(t.rejectedReason ? { reason: t.rejectedReason } : {}) };
  }
  return { templates, submitted, failed };
}

/* ---------- Is this token one we can rely on? ---------- */

/** The permissions a token needs to manage templates and send messages for an account. */
export const REQUIRED_SCOPES = ["whatsapp_business_management", "whatsapp_business_messaging"] as const;
/** A token that expires sooner than this is refused: it would stop working right after the influencer connects. */
export const MIN_TOKEN_LIFETIME_DAYS = 7;

export interface TokenInfo {
  valid: boolean;
  /** When the token stops working, or null when it does not expire (a System User token). */
  expiresAt: Date | null;
  /** The permissions granted, or null when Meta did not list any (so they cannot be checked). */
  scopes: string[] | null;
  /** The Meta app the token was issued for, when Meta says. */
  appId?: string;
}

/** Asks debug_token about `inputToken`, authorised by `accessToken` (an app access token, or the token itself). */
async function debugWith(inputToken: string, accessToken: string, fetchFn?: FetchFn): Promise<TokenInfo> {
  const qs = new URLSearchParams({ input_token: inputToken });
  const r = await graph<{ data?: { is_valid?: boolean; app_id?: string; expires_at?: number; scopes?: string[]; granular_scopes?: { scope?: string }[] } }>(
    `/debug_token?${qs}`,
    { token: accessToken },
    fetchFn,
  );
  const d = r.data;
  if (!d) throw new WhatsAppGraphError("Meta did not return details for the token", 0);
  const scopes = [...new Set([...(d.scopes ?? []), ...(d.granular_scopes ?? []).map((g) => g.scope ?? "").filter(Boolean)])];
  return {
    valid: d.is_valid === true,
    expiresAt: d.expires_at ? new Date(d.expires_at * 1000) : null, // 0 or missing: never
    scopes: scopes.length ? scopes : null,
    ...(d.app_id ? { appId: String(d.app_id) } : {}),
  };
}

/** What Meta's debug_token says about `token`, asked as our Meta app (its id and secret are not the influencer's). */
export async function debugToken(token: string, appId: string, appSecret: string, fetchFn?: FetchFn): Promise<TokenInfo> {
  return debugWith(token, `${appId}|${appSecret}`, fetchFn); // an app access token; the influencer's token is only the thing being inspected
}

/**
 * Inspects a token. A pasted token usually belongs to the influencer's OWN Meta app, which our app credentials cannot
 * inspect (Meta answers with an app mismatch, or says the token is not valid), so when asking as our app does not give a
 * valid answer about a token of ours, the token is asked to inspect itself (debug_token with the token as both
 * input_token and access_token). Throws only when neither could say, so the caller can say "not checked" rather than
 * refuse a token that may be fine.
 */
export async function inspectToken(token: string, env = process.env, fetchFn?: FetchFn): Promise<TokenInfo> {
  const app = metaAppCredentials(env);
  if (app) {
    try {
      const info = await debugToken(token, app.appId, app.appSecret, fetchFn);
      if (info.valid && (!info.appId || info.appId === app.appId)) return info;
    } catch {
      /* cannot be inspected as our app: let the token inspect itself */
    }
  }
  return debugWith(token, token, fetchFn);
}

export type TokenCheck = { ok: true; notes: string[] } | { ok: false; message: string };

const ago = (ms: number) => (ms < 48 * 3_600_000 ? `${Math.max(1, Math.round(ms / 3_600_000))} hour(s)` : `${Math.round(ms / 86_400_000)} days`);

/**
 * Judges what debug_token said: refuses a token that is not valid, lacks a permission, or expires within
 * MIN_TOKEN_LIFETIME_DAYS (the 24-hour token on the API Setup page); notes (does not refuse) a token that expires later,
 * or whose permissions Meta did not list. Pure, so it is tested without Graph.
 */
export function checkTokenInfo(info: TokenInfo, now = new Date()): TokenCheck {
  if (!info.valid) return { ok: false, message: "Meta says this access token is not valid (it may be revoked, expired or from another app). Create a new one." };
  if (info.scopes) {
    const missing = REQUIRED_SCOPES.filter((s) => !info.scopes!.includes(s));
    if (missing.length) {
      return { ok: false, message: `This access token is missing the ${missing.join(" and ")} permission${missing.length > 1 ? "s" : ""}. Generate it again for a System User with both WhatsApp permissions.` };
    }
  }
  const notes: string[] = [];
  if (!info.scopes) notes.push("Meta did not list this token's permissions, so we could not check them. It needs whatsapp_business_management and whatsapp_business_messaging.");
  if (info.expiresAt) {
    const left = info.expiresAt.getTime() - now.getTime();
    if (left < MIN_TOKEN_LIFETIME_DAYS * 86_400_000) {
      return { ok: false, message: `This access token expires in ${ago(Math.max(0, left))}. Use a permanent System User token (Business settings, System users, Generate token, expiry Never).` };
    }
    notes.push(`This access token expires on ${info.expiresAt.toISOString().slice(0, 10)}. Connect again with a new token before then, or use a permanent System User token.`);
  }
  return { ok: true, notes };
}

/* ---------- The Meta app ---------- */

/**
 * The Meta app's secret. It is one value that the settings used to call by two names: WHATSAPP_APP_SECRET (verifying
 * webhook callbacks) and META_APP_SECRET (Embedded Signup). Either name works for both; when both are set each use
 * keeps the name it always read first.
 */
export function webhookAppSecret(env = process.env): string | undefined {
  return env.WHATSAPP_APP_SECRET || env.META_APP_SECRET || undefined;
}

export function metaAppSecret(env = process.env): string | undefined {
  return env.META_APP_SECRET || env.WHATSAPP_APP_SECRET || undefined;
}

/** The Meta app's id and secret, or null when this server does not have both. */
export function metaAppCredentials(env = process.env): { appId: string; appSecret: string } | null {
  const appSecret = metaAppSecret(env);
  return env.META_APP_ID && appSecret ? { appId: env.META_APP_ID, appSecret } : null;
}

/* ---------- Embedded Signup ---------- */

export function embeddedSignupConfig(env = process.env): { appId: string; configId: string; graphVersion: string } | null {
  return env.META_APP_ID && env.META_ES_CONFIG_ID && metaAppSecret(env)
    ? { appId: env.META_APP_ID, configId: env.META_ES_CONFIG_ID, graphVersion: graphVersion(env) }
    : null;
}

/** Exchanges the code from the Embedded Signup dialog for the business token. */
export async function exchangeEmbeddedCode(code: string, env = process.env, fetchFn?: FetchFn): Promise<string> {
  const app = metaAppCredentials(env);
  if (!app) throw new WhatsAppGraphError("Meta app credentials are not configured", 0);
  const qs = new URLSearchParams({ client_id: app.appId, client_secret: app.appSecret, code });
  const r = await graph<{ access_token?: string }>(`/oauth/access_token?${qs}`, {}, fetchFn);
  if (!r.access_token) throw new WhatsAppGraphError("Meta did not return an access token", 0);
  return r.access_token;
}

/** The ids of the Meta apps subscribed to the account's webhooks. */
export async function listSubscribedApps(wabaId: string, token: string, fetchFn?: FetchFn): Promise<string[]> {
  const r = await graph<{ data?: { id?: string; whatsapp_business_api_data?: { id?: string } }[] }>(`/${encodeURIComponent(wabaId)}/subscribed_apps`, { token }, fetchFn);
  return (r.data ?? []).map((a) => String(a.whatsapp_business_api_data?.id ?? a.id ?? "")).filter(Boolean);
}

export interface SubscriptionResult {
  /** True only when OUR Meta app is among the apps subscribed to the account, so its webhooks do reach us. */
  subscribed: boolean;
  /** Why not, when it is not. */
  reason: string | null;
}

/**
 * Subscribes the Meta app that issued `token` to the account's webhooks (delivery statuses, template status), then reads
 * the list of subscribed apps back. A hand-pasted token usually belongs to the influencer's OWN Meta app, and then it is
 * THEIR app that gets subscribed: Meta is happy, but nothing ever reaches our webhook. So "subscribed" is reported only
 * when our app (META_APP_ID) is in the list.
 */
export async function subscribeApp(wabaId: string, token: string, fetchFn?: FetchFn, env = process.env): Promise<SubscriptionResult> {
  await graph(`/${encodeURIComponent(wabaId)}/subscribed_apps`, { method: "POST", token }, fetchFn);
  if (!env.META_APP_ID) return { subscribed: false, reason: "META_APP_ID is not set on this server, so we cannot tell whether our app is the one subscribed" };
  let apps: string[];
  try {
    apps = await listSubscribedApps(wabaId, token, fetchFn);
  } catch (e) {
    return { subscribed: false, reason: `could not confirm which app is subscribed (${e instanceof Error ? e.message.slice(0, 120) : "unknown error"})` };
  }
  return apps.includes(env.META_APP_ID)
    ? { subscribed: true, reason: null }
    : { subscribed: false, reason: "the access token belongs to a different Meta app than ours, so Meta's updates do not reach us" };
}

/**
 * Sets (or changes) the two-step verification PIN of a number that is already registered, without needing the current
 * one (Meta's "set two-step verification code" call, authorised by the business token). Used to bring a number back in
 * line with a PIN we generated when it holds a different one that nobody here knows.
 */
export async function setTwoStepPin(phoneNumberId: string, token: string, pin: string, fetchFn?: FetchFn): Promise<void> {
  await graph(`/${encodeURIComponent(phoneNumberId)}`, { method: "POST", token, body: JSON.stringify({ pin }) }, fetchFn);
}

/**
 * Registers the number for the Cloud API (needed for a newly added number) and sets its two-step verification PIN to
 * `pin`. Idempotent for the same PIN. A number that already has a different PIN fails with WhatsAppGraphError.pinMismatch.
 */
export async function registerNumber(phoneNumberId: string, token: string, pin: string, fetchFn?: FetchFn): Promise<void> {
  try {
    await graph(`/${encodeURIComponent(phoneNumberId)}/register`, { method: "POST", token, body: JSON.stringify({ messaging_product: "whatsapp", pin }) }, fetchFn);
  } catch (e) {
    // "Already registered" is fine; "not registered" (which also contains the word) is not.
    if (e instanceof WhatsAppGraphError && /already (registered|exists)/i.test(e.message)) return;
    throw e;
  }
}
