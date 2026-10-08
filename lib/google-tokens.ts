import { prisma } from "@/lib/db";
import { decryptSecret, encryptSecret } from "@/lib/crypto";
import { signToken } from "@/lib/signing";

export const CONNECT_LINK_PURPOSE = "google-connect-link";
export const OAUTH_STATE_PURPOSE = "google-oauth-state";
/** Cookie that binds an OAuth round trip to the browser that started it. */
export const NONCE_COOKIE = "g_oauth_nonce";

/** Stores (or replaces) the influencer's grant and clears any "reconnect needed" flag. */
export async function saveGoogleToken(influencerId: string, refreshToken: string, scope: string): Promise<void> {
  const refreshTokenEnc = encryptSecret(refreshToken, influencerId);
  await prisma.googleToken.upsert({
    where: { influencerId },
    create: { influencerId, refreshTokenEnc, scope },
    update: {
      refreshTokenEnc,
      scope,
      status: "ACTIVE",
      reconnectReason: null,
      reconnectNeededAt: null,
      connectedAt: new Date(),
    },
  });
}

export type TokenLookup =
  | { state: "ok"; refreshToken: string }
  | { state: "not-connected" }
  | { state: "reconnect-needed"; reason: string | null };

export async function getRefreshToken(influencerId: string): Promise<TokenLookup> {
  const row = await prisma.googleToken.findUnique({ where: { influencerId } });
  if (!row) return { state: "not-connected" };
  if (row.status === "RECONNECT_NEEDED") return { state: "reconnect-needed", reason: row.reconnectReason };
  return { state: "ok", refreshToken: decryptSecret(row.refreshTokenEnc, influencerId) };
}

/**
 * Flags the influencer as needing to reconnect. Returns true only for the call that flipped
 * ACTIVE -> RECONNECT_NEEDED, so the caller alerts once per revocation instead of once per failed job.
 */
export async function markReconnectNeeded(influencerId: string, reason: string): Promise<boolean> {
  const { count } = await prisma.googleToken.updateMany({
    where: { influencerId, status: "ACTIVE" },
    data: { status: "RECONNECT_NEEDED", reconnectReason: reason.slice(0, 500), reconnectNeededAt: new Date() },
  });
  return count > 0;
}

/**
 * Signed, expiring link that starts the Google connect flow for one influencer. The flow has no login
 * yet (the dashboard is Phase 6), so possession of this link is what authorises connecting a Google
 * account to an influencer. Without it anyone could attach their own calendar to someone else's bookings.
 */
export function buildConnectUrl(influencerId: string, ttlSec = 7 * 86_400): string {
  const appUrl = process.env.APP_URL;
  if (!appUrl) throw new Error("APP_URL is not set");
  const t = signToken(CONNECT_LINK_PURPOSE, { i: influencerId }, ttlSec);
  return `${appUrl.replace(/\/$/, "")}/api/google/connect?t=${encodeURIComponent(t)}`;
}
