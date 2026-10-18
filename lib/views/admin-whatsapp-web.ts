import { prisma } from "@/lib/db";
import { readQrConfig } from "@/lib/whatsapp-web/config";
import type { AdminWhatsAppWebSummary, AdminWhatsAppWebView } from "@/lib/whatsapp-web/api-types";
import { getKv, istDate, kvKeys, type EphemeralKv } from "@/lib/whatsapp-web/kv";
import { maskE164 } from "@/lib/whatsapp-web/mask";
import type { WhatsAppWebStatus } from "@/lib/whatsapp-web/types";

/**
 * The administrator's view of QR-linked WhatsApp numbers (served by GET /api/admin/whatsapp-web and
 * /api/admin/whatsapp-web/:influencerId; the caller has passed `requireAdminMfa()`).
 *
 * Built field by field. Never in here: the stored login, the QR code, the full phone number (a masked tail only), a message text or
 * a customer.
 */

const STATUS: Record<string, WhatsAppWebStatus> = {
  NOT_LINKED: "not-linked",
  PENDING_QR: "waiting-for-scan",
  LINKED: "linked",
  RECONNECTING: "reconnecting",
  SUSPENDED: "suspended",
  LOGGED_OUT: "logged-out",
};

/** Null when there is no such influencer (the caller answers 404). An influencer who never linked gets a "not-linked" view. */
export async function loadAdminWhatsAppWebView(influencerId: string, opts: { kv?: EphemeralKv; now?: () => number } = {}): Promise<AdminWhatsAppWebView | null> {
  const influencer = await prisma.influencer.findUnique({
    where: { id: influencerId },
    select: {
      id: true,
      whatsappWebSession: {
        select: {
          status: true,
          wantLinked: true,
          phoneE164: true,
          deviceLabel: true,
          consentAt: true,
          consentVersion: true,
          linkedAt: true,
          lastConnectedAt: true,
          lastErrorCode: true,
          lastErrorText: true,
          suspendedReason: true,
          sentTotal: true,
          authStateEnc: true,
        },
      },
    },
  });
  if (!influencer) return null;
  const cfg = readQrConfig();
  const row = influencer.whatsappWebSession;
  const status = row ? (STATUS[row.status] ?? "not-linked") : "not-linked";

  let sentToday = 0;
  if (row && (status === "linked" || status === "reconnecting" || status === "suspended")) {
    try {
      sentToday = await (opts.kv ?? getKv()).getInt(kvKeys.sent(influencerId, istDate((opts.now ?? Date.now)())));
    } catch {
      sentToday = 0;
    }
  }

  return {
    influencerId,
    enabled: cfg.enabled,
    status,
    wantLinked: row?.wantLinked ?? false,
    phoneMasked: maskE164(row?.phoneE164),
    deviceLabel: row?.deviceLabel ?? null,
    consentAt: row?.consentAt?.toISOString() ?? null,
    consentVersion: row?.consentVersion ?? null,
    linkedAt: row?.linkedAt?.toISOString() ?? null,
    lastConnectedAt: row?.lastConnectedAt?.toISOString() ?? null,
    sentToday,
    dailyCap: cfg.dailyCap,
    sentTotal: row?.sentTotal ?? 0,
    lastError: row?.lastErrorCode ? { code: row.lastErrorCode, text: row.lastErrorText ?? "" } : null,
    suspendedReason: status === "suspended" ? (row?.suspendedReason ?? null) : null,
    // The same condition the force-disconnect update uses; the stored login itself is only checked for existing, never sent.
    canForceDisconnect: Boolean(row && (row.wantLinked || row.authStateEnc !== null)),
  };
}

/** How many numbers are in each state, platform-wide. */
export async function loadAdminWhatsAppWebSummary(): Promise<AdminWhatsAppWebSummary> {
  const groups = await prisma.whatsAppWebSession.groupBy({ by: ["status"], _count: { _all: true } });
  const count = (s: string) => groups.find((g) => g.status === s)?._count._all ?? 0;
  return {
    enabled: readQrConfig().enabled,
    linked: count("LINKED"),
    reconnecting: count("RECONNECTING"),
    suspended: count("SUSPENDED"),
    loggedOut: count("LOGGED_OUT"),
    waitingForScan: count("PENDING_QR"),
  };
}
