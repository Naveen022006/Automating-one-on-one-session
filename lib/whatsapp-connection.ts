import { alertInfluencer } from "@/lib/alerts";
import { decryptSecret, encryptSecret } from "@/lib/crypto";
import { prisma } from "@/lib/db";
import { TEMPLATE_SPECS } from "@/lib/message-templates";
import {
  WhatsAppGraphError,
  ensureTemplates,
  exchangeEmbeddedCode,
  getPhoneNumber,
  isApproved,
  listTemplates,
  registerNumber,
  subscribeApp,
  wabaOwnsNumber,
  type PhoneNumberInfo,
  type TemplateSyncResult,
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
const language = () => process.env.WHATSAPP_TEMPLATE_LANGUAGE || "en";

export interface ConnectDeps {
  getPhoneNumber: (phoneNumberId: string, token: string) => Promise<PhoneNumberInfo>;
  wabaOwnsNumber: (wabaId: string, phoneNumberId: string, token: string) => Promise<boolean>;
  ensureTemplates: (wabaId: string, token: string, language: string) => Promise<TemplateSyncResult>;
  exchangeCode: (code: string) => Promise<string>;
  subscribeApp: (wabaId: string, token: string) => Promise<void>;
  registerNumber: (phoneNumberId: string, token: string, pin: string) => Promise<void>;
}

const defaultDeps: ConnectDeps = {
  getPhoneNumber: (id, t) => getPhoneNumber(id, t),
  wabaOwnsNumber: (w, p, t) => wabaOwnsNumber(w, p, t),
  ensureTemplates: (w, t, l) => ensureTemplates(w, t, l),
  exchangeCode: (c) => exchangeEmbeddedCode(c),
  subscribeApp: (w, t) => subscribeApp(w, t),
  registerNumber: (p, t, pin) => registerNumber(p, t, pin),
};

const ID = /^\d{5,30}$/;

function friendly(e: unknown): WhatsAppConnectError {
  if (e instanceof WhatsAppConnectError) return e;
  if (e instanceof WhatsAppGraphError) {
    if (e.invalidToken) return new WhatsAppConnectError("Meta rejected that access token. Check it is a permanent token with WhatsApp permissions.", 400, "accessToken");
    return new WhatsAppConnectError(`WhatsApp said: ${e.message}`, e.status >= 500 || e.status === 0 ? 502 : 400);
  }
  return new WhatsAppConnectError("Could not reach WhatsApp. Please try again.", 502);
}

async function persist(
  influencerId: string,
  c: { wabaId: string; phoneNumberId: string; token: string; source: "manual" | "embedded" },
  deps: ConnectDeps,
): Promise<WhatsAppConnectionView> {
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
    source: c.source,
    status: "ACTIVE" as const,
    lastError: sync && sync.failed.length ? `Could not submit: ${sync.failed.map((f) => f.name).join(", ")}` : null,
    ...(sync ? { templates: sync.templates, templatesSyncedAt: new Date() } : {}),
  };
  await prisma.whatsAppConnection.upsert({ where: { influencerId }, create: { influencerId, ...data }, update: { ...data, connectedAt: new Date() } });
  return (await getConnectionView(influencerId))!;
}

/** Connect by entering the ids and a permanent system-user token. Verified with Meta before anything is saved. */
export async function connectManual(
  influencerId: string,
  input: { wabaId: string; phoneNumberId: string; accessToken: string },
  deps: ConnectDeps = defaultDeps,
) {
  const wabaId = input.wabaId.trim();
  const phoneNumberId = input.phoneNumberId.trim();
  const token = input.accessToken.trim();
  if (!ID.test(wabaId)) throw new WhatsAppConnectError("The WhatsApp Business Account id is a number, like 104857392010394.", 400, "wabaId");
  if (!ID.test(phoneNumberId)) throw new WhatsAppConnectError("The phone number id is a number, like 109283746501928.", 400, "phoneNumberId");
  if (token.length < 20 || /\s/.test(token)) throw new WhatsAppConnectError("Paste the full access token.", 400, "accessToken");
  return persist(influencerId, { wabaId, phoneNumberId, token, source: "manual" }, deps);
}

/** Finish Meta Embedded Signup: exchange the code, subscribe to webhooks, register the number, save. */
export async function connectEmbedded(
  influencerId: string,
  input: { code: string; wabaId: string; phoneNumberId: string },
  deps: ConnectDeps = defaultDeps,
  env = process.env,
) {
  if (!ID.test(input.wabaId) || !ID.test(input.phoneNumberId)) throw new WhatsAppConnectError("WhatsApp did not return your account details. Please try again.", 400);
  let token: string;
  try {
    token = await deps.exchangeCode(input.code);
    await deps.subscribeApp(input.wabaId, token);
    if (env.WHATSAPP_REGISTRATION_PIN) await deps.registerNumber(input.phoneNumberId, token, env.WHATSAPP_REGISTRATION_PIN);
  } catch (e) {
    throw friendly(e);
  }
  return persist(influencerId, { wabaId: input.wabaId, phoneNumberId: input.phoneNumberId, token, source: "embedded" }, deps);
}

export interface WhatsAppConnectionView {
  displayPhone: string | null;
  verifiedName: string | null;
  source: string;
  status: "ACTIVE" | "ERROR";
  lastError: string | null;
  connectedAt: Date;
  templates: { name: string; status: string; reason: string | null }[];
  /** Every template we send is approved: WhatsApp messages will actually go out. */
  ready: boolean;
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
  return {
    displayPhone: row.displayPhone,
    verifiedName: row.verifiedName,
    source: row.source,
    status: row.status,
    lastError: row.lastError,
    connectedAt: row.connectedAt,
    templates,
    ready: row.status === "ACTIVE" && templates.every((t) => isApproved(t.status)),
  };
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

/** Re-reads template statuses from Meta and submits any that are missing. */
export async function refreshTemplates(influencerId: string, deps: ConnectDeps = defaultDeps) {
  const row = await prisma.whatsAppConnection.findUnique({ where: { influencerId } });
  if (!row) throw new WhatsAppConnectError("WhatsApp is not connected.", 404);
  try {
    const sync = await deps.ensureTemplates(row.wabaId, decryptSecret(row.tokenEnc, aad(influencerId)), language());
    await prisma.whatsAppConnection.update({
      where: { influencerId },
      data: {
        templates: sync.templates,
        templatesSyncedAt: new Date(),
        lastError: sync.failed.length ? `Could not submit: ${sync.failed.map((f) => f.name).join(", ")}` : null,
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
  if (!(update.name in TEMPLATE_SPECS)) return false;
  const rows = await prisma.whatsAppConnection.findMany({ where: { wabaId: update.wabaId } });
  let changed = false;
  for (const row of rows) {
    const stored = ((row.templates && typeof row.templates === "object" ? row.templates : {}) as StoredTemplates);
    stored[update.name] = { status: update.status, ...(update.reason ? { reason: update.reason } : {}) };
    await prisma.whatsAppConnection.update({ where: { id: row.id }, data: { templates: stored } });
    changed = true;
  }
  return changed;
}

export { listTemplates };
