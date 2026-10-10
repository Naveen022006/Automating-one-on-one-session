import { prisma } from "@/lib/db";
import { decryptSecret, encryptSecret } from "@/lib/crypto";
import { requestGmailByDefault } from "@/lib/google";

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

/**
 * Upcoming bookings whose Calendar event lives on the connected Google account (customers' invites included). Switching
 * or disconnecting the account strands them: later reschedules 404, cancels cannot remove the old invite and new group
 * attendees cannot be added. Group attendees count one each, because each booking carries the shared event id.
 */
export async function countLiveCalendarEvents(influencerId: string): Promise<number> {
  return prisma.booking.count({
    where: {
      eventId: { not: null },
      status: { in: ["PAID", "SCHEDULED"] },
      session: { endTime: { gt: new Date() }, service: { influencerId } },
    },
  });
}

/** The Google account the stored grant belongs to (whatever its status), or null if none or unknown. */
export async function getConnectedGoogleEmail(influencerId: string): Promise<string | null> {
  const row = await prisma.googleToken.findUnique({ where: { influencerId }, select: { googleEmail: true } });
  return row?.googleEmail ?? null;
}

/** Only customer emails sent in this long window say anything about whether Gmail sending works right now. */
const GMAIL_FAILURE_WINDOW_MS = 14 * 86_400_000;

/**
 * Whether the Google panel should say "Gmail sending is not working". With Gmail on, every customer email is tried
 * through the influencer's Gmail first, and its Message row keeps the provider id (`gmail:<id>` when Gmail sent it). So
 * if the latest customer email since the connection was made went out through the platform provider instead, Gmail
 * failed (the usual cause: the Gmail API is not enabled on the Google Cloud project, see lib/gmail.ts) and the platform
 * sent it as the fallback in lib/customer-email.ts. Needs no extra column; a later email through Gmail clears it again.
 */
export function gmailSendingFailing(lastSent: { providerMessageId: string | null } | null): boolean {
  return lastSent !== null && !(lastSent.providerMessageId ?? "").startsWith("gmail:");
}

async function lastCustomerEmailSince(influencerId: string, connectedAt: Date, now = new Date()) {
  return prisma.message.findFirst({
    where: {
      channel: "EMAIL",
      status: { in: ["SENT", "DELIVERED", "READ"] },
      sentAt: { gte: new Date(Math.max(connectedAt.getTime(), now.getTime() - GMAIL_FAILURE_WINDOW_MS)) },
      booking: { session: { service: { influencerId } } },
    },
    orderBy: { sentAt: "desc" },
    select: { providerMessageId: true },
  });
}

export type GoogleConnectionStatus =
  | { state: "not-connected"; requestsGmail: boolean }
  | { state: "connected"; email: string | null; connectedAt: Date; gmailSend: boolean; liveEvents?: number; gmailFailing?: boolean }
  | { state: "reconnect-needed"; email: string | null; reason: string | null; since: Date | null; liveEvents?: number };

/**
 * Connection state for the dashboard: Connected as <email> / Reconnect needed (reason) / Not connected.
 * `details` also works out the numbers behind the Google panel's warnings (upcoming events stranded by a switch or
 * disconnect, Gmail sending failing); they cost a query each, so the overview does not ask for them.
 */
export async function getGoogleStatus(influencerId: string, opts: { details?: boolean } = {}): Promise<GoogleConnectionStatus> {
  const row = await prisma.googleToken.findUnique({
    where: { influencerId },
    select: { status: true, googleEmail: true, connectedAt: true, reconnectReason: true, reconnectNeededAt: true, scope: true },
  });
  if (!row) return { state: "not-connected", requestsGmail: requestGmailByDefault() };
  const liveEvents = opts.details ? { liveEvents: await countLiveCalendarEvents(influencerId) } : {};
  if (row.status === "RECONNECT_NEEDED") {
    return { state: "reconnect-needed", email: row.googleEmail, reason: row.reconnectReason, since: row.reconnectNeededAt, ...liveEvents };
  }
  const gmailSend = row.scope.split(/\s+/).includes("https://www.googleapis.com/auth/gmail.send");
  const gmailFailing = opts.details && gmailSend ? { gmailFailing: gmailSendingFailing(await lastCustomerEmailSince(influencerId, row.connectedAt)) } : {};
  return { state: "connected", email: row.googleEmail, connectedAt: row.connectedAt, gmailSend, ...liveEvents, ...gmailFailing };
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
