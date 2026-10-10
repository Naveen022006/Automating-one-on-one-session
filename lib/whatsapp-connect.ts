import { TEMPLATE_SPECS, isMetaTemplateName, type TemplateSpec } from "@/lib/message-templates";
import { graphBase, graphVersion } from "@/lib/whatsapp-graph-version";

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
}

export async function listTemplates(wabaId: string, token: string, fetchFn?: FetchFn): Promise<RemoteTemplate[]> {
  const r = await graph<{ data?: { name: string; language: string; status: string; rejected_reason?: string }[] }>(
    `/${encodeURIComponent(wabaId)}/message_templates?fields=name,language,status,rejected_reason&limit=200`,
    { token },
    fetchFn,
  );
  return (r.data ?? []).map((t) => ({ name: t.name, language: t.language, status: t.status, rejectedReason: t.rejected_reason && t.rejected_reason !== "NONE" ? t.rejected_reason : null }));
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

  for (const [key, spec] of Object.entries(TEMPLATE_SPECS)) {
    if (have.has(spec.name)) continue;
    try {
      const created = await graph<{ id?: string; status?: string }>(`/${encodeURIComponent(wabaId)}/message_templates`, { method: "POST", token, body: JSON.stringify(templatePayload(spec, language)) }, fetchFn);
      have.set(spec.name, { name: spec.name, language, status: created.status ?? "PENDING" });
      submitted.push(key);
    } catch (e) {
      if (isAlreadyExists(e)) continue;
      failed.push({ name: key, error: e instanceof Error ? e.message.slice(0, 200) : "failed" });
    }
  }
  const templates: TemplateSyncResult["templates"] = {};
  for (const [key, spec] of Object.entries(TEMPLATE_SPECS)) {
    const t = have.get(spec.name);
    if (t) templates[key] = { status: t.status, language, ...(t.rejectedReason ? { reason: t.rejectedReason } : {}) };
  }
  return { templates, submitted, failed };
}

/** Statuses we treat as "this template can be sent". */
export function isApproved(status: string | undefined): boolean {
  return status === "APPROVED";
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
}

/** What Meta's debug_token says about `token`. Needs the Meta app's id and secret, which are not the influencer's. */
export async function debugToken(token: string, appId: string, appSecret: string, fetchFn?: FetchFn): Promise<TokenInfo> {
  const qs = new URLSearchParams({ input_token: token });
  const r = await graph<{ data?: { is_valid?: boolean; expires_at?: number; scopes?: string[]; granular_scopes?: { scope?: string }[] } }>(
    `/debug_token?${qs}`,
    { token: `${appId}|${appSecret}` }, // an app access token; the influencer's token is only the thing being inspected
    fetchFn,
  );
  const d = r.data;
  if (!d) throw new WhatsAppGraphError("Meta did not return details for the token", 0);
  const scopes = [...new Set([...(d.scopes ?? []), ...(d.granular_scopes ?? []).map((g) => g.scope ?? "").filter(Boolean)])];
  return {
    valid: d.is_valid === true,
    expiresAt: d.expires_at ? new Date(d.expires_at * 1000) : null, // 0 or missing: never
    scopes: scopes.length ? scopes : null,
  };
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

/** Subscribes our Meta app to the account's webhooks (delivery statuses, template status). */
export async function subscribeApp(wabaId: string, token: string, fetchFn?: FetchFn): Promise<void> {
  await graph(`/${encodeURIComponent(wabaId)}/subscribed_apps`, { method: "POST", token }, fetchFn);
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
