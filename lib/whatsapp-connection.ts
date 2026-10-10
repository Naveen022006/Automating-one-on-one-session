import { randomInt } from "node:crypto";
import { alertInfluencer } from "@/lib/alerts";
import { decryptSecret, encryptSecret } from "@/lib/crypto";
import { prisma } from "@/lib/db";
import { TEMPLATE_SPECS, templateKeyFromMetaName } from "@/lib/message-templates";
import {
  WhatsAppGraphError,
  ensureTemplates,
  exchangeEmbeddedCode,
  checkTokenInfo,
  debugToken,
  getPhoneNumber,
  isApproved,
  listTemplates,
  metaAppCredentials,
  registerNumber,
  subscribeApp,
  wabaOwnsNumber,
  type PhoneNumberInfo,
  type TemplateSyncResult,
  type TokenInfo,
} from "@/lib/whatsapp-connect";

/**
 * Each influencer messages their customers from their own WhatsApp Business number. This module stores the
 * connection (token encrypted, never shown again), checks credentials with Meta before saving, makes sure our
 * message templates exist on their account, and answers "which credentials do I send with?".
 */

export class WhatsAppConnectError extends Error {
  constructor(
    message: string,
    readonly status = 400,
    readonly field?: string,
  ) {
    super(message);
  }
}

/** The influencer has no usable WhatsApp connection, so the message goes to the SMS fallback instead. */
export class WhatsAppNotConnectedError extends Error {}

const aad = (influencerId: string) => `whatsapp:${influencerId}`;
/** Shared with the key-rotation tool (lib/key-rotation-db.ts), so the two can never disagree on the AAD. */
export { aad as whatsappTokenAad };
/** The two-step PIN is bound to its owner the same way (and also listed for key rotation). */
const pinAad = (influencerId: string) => `whatsapp-pin:${influencerId}`;
export { pinAad as whatsappPinAad };
const language = () => process.env.WHATSAPP_TEMPLATE_LANGUAGE || "en";

export interface ConnectDeps {
  getPhoneNumber: (phoneNumberId: string, token: string) => Promise<PhoneNumberInfo>;
  wabaOwnsNumber: (wabaId: string, phoneNumberId: string, token: string) => Promise<boolean>;
  ensureTemplates: (wabaId: string, token: string, language: string) => Promise<TemplateSyncResult>;
  exchangeCode: (code: string) => Promise<string>;
  subscribeApp: (wabaId: string, token: string) => Promise<void>;
  registerNumber: (phoneNumberId: string, token: string, pin: string) => Promise<void>;
  /** Meta's view of the token (permissions, expiry), or null when this server has no Meta app id and secret to ask with. */
  inspectToken: (token: string) => Promise<TokenInfo | null>;
}

const defaultDeps: ConnectDeps = {
  getPhoneNumber: (id, t) => getPhoneNumber(id, t),
  wabaOwnsNumber: (w, p, t) => wabaOwnsNumber(w, p, t),
  ensureTemplates: (w, t, l) => ensureTemplates(w, t, l),
  exchangeCode: (c) => exchangeEmbeddedCode(c),
  subscribeApp: (w, t) => subscribeApp(w, t),
  registerNumber: (p, t, pin) => registerNumber(p, t, pin),
  inspectToken: async (t) => {
    const app = metaAppCredentials();
    return app ? debugToken(t, app.appId, app.appSecret) : null;
  },
};

const ID = /^\d{5,30}$/;
const PIN = /^\d{6}$/;

function friendly(e: unknown): WhatsAppConnectError {
  if (e instanceof WhatsAppConnectError) return e;
  if (e instanceof WhatsAppGraphError) {
    if (e.invalidToken) return new WhatsAppConnectError("Meta rejected that access token. Check it is a permanent token with WhatsApp permissions.", 400, "accessToken");
    return new WhatsAppConnectError(`WhatsApp said: ${e.message}`, e.status >= 500 || e.status === 0 ? 502 : 400);
  }
  return new WhatsAppConnectError("Could not reach WhatsApp. Please try again.", 502);
}

/** A random 6-digit two-step verification PIN, one per connection. */
export function generateRegistrationPin(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, "0");
}

/** The PIN the influencer typed, checked: undefined when left blank, a field error when it is not 6 digits. */
function suppliedPin(raw: string | undefined): string | undefined {
  const pin = raw?.trim();
  if (!pin) return undefined;
  if (!PIN.test(pin)) throw new WhatsAppConnectError("The two-step verification PIN is 6 digits.", 400, "pin");
  return pin;
}

/** The PIN we registered this influencer's number with earlier (a reconnect must register with the same one), or null. */
export async function getRegistrationPin(influencerId: string, phoneNumberId: string): Promise<string | null> {
  const row = await prisma.whatsAppConnection.findUnique({ where: { influencerId }, select: { phoneNumberId: true, registrationPinEnc: true } });
  if (!row || row.phoneNumberId !== phoneNumberId || !row.registrationPinEnc) return null;
  try {
    return decryptSecret(row.registrationPinEnc, pinAad(influencerId));
  } catch {
    return null;
  }
}

/**
 * Registering a number that already has a two-step PIN of its own, different from ours, is refused by Meta. Say so in
 * a way the influencer can act on: they know their own PIN, we do not.
 */
function registrationError(e: unknown, supplied: boolean): WhatsAppConnectError {
  if (e instanceof WhatsAppGraphError && e.pinMismatch) {
    return new WhatsAppConnectError(
      supplied
        ? "That two-step verification PIN does not match the one set on this number. Check it and try again."
        : "This number already has a two-step verification PIN. Enter it in the PIN field and connect again.",
      400,
      "pin",
    );
  }
  if (e instanceof WhatsAppGraphError && e.pinLocked) {
    return new WhatsAppConnectError("WhatsApp has paused PIN attempts on this number after too many tries. Wait a while, then connect again.", 400, "pin");
  }
  return friendly(e);
}

/**
 * Asks Meta whether the token is fit to connect with: valid, both WhatsApp permissions, not about to expire. Refuses a
 * bad one. Where the check cannot be made (no Meta app id and secret here, or Meta did not answer) it does not stand in
 * the way, but says so in the notes returned to the influencer: the number may still be fine.
 */
async function vetToken(token: string, deps: ConnectDeps): Promise<string[]> {
  let info: TokenInfo | null;
  try {
    info = await deps.inspectToken(token);
  } catch (e) {
    console.error("[whatsapp] could not inspect the token", e instanceof Error ? e.message : e);
    return ["We could not check this token's permissions and expiry with Meta just now. It needs whatsapp_business_management and whatsapp_business_messaging, and should not expire."];
  }
  if (!info) return ["This server has no Meta app id and secret configured, so the token's permissions and expiry were not checked."];
  const check = checkTokenInfo(info);
  if (!check.ok) throw new WhatsAppConnectError(check.message, 400, "accessToken");
  return check.notes;
}

/** Subscribes our Meta app to the account's webhooks and says how it went, in the shape stored on the connection. */
async function subscribeWebhooks(wabaId: string, token: string, deps: ConnectDeps): Promise<{ webhookSubscribedAt: Date | null; webhookError: string | null }> {
  try {
    await deps.subscribeApp(wabaId, token);
    return { webhookSubscribedAt: new Date(), webhookError: null };
  } catch (e) {
    const why = e instanceof Error ? e.message : "failed";
    console.error("[whatsapp] could not subscribe to webhooks", why);
    return { webhookSubscribedAt: null, webhookError: why.slice(0, 300) };
  }
}

async function persist(
  influencerId: string,
  c: { wabaId: string; phoneNumberId: string; token: string; source: "manual" | "embedded"; pin?: string; pinSupplied?: boolean },
  deps: ConnectDeps,
): Promise<WhatsAppConnectionView & { notes: string[] }> {
  const notes = await vetToken(c.token, deps);
  let phone: PhoneNumberInfo;
  try {
    phone = await deps.getPhoneNumber(c.phoneNumberId, c.token);
    if (!(await deps.wabaOwnsNumber(c.wabaId, c.phoneNumberId, c.token))) {
      throw new WhatsAppConnectError("That phone number is not on this WhatsApp Business Account. Check both ids.", 400, "phoneNumberId");
    }
  } catch (e) {
    throw friendly(e);
  }

  const taken = await prisma.whatsAppConnection.findUnique({ where: { phoneNumberId: c.phoneNumberId }, select: { influencerId: true } });
  if (taken && taken.influencerId !== influencerId) throw new WhatsAppConnectError("This WhatsApp number is already connected to another account.", 409, "phoneNumberId");

  // Subscribe our Meta app to the account so template approvals and delivery statuses reach /api/webhooks/whatsapp.
  // Best effort, like the template sync: the number works without it. The outcome is saved and shown.
  const webhook = await subscribeWebhooks(c.wabaId, c.token, deps);

  // Register last of the checks that can refuse the connection, so a number we then turn away is never left
  // registered with a PIN we did not keep.
  if (c.pin) {
    try {
      await deps.registerNumber(c.phoneNumberId, c.token, c.pin);
    } catch (e) {
      throw registrationError(e, c.pinSupplied === true);
    }
  }

  // Template trouble must not block connecting: the number works as soon as templates are approved, and the
  // influencer can retry from the dashboard.
  let sync: TemplateSyncResult | null = null;
  try {
    sync = await deps.ensureTemplates(c.wabaId, c.token, language());
  } catch (e) {
    console.error("[whatsapp] could not sync templates", e instanceof Error ? e.message : e);
  }

  const data = {
    wabaId: c.wabaId,
    phoneNumberId: c.phoneNumberId,
    displayPhone: phone.displayPhone,
    verifiedName: phone.verifiedName,
    tokenEnc: encryptSecret(c.token, aad(influencerId)),
    ...(c.pin ? { registrationPinEnc: encryptSecret(c.pin, pinAad(influencerId)) } : {}),
    source: c.source,
    status: "ACTIVE" as const,
    lastError: sync && sync.failed.length ? `Could not submit: ${sync.failed.map((f) => f.name).join(", ")}` : null,
    ...(sync ? { templates: sync.templates, templatesSyncedAt: new Date() } : {}),
    ...webhook,
  };
  await prisma.whatsAppConnection.upsert({ where: { influencerId }, create: { influencerId, ...data }, update: { ...data, connectedAt: new Date() } });
  return { ...(await getConnectionView(influencerId))!, notes };
}

/**
 * Connect by entering the ids and a permanent system-user token. Verified with Meta before anything is saved. A number
 * that is not registered for the Cloud API yet (or that has a two-step PIN) can be registered by giving its `pin`;
 * without one we leave the number as it is, since the API Setup page has usually registered it already.
 */
export async function connectManual(
  influencerId: string,
  input: { wabaId: string; phoneNumberId: string; accessToken: string; pin?: string },
  deps: ConnectDeps = defaultDeps,
) {
  const wabaId = input.wabaId.trim();
  const phoneNumberId = input.phoneNumberId.trim();
  const token = input.accessToken.trim();
  if (!ID.test(wabaId)) throw new WhatsAppConnectError("The WhatsApp Business Account id is a number, like 104857392010394.", 400, "wabaId");
  if (!ID.test(phoneNumberId)) throw new WhatsAppConnectError("The phone number id is a number, like 109283746501928.", 400, "phoneNumberId");
  if (token.length < 20 || /\s/.test(token)) throw new WhatsAppConnectError("Paste the full access token.", 400, "accessToken");
  const pin = suppliedPin(input.pin);
  return persist(influencerId, { wabaId, phoneNumberId, token, source: "manual", pin, pinSupplied: pin !== undefined }, deps);
}

/**
 * The PIN to register an Embedded Signup number with: the one the influencer typed (their number already has one),
 * else the one we registered this number with before, else a development default from WHATSAPP_REGISTRATION_PIN
 * (never in production, where one shared PIN would become every influencer's two-step PIN), else a new random one.
 */
async function pinForEmbedded(influencerId: string, phoneNumberId: string, supplied: string | undefined, env: NodeJS.ProcessEnv): Promise<string> {
  if (supplied) return supplied;
  const stored = await getRegistrationPin(influencerId, phoneNumberId);
  if (stored) return stored;
  const dev = env.WHATSAPP_REGISTRATION_PIN?.trim();
  if (env.NODE_ENV !== "production" && dev && PIN.test(dev)) return dev;
  return generateRegistrationPin();
}

/** Finish Meta Embedded Signup: exchange the code, subscribe to webhooks, register the number with its own PIN, save. */
export async function connectEmbedded(
  influencerId: string,
  input: { code: string; wabaId: string; phoneNumberId: string; pin?: string },
  deps: ConnectDeps = defaultDeps,
  env = process.env,
) {
  if (!ID.test(input.wabaId) || !ID.test(input.phoneNumberId)) throw new WhatsAppConnectError("WhatsApp did not return your account details. Please try again.", 400);
  // Checked before the code is exchanged: the code works once, so a typo in the PIN must not use it up.
  const supplied = suppliedPin(input.pin);
  let token: string;
  try {
    token = await deps.exchangeCode(input.code);
  } catch (e) {
    throw friendly(e);
  }
  const pin = await pinForEmbedded(influencerId, input.phoneNumberId, supplied, env);
  return persist(influencerId, { wabaId: input.wabaId, phoneNumberId: input.phoneNumberId, token, source: "embedded", pin, pinSupplied: supplied !== undefined }, deps);
}

export interface WhatsAppConnectionView {
  displayPhone: string | null;
  verifiedName: string | null;
  source: string;
  status: "ACTIVE" | "ERROR";
  /** What to show the influencer as the problem: the last error, plus a note when Meta is not sending us live updates. */
  lastError: string | null;
  connectedAt: Date;
  templates: { name: string; status: string; reason: string | null }[];
  /** Every template we send is approved: WhatsApp messages will actually go out. */
  ready: boolean;
  /** Whether Meta sends us template approvals and delivery statuses for this account (otherwise they only change on a manual check). */
  webhook: { subscribed: boolean; error: string | null };
}

type StoredTemplates = Record<string, { status: string; reason?: string | null }>;

export function viewTemplates(raw: unknown): WhatsAppConnectionView["templates"] {
  const stored = (raw && typeof raw === "object" ? raw : {}) as StoredTemplates;
  return Object.keys(TEMPLATE_SPECS).map((name) => ({ name, status: stored[name]?.status ?? "NOT_SUBMITTED", reason: stored[name]?.reason ?? null }));
}

export async function getConnectionView(influencerId: string): Promise<WhatsAppConnectionView | null> {
  const row = await prisma.whatsAppConnection.findUnique({ where: { influencerId } });
  if (!row) return null;
  const templates = viewTemplates(row.templates);
  const subscribed = row.webhookSubscribedAt !== null;
  // The pages show lastError field by field, so the live-updates note rides along with it (only while the connection
  // is healthy: an errored one has a bigger problem to show).
  const webhookNote =
    subscribed || row.status !== "ACTIVE"
      ? null
      : `Meta is not sending us live updates${row.webhookError ? ` (${row.webhookError})` : " yet"}, so template approvals only change when you press Check template status.`;
  return {
    displayPhone: row.displayPhone,
    verifiedName: row.verifiedName,
    source: row.source,
    status: row.status,
    lastError: [row.lastError, webhookNote].filter(Boolean).join(" ") || null,
    connectedAt: row.connectedAt,
    templates,
    ready: row.status === "ACTIVE" && templates.every((t) => isApproved(t.status)),
    webhook: { subscribed, error: row.webhookError },
  };
}

/** Connections that are healthy but still have templates that are not approved: the ones worth asking Meta about. */
export async function connectionsAwaitingTemplates(): Promise<string[]> {
  const rows = await prisma.whatsAppConnection.findMany({ where: { status: "ACTIVE" }, select: { influencerId: true, templates: true } });
  return rows.filter((r) => !viewTemplates(r.templates).every((t) => isApproved(t.status))).map((r) => r.influencerId);
}

export interface SendCredentials {
  token: string;
  phoneNumberId: string;
}

/**
 * Credentials to send an influencer's customer messages with. Their own connected number when it is healthy;
 * otherwise a WhatsAppNotConnectedError so the message falls back to SMS (never a surprise message from the
 * platform's number, unless WHATSAPP_PLATFORM_FALLBACK=true is set for testing). In MESSAGING_DRY_RUN nothing is
 * sent, so no connection is needed.
 */
export async function resolveSendCredentials(influencerId: string, env = process.env): Promise<SendCredentials | undefined> {
  if (env.MESSAGING_DRY_RUN === "true") return undefined;
  const row = await prisma.whatsAppConnection.findUnique({ where: { influencerId } });
  if (row && row.status === "ACTIVE") return { token: decryptSecret(row.tokenEnc, aad(influencerId)), phoneNumberId: row.phoneNumberId };
  if (env.WHATSAPP_PLATFORM_FALLBACK === "true" && env.WHATSAPP_TOKEN && env.WHATSAPP_PHONE_NUMBER_ID) return undefined;
  throw new WhatsAppNotConnectedError(row ? "The influencer's WhatsApp connection needs to be renewed" : "The influencer has not connected WhatsApp");
}

/** Meta rejected the token. Flags the connection once (returns true for the call that flipped it) so the influencer is alerted once. */
export async function markTokenInvalid(influencerId: string, reason: string, alert: typeof alertInfluencer = alertInfluencer): Promise<boolean> {
  const { count } = await prisma.whatsAppConnection.updateMany({ where: { influencerId, status: "ACTIVE" }, data: { status: "ERROR", lastError: reason.slice(0, 300) } });
  if (count > 0) {
    await alert(influencerId, {
      kind: "whatsapp-reconnect-needed",
      detail: `WhatsApp stopped accepting your connection (${reason.slice(0, 120)}). Customer messages are going out by SMS until you reconnect.`,
      actionUrl: undefined,
    });
  }
  return count > 0;
}

/**
 * Re-reads template statuses from Meta and submits any that are missing. Also tries again to subscribe to Meta's
 * webhooks when that has not worked yet (connections made before it was recorded, or a failure on connect).
 */
export async function refreshTemplates(influencerId: string, deps: ConnectDeps = defaultDeps) {
  const row = await prisma.whatsAppConnection.findUnique({ where: { influencerId } });
  if (!row) throw new WhatsAppConnectError("WhatsApp is not connected.", 404);
  try {
    const token = decryptSecret(row.tokenEnc, aad(influencerId));
    const sync = await deps.ensureTemplates(row.wabaId, token, language());
    const webhook = row.webhookSubscribedAt ? {} : await subscribeWebhooks(row.wabaId, token, deps);
    await prisma.whatsAppConnection.update({
      where: { influencerId },
      data: {
        templates: sync.templates,
        templatesSyncedAt: new Date(),
        // An errored connection keeps the reason it errored.
        ...(row.status === "ACTIVE" ? { lastError: sync.failed.length ? `Could not submit: ${sync.failed.map((f) => f.name).join(", ")}` : null } : {}),
        ...webhook,
      },
    });
    return { submitted: sync.submitted, failed: sync.failed };
  } catch (e) {
    if (e instanceof WhatsAppGraphError && e.invalidToken) await markTokenInvalid(influencerId, e.message);
    throw friendly(e);
  }
}

export async function disconnect(influencerId: string): Promise<boolean> {
  const { count } = await prisma.whatsAppConnection.deleteMany({ where: { influencerId } });
  return count > 0;
}

/** Applies a `message_template_status_update` webhook event. Unknown accounts and templates are ignored. */
export async function applyTemplateStatusUpdate(update: { wabaId: string; name: string; language: string; status: string; reason?: string | null }): Promise<boolean> {
  // Meta reports its own name (booking_confirmation); we store by our key (booking-confirmation).
  const key = templateKeyFromMetaName(update.name);
  if (!key) return false;
  const rows = await prisma.whatsAppConnection.findMany({ where: { wabaId: update.wabaId } });
  let changed = false;
  for (const row of rows) {
    const stored = ((row.templates && typeof row.templates === "object" ? row.templates : {}) as StoredTemplates);
    stored[key] = { status: update.status, ...(update.reason ? { reason: update.reason } : {}) };
    await prisma.whatsAppConnection.update({ where: { id: row.id }, data: { templates: stored } });
    changed = true;
  }
  return changed;
}

export { listTemplates };
