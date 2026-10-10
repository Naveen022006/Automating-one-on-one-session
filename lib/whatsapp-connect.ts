import { TEMPLATE_SPECS, isMetaTemplateName, type TemplateSpec } from "@/lib/message-templates";

/**
 * Meta Graph API calls for connecting an influencer's own WhatsApp Business number: checking credentials, reading and
 * submitting message templates, and the Embedded Signup token exchange. Plain fetch with an injectable fetch, like
 * the other provider clients, so everything is unit-tested without a network.
 */

export const GRAPH = "https://graph.facebook.com/v21.0";

export class WhatsAppGraphError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: number | null = null,
    readonly subcode: number | null = null,
  ) {
    super(message);
  }
  /** The access token is no longer valid (revoked, expired, wrong app, or the user removed access). */
  get invalidToken(): boolean {
    return this.status === 401 || this.code === 190;
  }
}

type FetchFn = typeof fetch;

async function graph<T>(path: string, init: RequestInit & { token?: string } = {}, fetchFn: FetchFn = fetch): Promise<T> {
  const { token, ...rest } = init;
  let res: Response;
  try {
    res = await fetchFn(`${GRAPH}${path}`, {
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

/* ---------- Embedded Signup ---------- */

export function embeddedSignupConfig(env = process.env): { appId: string; configId: string } | null {
  return env.META_APP_ID && env.META_ES_CONFIG_ID && env.META_APP_SECRET ? { appId: env.META_APP_ID, configId: env.META_ES_CONFIG_ID } : null;
}

/** Exchanges the code from the Embedded Signup dialog for the business token. */
export async function exchangeEmbeddedCode(code: string, env = process.env, fetchFn?: FetchFn): Promise<string> {
  if (!env.META_APP_ID || !env.META_APP_SECRET) throw new WhatsAppGraphError("Meta app credentials are not configured", 0);
  const qs = new URLSearchParams({ client_id: env.META_APP_ID, client_secret: env.META_APP_SECRET, code });
  const r = await graph<{ access_token?: string }>(`/oauth/access_token?${qs}`, {}, fetchFn);
  if (!r.access_token) throw new WhatsAppGraphError("Meta did not return an access token", 0);
  return r.access_token;
}

/** Subscribes our Meta app to the account's webhooks (delivery statuses, template status). */
export async function subscribeApp(wabaId: string, token: string, fetchFn?: FetchFn): Promise<void> {
  await graph(`/${encodeURIComponent(wabaId)}/subscribed_apps`, { method: "POST", token }, fetchFn);
}

/**
 * Registers the number for the Cloud API (needed for a newly added number). Idempotent: an already-registered number
 * answers with an error that is safe to ignore.
 */
export async function registerNumber(phoneNumberId: string, token: string, pin: string, fetchFn?: FetchFn): Promise<void> {
  try {
    await graph(`/${encodeURIComponent(phoneNumberId)}/register`, { method: "POST", token, body: JSON.stringify({ messaging_product: "whatsapp", pin }) }, fetchFn);
  } catch (e) {
    if (e instanceof WhatsAppGraphError && /already|registered/i.test(e.message)) return;
    throw e;
  }
}
