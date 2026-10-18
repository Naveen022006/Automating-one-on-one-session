import { prisma } from "@/lib/db";
import { readQrConfig } from "./config";
import { getKv, istDate, kvKeys, QR_TTL_MS, type EphemeralKv } from "./kv";
import { renderQrSvg } from "./qr-svg";
import { CONSENT_VERSION, RISK_TEXT, type WhatsAppWebStatus, type WhatsAppWebView } from "./types";

/**
 * What the WEB side does with the QR-code WhatsApp mode (the dashboard endpoints call these). Web instances never open a socket:
 * they write what the influencer asked for (`wantLinked`, with the consent) and read what the worker published (the status in
 * Postgres, the current QR code in Redis). The worker's manager (worker/whatsapp-web-manager.ts) makes the world match.
 *
 * Nothing here returns the stored login, a token or anything about a customer. Every function takes the influencer id from the
 * authenticated session, never from the request body.
 */

export type CommandResult = { ok: true } | { ok: false; code: "disabled" | "consent-required" | "consent-outdated" | "not-pending"; message: string };

const STATUS: Record<string, WhatsAppWebStatus> = {
  NOT_LINKED: "not-linked",
  PENDING_QR: "waiting-for-scan",
  LINKED: "linked",
  RECONNECTING: "reconnecting",
  SUSPENDED: "suspended",
  LOGGED_OUT: "logged-out",
};

/** "+919876543210" -> "+91 ••••• ••210": enough to recognise the number, not enough to copy it. */
export function maskPhone(e164: string | null | undefined): string | null {
  const digits = e164?.replace(/\D/g, "");
  if (!digits || digits.length < 6) return null;
  return `+${digits.slice(0, 2)} ${"•".repeat(Math.max(3, digits.length - 5))} ${digits.slice(-3)}`;
}

interface StoredQr {
  qr: string;
  issuedAt: number;
}

async function readQr(kv: EphemeralKv, influencerId: string): Promise<StoredQr | null> {
  try {
    const raw = await kv.get(kvKeys.qr(influencerId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<StoredQr>;
    return typeof parsed.qr === "string" && typeof parsed.issuedAt === "number" ? { qr: parsed.qr, issuedAt: parsed.issuedAt } : null;
  } catch {
    return null;
  }
}

async function managerAlive(kv: EphemeralKv): Promise<boolean> {
  try {
    return (await kv.get("wa-web:manager:alive")) !== null;
  } catch {
    return true; // can't tell: do not raise a false alarm
  }
}

/** The dashboard view of the influencer's QR-code WhatsApp. Built field by field. */
export async function getWhatsAppWebView(influencerId: string, opts: { kv?: EphemeralKv; now?: () => number } = {}): Promise<WhatsAppWebView> {
  const cfg = readQrConfig();
  const kv = opts.kv ?? getKv();
  const now = (opts.now ?? Date.now)();

  const [row, official] = await Promise.all([
    prisma.whatsAppWebSession.findUnique({
      where: { influencerId },
      select: {
        status: true,
        wantLinked: true,
        phoneE164: true,
        deviceLabel: true,
        consentAt: true,
        lastErrorCode: true,
        lastErrorText: true,
        suspendedReason: true,
      },
    }),
    prisma.whatsAppConnection.findUnique({ where: { influencerId }, select: { status: true } }),
  ]);

  const base: WhatsAppWebView = {
    enabled: cfg.enabled,
    fake: cfg.fake,
    status: "not-linked",
    phoneMasked: null,
    deviceLabel: null,
    qrSvg: null,
    qrExpiresAt: null,
    consentAt: row?.consentAt?.toISOString() ?? null,
    consentVersion: CONSENT_VERSION,
    riskText: RISK_TEXT,
    dailyCap: cfg.dailyCap,
    sentToday: 0,
    lastError: null,
    suspendedReason: null,
    officialConnected: official?.status === "ACTIVE",
  };
  if (!cfg.enabled || !row) return base;

  // The influencer pressed disconnect or cancel and the worker has not finished: show it as already gone.
  const leaving = !row.wantLinked && row.status !== "NOT_LINKED" && row.status !== "LOGGED_OUT";
  const status = leaving ? "not-linked" : (STATUS[row.status] ?? "not-linked");
  const view: WhatsAppWebView = {
    ...base,
    status,
    phoneMasked: leaving ? null : maskPhone(row.phoneE164),
    deviceLabel: leaving ? null : row.deviceLabel,
    lastError: row.lastErrorCode ? { code: row.lastErrorCode, text: row.lastErrorText ?? "" } : null,
    suspendedReason: status === "suspended" ? row.suspendedReason : null,
  };

  if (status === "linked" || status === "reconnecting" || status === "suspended") {
    try {
      view.sentToday = await kv.getInt(kvKeys.sent(influencerId, istDate(now)));
    } catch {
      view.sentToday = 0;
    }
  }

  if (status === "waiting-for-scan") {
    const qr = await readQr(kv, influencerId);
    if (qr && qr.issuedAt + QR_TTL_MS > now) {
      view.qrSvg = renderQrSvg(qr.qr);
      view.qrExpiresAt = new Date(qr.issuedAt + QR_TTL_MS).toISOString();
    }
  }

  // Asked for, but nobody is looking after it: say so instead of leaving a spinner. Only meaningful with a shared store.
  if (row.wantLinked && (status === "not-linked" || status === "waiting-for-scan") && process.env.REDIS_URL && !(await managerAlive(kv))) {
    view.lastError = { code: "worker-not-running", text: "The background worker is not running, so the link cannot start. Try again in a minute, or contact support." };
  }
  return view;
}

/** "Link my WhatsApp": records the consent and asks the worker to start. */
export async function requestLink(influencerId: string, input: { consent: unknown; consentVersion: unknown }): Promise<CommandResult> {
  if (!readQrConfig().enabled) return { ok: false, code: "disabled", message: "Linking WhatsApp by QR code is not available." };
  if (input.consent !== true) return { ok: false, code: "consent-required", message: "Please confirm that you understand the risks." };
  if (input.consentVersion !== CONSENT_VERSION) return { ok: false, code: "consent-outdated", message: "The risk statement changed. Please read it again and confirm." };

  const now = new Date();
  const existing = await prisma.whatsAppWebSession.findUnique({ where: { influencerId }, select: { status: true, wantLinked: true } });
  if (existing?.wantLinked && (existing.status === "PENDING_QR" || existing.status === "LINKED" || existing.status === "RECONNECTING")) {
    return { ok: true }; // already under way: pressing start twice changes nothing
  }
  const reset = {
    wantLinked: true,
    consentAt: now,
    consentVersion: CONSENT_VERSION,
    status: "NOT_LINKED" as const,
    suspendedReason: null,
    lastErrorCode: null,
    lastErrorText: null,
    consecutiveFailures: 0,
  };
  await prisma.whatsAppWebSession.upsert({
    where: { influencerId },
    create: { influencerId, ...reset },
    update: reset,
  });
  return { ok: true };
}

/** Gives up a linking attempt that has not been scanned. */
export async function cancelLink(influencerId: string): Promise<CommandResult> {
  const row = await prisma.whatsAppWebSession.findUnique({ where: { influencerId }, select: { status: true, wantLinked: true } });
  if (!row || !row.wantLinked) return { ok: true };
  if (row.status !== "NOT_LINKED" && row.status !== "PENDING_QR") {
    return { ok: false, code: "not-pending", message: "This number is already linked. Use disconnect instead." };
  }
  await prisma.whatsAppWebSession.updateMany({ where: { influencerId }, data: { wantLinked: false } });
  return { ok: true };
}

/** Disconnects the number: the worker unlinks the device on the phone's side and deletes the stored login. */
export async function disconnectLink(influencerId: string): Promise<CommandResult> {
  await prisma.whatsAppWebSession.updateMany({ where: { influencerId }, data: { wantLinked: false } });
  return { ok: true };
}
