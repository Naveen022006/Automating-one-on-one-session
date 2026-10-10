import { randomInt } from "node:crypto";
import { alertInfluencer } from "@/lib/alerts";
import { decryptSecret, encryptSecret } from "@/lib/crypto";
import { prisma } from "@/lib/db";
import { RESET_PIN_LABEL } from "@/lib/whatsapp-copy";
import { TEMPLATE_SPECS, isSendableStatus, templateKeyFromMetaName, templateState, type TemplateState } from "@/lib/message-templates";
import {
  WhatsAppGraphError,
  ensureTemplates,
  exchangeEmbeddedCode,
  checkTokenInfo,
  getPhoneNumber,
  inspectToken,
  listTemplates,
  registerNumber,
  setTwoStepPin,
  subscribeApp,
  wabaOwnsNumber,
  type PhoneNumberInfo,
  type SubscriptionResult,
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
    /** The number's two-step PIN is one we do not know, and the influencer may choose to have it reset (resetPin). */
    readonly canReset = false,
  ) {
    super(message);
  }
}

/** The influencer has no usable WhatsApp connection, so the message goes to the SMS fallback instead. */
export class WhatsAppNotConnectedError extends Error {}

const aad = (influencerId: string) => `whatsapp:${influencerId}`;
/** Shared with the key-rotation tool (lib/key-rotation-db.ts), so the two can never disagree on the AAD. */
export { aad as whatsappTokenAad };
/**
 * The two-step PIN belongs to the PHONE NUMBER (Meta keeps it on the number), not to a connection or an influencer, so
 * its AAD is the phone number id (also listed for key rotation).
 */
const pinAad = (phoneNumberId: string) => `whatsapp-pin-number:${phoneNumberId}`;
export { pinAad as whatsappPinAad };
/** The AAD of the superseded whatsapp_connections.registration_pin_enc, which was bound to the influencer. */
const legacyPinAad = (influencerId: string) => `whatsapp-pin:${influencerId}`;
export { legacyPinAad as whatsappLegacyPinAad };
const language = () => process.env.WHATSAPP_TEMPLATE_LANGUAGE || "en";

export interface ConnectDeps {
  getPhoneNumber: (phoneNumberId: string, token: string) => Promise<PhoneNumberInfo>;
  wabaOwnsNumber: (wabaId: string, phoneNumberId: string, token: string) => Promise<boolean>;
  ensureTemplates: (wabaId: string, token: string, language: string) => Promise<TemplateSyncResult>;
  exchangeCode: (code: string) => Promise<string>;
  /** Subscribes to the account's webhooks and says whether OUR app is the subscribed one (see subscribeApp). */
  subscribeApp: (wabaId: string, token: string) => Promise<SubscriptionResult>;
  registerNumber: (phoneNumberId: string, token: string, pin: string) => Promise<void>;
  /** Sets the two-step PIN of a registered number to `pin`, whatever it was (Meta's set-PIN call). */
  setPin: (phoneNumberId: string, token: string, pin: string) => Promise<void>;
  /** Meta's view of the token (permissions, expiry). Throws when Meta cannot say; null when it was not asked. */
  inspectToken: (token: string) => Promise<TokenInfo | null>;
}

const defaultDeps: ConnectDeps = {
  getPhoneNumber: (id, t) => getPhoneNumber(id, t),
  wabaOwnsNumber: (w, p, t) => wabaOwnsNumber(w, p, t),
  ensureTemplates: (w, t, l) => ensureTemplates(w, t, l),
  exchangeCode: (c) => exchangeEmbeddedCode(c),
  subscribeApp: (w, t) => subscribeApp(w, t),
  registerNumber: (p, t, pin) => registerNumber(p, t, pin),
  setPin: (p, t, pin) => setTwoStepPin(p, t, pin),
  inspectToken: (t) => inspectToken(t),
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

interface StoredPin {
  pin: string;
  /** We generated it (so we may reset it with Meta); false = the influencer typed it (we never overwrite that). */
  generated: boolean;
}

/** What is saved for a number: its PIN, nothing, or a row that cannot be decrypted with the keys we have (so what the number holds is unknown). */
type PinLookup = ({ kind: "found" } & StoredPin) | { kind: "none" } | { kind: "unreadable" };

async function lookupPinRow(phoneNumberId: string): Promise<PinLookup> {
  const row = await prisma.whatsAppRegistrationPin.findUnique({ where: { phoneNumberId } });
  if (!row) return { kind: "none" };
  try {
    return { kind: "found", pin: decryptSecret(row.pinEnc, pinAad(phoneNumberId)), generated: row.generated };
  } catch {
    return { kind: "unreadable" };
  }
}

/**
 * What is saved for this number. A reconnect must register with the same PIN, so it is read from a table that does not
 * depend on a connection existing. A PIN saved only on a connection row by the earlier version of this code
 * (whatsapp_connections.registration_pin_enc) is moved across the first time it is needed.
 */
async function findPin(influencerId: string, phoneNumberId: string): Promise<PinLookup> {
  const saved = await lookupPinRow(phoneNumberId);
  if (saved.kind !== "none") return saved;
  const old = await prisma.whatsAppConnection.findUnique({ where: { influencerId }, select: { phoneNumberId: true, registrationPinEnc: true } });
  if (!old || old.phoneNumberId !== phoneNumberId || !old.registrationPinEnc) return { kind: "none" };
  try {
    // The old column also held PINs the influencer typed, and nothing says which was which, so none of them is ours to reset.
    const pin = decryptSecret(old.registrationPinEnc, legacyPinAad(influencerId));
    await savePin(phoneNumberId, pin, false, false);
    return { kind: "found", pin, generated: false };
  } catch {
    return { kind: "none" };
  }
}

/** The PIN this number was last registered with, or null (also when it is saved but cannot be read). */
export async function getRegistrationPin(influencerId: string, phoneNumberId: string): Promise<StoredPin | null> {
  const found = await findPin(influencerId, phoneNumberId);
  return found.kind === "found" ? { pin: found.pin, generated: found.generated } : null;
}

/** Saves the PIN for a number. `replace` overwrites one already there; otherwise an existing PIN is left alone. */
async function savePin(phoneNumberId: string, pin: string, generated: boolean, replace: boolean): Promise<void> {
  const pinEnc = encryptSecret(pin, pinAad(phoneNumberId));
  await prisma.whatsAppRegistrationPin.upsert({
    where: { phoneNumberId },
    create: { phoneNumberId, pinEnc, generated },
    update: replace ? { pinEnc, generated } : {},
  });
}

/** Unique-constraint violation (Prisma P2002), without importing the generated client's error classes. */
const isUniqueViolation = (e: unknown) => typeof e === "object" && e !== null && (e as { code?: string }).code === "P2002";

interface PinPlan extends StoredPin {
  /** We made this PIN up just now (there was none saved for the number), as opposed to reading one saved earlier. */
  created: boolean;
}

/**
 * The PIN to register `phoneNumberId` with when the influencer did not type one: the one saved for the number, else a new
 * one (a development default from WHATSAPP_REGISTRATION_PIN, never in production where one shared PIN would become every
 * influencer's two-step PIN, else random). A new PIN is SAVED here, before anything is sent to Meta: once registered, the
 * number holds it and only this row can tell us what it is. Two connects racing on one number agree on the first saved.
 */
async function pinToRegister(influencerId: string, phoneNumberId: string, env: NodeJS.ProcessEnv, resetPin: boolean): Promise<PinPlan> {
  const saved = await findPin(influencerId, phoneNumberId);
  if (saved.kind === "found") return { pin: saved.pin, generated: saved.generated, created: false };

  const dev = env.WHATSAPP_REGISTRATION_PIN?.trim();
  const pin = env.NODE_ENV !== "production" && dev && PIN.test(dev) ? dev : generateRegistrationPin();

  if (saved.kind === "unreadable") {
    // Something is saved for this number but not with a key we have, so what it holds is unknown. Writing a new PIN over
    // it is the owner's choice (they opted in to a reset); otherwise they are asked, not overwritten.
    if (!resetPin) throw unreadablePinError();
    await savePin(phoneNumberId, pin, true, true);
    return { pin, generated: true, created: true };
  }

  try {
    await prisma.whatsAppRegistrationPin.create({ data: { phoneNumberId, pinEnc: encryptSecret(pin, pinAad(phoneNumberId)), generated: true } });
    return { pin, generated: true, created: true };
  } catch (e) {
    if (!isUniqueViolation(e)) throw e;
    // Another connect for this number saved one first: use that.
    const winner = await lookupPinRow(phoneNumberId);
    if (winner.kind === "found") return { pin: winner.pin, generated: winner.generated, created: false };
    throw winner.kind === "unreadable" ? unreadablePinError() : e;
  }
}

/** Where to look when a number's two-step PIN is not one we know. */
const FIND_PIN = "Open WhatsApp Manager, choose this phone number and look for Two-step verification in its settings, where the PIN can be changed.";

/** A PIN is saved for this number but cannot be decrypted (a key was lost), so it can neither be used nor safely replaced unasked. */
function unreadablePinError(): WhatsAppConnectError {
  return new WhatsAppConnectError(
    `The PIN we saved for this number can no longer be read, so we do not know what it is. Enter the number's current two-step verification PIN in the PIN field and connect again. If you do not have it, tick "${RESET_PIN_LABEL}" and connect again: we will then set a new PIN on the number. To look for it yourself, ${FIND_PIN}`,
    400,
    "pin",
    true,
  );
}

/**
 * Registering a number whose two-step PIN differs from the one we sent is refused by Meta. Say so in a way the
 * influencer can act on: they can type the PIN, and, when it is a PIN we may replace, choose to have it reset.
 */
function registrationError(e: unknown, supplied: boolean, canReset = false): WhatsAppConnectError {
  if (e instanceof WhatsAppGraphError && e.pinMismatch) {
    if (supplied) {
      return new WhatsAppConnectError(`That two-step verification PIN does not match the one set on this number. Check it and try again. If you have forgotten it, ${FIND_PIN}`, 400, "pin");
    }
    return new WhatsAppConnectError(
      canReset
        ? `This number already has a two-step verification PIN that we do not know. Enter it in the PIN field and connect again. If you do not have it, tick "${RESET_PIN_LABEL}" and connect again: we will then set a new PIN on the number. To look for it yourself, ${FIND_PIN}`
        : `The two-step verification PIN we have for this number no longer matches the one on it. Enter its current PIN in the PIN field and connect again. ${FIND_PIN}`,
      400,
      "pin",
      canReset,
    );
  }
  if (e instanceof WhatsAppGraphError && e.pinLocked) {
    return new WhatsAppConnectError("WhatsApp has paused PIN attempts on this number after too many tries. Wait a while, then connect again.", 400, "pin");
  }
  return friendly(e);
}

/**
 * Registers `phoneNumberId` with Meta with its two-step PIN.
 *  - A PIN the influencer typed is used as it is, and kept once it works. If Meta refuses it, that is their PIN to fix.
 *    It is never replaced.
 *  - Otherwise the number's saved PIN (saved before this call) or a new one. If Meta refuses a PIN we just made up, the
 *    number may be one an older version of this app registered with the shared WHATSAPP_REGISTRATION_PIN, so that is tried.
 *  - Still refused: the number has a PIN that is not ours to know. It might be the owner's own (set in WhatsApp Manager,
 *    or by another provider), so it is NOT replaced behind their back: they are asked for it, and offered "reset it for me"
 *    (`resetPin`). Only when they opt in, and only for a PIN we generated ourselves, is it set to ours with Meta's set-PIN
 *    call and registered again.
 */
async function registerWithPin(
  influencerId: string,
  phoneNumberId: string,
  token: string,
  opts: { supplied?: string; resetPin?: boolean; env: NodeJS.ProcessEnv },
  deps: ConnectDeps,
): Promise<void> {
  if (opts.supplied) {
    try {
      await deps.registerNumber(phoneNumberId, token, opts.supplied);
    } catch (e) {
      throw registrationError(e, true);
    }
    await savePin(phoneNumberId, opts.supplied, false, true);
    return;
  }
  const plan = await pinToRegister(influencerId, phoneNumberId, opts.env, opts.resetPin === true);
  try {
    await deps.registerNumber(phoneNumberId, token, plan.pin);
    return;
  } catch (first) {
    if (!(first instanceof WhatsAppGraphError) || !(first.pinMismatch || first.pinLocked)) throw registrationError(first, false);

    if (plan.created && first.pinMismatch) {
      const shared = opts.env.WHATSAPP_REGISTRATION_PIN?.trim();
      if (shared && PIN.test(shared) && shared !== plan.pin) {
        try {
          await deps.registerNumber(phoneNumberId, token, shared);
          await savePin(phoneNumberId, shared, true, true); // that, not the one just made up, is what the number holds
          return;
        } catch (viaShared) {
          if (!(viaShared instanceof WhatsAppGraphError) || !(viaShared.pinMismatch || viaShared.pinLocked)) throw registrationError(viaShared, false);
        }
      }
    }

    if (!(opts.resetPin && plan.generated)) throw registrationError(first, false, plan.generated);
    try {
      await deps.setPin(phoneNumberId, token, plan.pin);
    } catch {
      // The reset was refused: the problem is still the original one (the reset was already chosen, so it is not offered again).
      throw registrationError(first, false, false);
    }
    try {
      await deps.registerNumber(phoneNumberId, token, plan.pin);
    } catch (second) {
      // The PIN WAS reset, so what went wrong now is something else (Meta busy, a timeout): say that, not the old mismatch.
      throw registrationError(second, false, false);
    }
  }
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

/**
 * Subscribes to the account's webhooks and says how it went, in the shape stored on the connection. "Subscribed" is
 * recorded only when OUR Meta app is the one subscribed (a pasted token usually belongs to the influencer's own app, and
 * subscribing that one sends us nothing); otherwise the reason is recorded and shown.
 */
async function subscribeWebhooks(wabaId: string, token: string, deps: ConnectDeps): Promise<{ webhookSubscribedAt: Date | null; webhookError: string | null }> {
  try {
    const result = await deps.subscribeApp(wabaId, token);
    return result.subscribed ? { webhookSubscribedAt: new Date(), webhookError: null } : { webhookSubscribedAt: null, webhookError: (result.reason ?? "not subscribed").slice(0, 300) };
  } catch (e) {
    const why = e instanceof Error ? e.message : "failed";
    console.error("[whatsapp] could not subscribe to webhooks", why);
    return { webhookSubscribedAt: null, webhookError: why.slice(0, 300) };
  }
}

async function persist(
  influencerId: string,
  c: {
    wabaId: string;
    phoneNumberId: string;
    token: string;
    source: "manual" | "embedded";
    /** Register the number with its two-step PIN: with the one the influencer typed, else the number's own saved or new one. Absent = leave the number as it is. */
    register?: { supplied?: string; resetPin?: boolean; env: NodeJS.ProcessEnv };
  },
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

  // Register after the checks that can refuse the connection, so a number we turn away is not registered. The PIN is
  // saved BEFORE it is sent to Meta (see registerWithPin) and outlives this connection, so nothing between here and the
  // save below, nor a later disconnect, can leave the number holding a PIN we have forgotten.
  if (c.register) await registerWithPin(influencerId, c.phoneNumberId, c.token, c.register, deps);

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
  return persist(influencerId, { wabaId, phoneNumberId, token, source: "manual", register: pin ? { supplied: pin, env: process.env } : undefined }, deps);
}

/** Finish Meta Embedded Signup: exchange the code, subscribe to webhooks, register the number with its own PIN, save. */
export async function connectEmbedded(
  influencerId: string,
  /** `pin`: the number already has a PIN and this is it. `resetPin`: it has one the influencer does not have, and we may set a new one. */
  input: { code: string; wabaId: string; phoneNumberId: string; pin?: string; resetPin?: boolean },
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
  return persist(influencerId, { wabaId: input.wabaId, phoneNumberId: input.phoneNumberId, token, source: "embedded", register: { supplied, resetPin: input.resetPin === true, env } }, deps);
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

type StoredTemplates = Record<string, { status: string; language?: string; reason?: string | null }>;

export function viewTemplates(raw: unknown): WhatsAppConnectionView["templates"] {
  const stored = (raw && typeof raw === "object" ? raw : {}) as StoredTemplates;
  return Object.keys(TEMPLATE_SPECS).map((name) => ({ name, status: stored[name]?.status ?? "NOT_SUBMITTED", reason: stored[name]?.reason ?? null }));
}

/** Where a connection's stored templates stand (see templateState). */
export function whatsappTemplateState(raw: unknown): TemplateState {
  return templateState(viewTemplates(raw).map((t) => t.status));
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
      : `Live updates from Meta are not available for this connection${row.webhookError ? ` (${row.webhookError})` : " yet"}. Template statuses refresh about every 30 minutes, or when you press Check template status.`;
  return {
    displayPhone: row.displayPhone,
    verifiedName: row.verifiedName,
    source: row.source,
    status: row.status,
    lastError: [row.lastError, webhookNote].filter(Boolean).join(" ") || null,
    connectedAt: row.connectedAt,
    templates,
    ready: row.status === "ACTIVE" && templates.every((t) => isSendableStatus(t.status)),
    webhook: { subscribed, error: row.webhookError },
  };
}

/** Connections that are healthy but still have templates that are not approved: the ones worth asking Meta about. */
export async function connectionsAwaitingTemplates(): Promise<string[]> {
  const rows = await prisma.whatsAppConnection.findMany({ where: { status: "ACTIVE" }, select: { influencerId: true, templates: true } });
  return rows.filter((r) => whatsappTemplateState(r.templates) !== "ready").map((r) => r.influencerId);
}

export interface SendCredentials {
  token: string;
  phoneNumberId: string;
}

/**
 * Credentials to send an influencer's customer messages with. Their own connected number when it is healthy and, if
 * a `template` is given, that template is approved on their account; otherwise a WhatsAppNotConnectedError saying why,
 * so the message goes straight to SMS (never a surprise message from the platform's number, unless
 * WHATSAPP_PLATFORM_FALLBACK=true is set for testing). In MESSAGING_DRY_RUN nothing is sent, so no connection is needed.
 */
export async function resolveSendCredentials(influencerId: string, env = process.env, template?: string): Promise<SendCredentials | undefined> {
  if (env.MESSAGING_DRY_RUN === "true") return undefined;
  const row = await prisma.whatsAppConnection.findUnique({ where: { influencerId } });
  if (row && row.status === "ACTIVE") {
    // Meta refuses a template message whose template is not approved, so do not try: it would only fail, and leave a
    // failed WhatsApp row behind for every message.
    if (template) {
      const status = viewTemplates(row.templates).find((t) => t.name === template)?.status ?? "NOT_SUBMITTED";
      if (!isSendableStatus(status)) throw new WhatsAppNotConnectedError(`The "${template}" WhatsApp template is not approved yet (${status})`);
    }
    return { token: decryptSecret(row.tokenEnc, aad(influencerId)), phoneNumberId: row.phoneNumberId };
  }
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
    // Only what Meta said is translated for the influencer. Anything else (the stored token no longer decrypts after a key
    // rotation, the database failed) is OUR problem: it must not read as "Could not reach WhatsApp", and the worker's
    // template sync reports it (worker/whatsapp-sync.ts) because it is not a WhatsAppConnectError.
    if (e instanceof WhatsAppConnectError) throw e;
    if (!(e instanceof WhatsAppGraphError)) throw e;
    if (e.invalidToken) await markTokenInvalid(influencerId, e.message);
    throw friendly(e);
  }
}

export async function disconnect(influencerId: string): Promise<boolean> {
  const { count } = await prisma.whatsAppConnection.deleteMany({ where: { influencerId } });
  return count > 0;
}

/**
 * Applies a `message_template_status_update` webhook event. Unknown accounts, templates and languages are ignored: a
 * template is one name in one language, and the same name in another language (an influencer can add their own) says
 * nothing about the one we send.
 */
export async function applyTemplateStatusUpdate(update: { wabaId: string; name: string; language: string; status: string; reason?: string | null }): Promise<boolean> {
  // Meta reports its own name (booking_confirmation); we store by our key (booking-confirmation).
  const key = templateKeyFromMetaName(update.name);
  if (!key || update.language !== language()) return false;
  const rows = await prisma.whatsAppConnection.findMany({ where: { wabaId: update.wabaId } });
  let changed = false;
  for (const row of rows) {
    const stored = ((row.templates && typeof row.templates === "object" ? row.templates : {}) as StoredTemplates);
    // A template we refused to adopt (a wrong number of variables under our name) stays refused: Meta approving it says
    // nothing about our parameters fitting it. The next sync, which reads its text again, is what clears the conflict.
    if (stored[key]?.status === "CONFLICT") continue;
    stored[key] = { status: update.status, language: update.language, ...(update.reason ? { reason: update.reason } : {}) };
    await prisma.whatsAppConnection.update({ where: { id: row.id }, data: { templates: stored } });
    changed = true;
  }
  return changed;
}

export { listTemplates };
