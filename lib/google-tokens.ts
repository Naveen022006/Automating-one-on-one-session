import { prisma } from "@/lib/db";
import { decryptSecret, encryptSecret } from "@/lib/crypto";

export const OAUTH_STATE_PURPOSE = "google-oauth-state";
/** Cookie that binds an OAuth round trip to the browser that started it. */
export const NONCE_COOKIE = "g_oauth_nonce";

/** The AAD the refresh token is encrypted with (also used by the key-rotation tool, lib/key-rotation-db.ts). */
export const googleTokenAad = (influencerId: string) => influencerId;

/** Stores (or replaces) the influencer's grant and clears any "reconnect needed" flag. */
export async function saveGoogleToken(
  influencerId: string,
  refreshToken: string,
  scope: string,
  googleEmail: string | null = null,
): Promise<void> {
  const refreshTokenEnc = encryptSecret(refreshToken, googleTokenAad(influencerId));
  await prisma.googleToken.upsert({
    where: { influencerId },
    create: { influencerId, refreshTokenEnc, scope, googleEmail },
    update: {
      refreshTokenEnc,
      scope,
      googleEmail,
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
  return { state: "ok", refreshToken: decryptSecret(row.refreshTokenEnc, googleTokenAad(influencerId)) };
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

export type GoogleConnectionStatus =
  | { state: "not-connected" }
  | { state: "connected"; email: string | null; connectedAt: Date; gmailSend: boolean }
  | { state: "reconnect-needed"; email: string | null; reason: string | null; since: Date | null };

/** Connection state for the dashboard: Connected as <email> / Reconnect needed (reason) / Not connected. */
export async function getGoogleStatus(influencerId: string): Promise<GoogleConnectionStatus> {
  const row = await prisma.googleToken.findUnique({
    where: { influencerId },
    select: { status: true, googleEmail: true, connectedAt: true, reconnectReason: true, reconnectNeededAt: true, scope: true },
  });
  if (!row) return { state: "not-connected" };
  if (row.status === "RECONNECT_NEEDED") {
    return { state: "reconnect-needed", email: row.googleEmail, reason: row.reconnectReason, since: row.reconnectNeededAt };
  }
  return { state: "connected", email: row.googleEmail, connectedAt: row.connectedAt, gmailSend: row.scope.split(/\s+/).includes("https://www.googleapis.com/auth/gmail.send") };
}

/**
 * Disconnects Google: deletes the stored grant and returns the decrypted refresh token (if readable) so the caller
 * can revoke it at Google. New paid bookings then wait as PAID until the influencer connects again.
 */
export async function deleteGoogleToken(influencerId: string): Promise<string | null> {
  const row = await prisma.googleToken.findUnique({ where: { influencerId } });
  if (!row) return null;
  await prisma.googleToken.delete({ where: { influencerId } });
  try {
    return decryptSecret(row.refreshTokenEnc, googleTokenAad(influencerId));
  } catch {
    return null;
  }
}
