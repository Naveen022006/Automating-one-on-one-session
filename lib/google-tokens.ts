import { prisma } from "@/lib/db";
import { decryptSecret, encryptSecret } from "@/lib/crypto";
import { requestGmailByDefault, revokeToken } from "@/lib/google";
import { GMAIL_FAILED_PREFIX } from "@/lib/gmail";
import type { GoogleAccountRef } from "@/lib/google-connect";
import { toClientKind, type GoogleClientKind } from "@/lib/google-credentials";

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
  googleSub: string | null = null,
  clientKind: GoogleClientKind = "platform",
): Promise<void> {
  const refreshTokenEnc = encryptSecret(refreshToken, googleTokenAad(influencerId));
  await prisma.googleToken.upsert({
    where: { influencerId },
    create: { influencerId, refreshTokenEnc, scope, googleEmail, googleSub, clientKind },
    update: {
      refreshTokenEnc,
      scope,
      googleEmail,
      // Written with every connect, so a row that had none gets one at its next reconnect. A connect whose ID token carried
      // none clears it: the account is then only known by address, which never leads to a revoke.
      googleSub,
      // The client this grant was issued with: every later refresh and health check must use that one.
      clientKind,
      status: "ACTIVE",
      reconnectReason: null,
      reconnectNeededAt: null,
      connectedAt: new Date(),
    },
  });
  // The account of record is the connected one again (see deleteGoogleToken); nothing left to remember from a disconnect.
  await prisma.influencer.updateMany({ where: { id: influencerId, disconnectedGoogleEmail: { not: null } }, data: { disconnectedGoogleEmail: null } });
}

/**
 * `connectedAt` is the version of the grant that was read: a caller that later finds the grant dead passes it to
 * markReconnectNeeded, so an error from a slow call made with the OLD grant cannot flag one that was renewed meanwhile.
 */
export type TokenLookup =
  | { state: "ok"; refreshToken: string; connectedAt: Date; clientKind: GoogleClientKind }
  | { state: "not-connected" }
  | { state: "reconnect-needed"; reason: string | null };

export async function getRefreshToken(influencerId: string): Promise<TokenLookup> {
  const row = await prisma.googleToken.findUnique({ where: { influencerId } });
  if (!row) return { state: "not-connected" };
  if (row.status === "RECONNECT_NEEDED") return { state: "reconnect-needed", reason: row.reconnectReason };
  return {
    state: "ok",
    refreshToken: decryptSecret(row.refreshTokenEnc, googleTokenAad(influencerId)),
    connectedAt: row.connectedAt,
    clientKind: toClientKind(row.clientKind),
  };
}

/**
 * An ACTIVE grant together with the `connectedAt` it was read at, for a caller that checks the grant against Google and
 * may then flag it dead: passing that value to markReconnectNeeded makes sure it is the SAME grant that gets flagged.
 * Null when there is no grant or it is already flagged.
 */
export async function getActiveGrant(influencerId: string): Promise<{ refreshToken: string; connectedAt: Date; clientKind: GoogleClientKind } | null> {
  const row = await prisma.googleToken.findUnique({ where: { influencerId } });
  if (!row || row.status !== "ACTIVE") return null;
  return {
    refreshToken: decryptSecret(row.refreshTokenEnc, googleTokenAad(influencerId)),
    connectedAt: row.connectedAt,
    clientKind: toClientKind(row.clientKind),
  };
}

/**
 * Flags the influencer as needing to reconnect. Returns true only for the call that flipped
 * ACTIVE -> RECONNECT_NEEDED, so the caller alerts once per revocation instead of once per failed job.
 *
 * `onlyIfConnectedAt`: flag only if the grant is still the one that was read at that time. A check that was in flight
 * while the influencer reconnected would otherwise mark their brand new, working connection dead.
 */
export async function markReconnectNeeded(influencerId: string, reason: string, onlyIfConnectedAt?: Date): Promise<boolean> {
  const { count } = await prisma.googleToken.updateMany({
    where: { influencerId, status: "ACTIVE", ...(onlyIfConnectedAt ? { connectedAt: onlyIfConnectedAt } : {}) },
    data: { status: "RECONNECT_NEEDED", reconnectReason: reason.slice(0, 500), reconnectNeededAt: new Date() },
  });
  return count > 0;
}

/**
 * Upcoming bookings whose Calendar event lives on the connected Google account (customers' invites included). Switching
 * or disconnecting the account strands them: later reschedules 404, cancels cannot remove the old invite, and a later
 * booking of a group session starts a second Meet on the new calendar instead of joining the first. Group attendees
 * count one each, because each booking carries the shared event id.
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

/**
 * The Google account the Calendar events are on: the stored grant's (whatever its status) or, after a disconnect, the
 * one remembered then (influencers.disconnected_google_email). `connected` says whether a grant row exists; `email` is
 * null when no account is on record or it is unknown. This is what an account switch is measured against, so
 * disconnecting first does not make a different account look like a first connection.
 */
export async function getGoogleAccountOfRecord(influencerId: string): Promise<{ connected: boolean; email: string | null }> {
  const row = await prisma.googleToken.findUnique({ where: { influencerId }, select: { googleEmail: true } });
  if (row) return { connected: true, email: row.googleEmail };
  const influencer = await prisma.influencer.findUnique({ where: { id: influencerId }, select: { disconnectedGoogleEmail: true } });
  return { connected: false, email: influencer?.disconnectedGoogleEmail ?? null };
}

/**
 * What the callback needs to know about the account on record, from ONE read so that the address, the stable id and the
 * token it may have to revoke belong to the same grant (two reads could straddle a concurrent reconnect or disconnect).
 * Unlike getRefreshToken it returns the token whatever the grant's status: a grant flagged "reconnect needed" (which also
 * happens on a plain 401/403) is usually still authorised at Google, and replacing it must not leave it that way.
 * After a disconnect there is no grant: `connected` is false, `email` is the one remembered then, `sub` and `refreshToken`
 * are null. `refreshToken` is also null when the stored token cannot be decrypted. Server side only: never put it in a response.
 */
export interface GoogleAccountRecord {
  connected: boolean;
  email: string | null;
  sub: string | null;
  refreshToken: string | null;
  /** Which OAuth client issued the stored grant; absent when nothing is connected. */
  clientKind?: GoogleClientKind;
}

export async function getGoogleAccountRecord(influencerId: string): Promise<GoogleAccountRecord> {
  const row = await prisma.googleToken.findUnique({
    where: { influencerId },
    select: { googleEmail: true, googleSub: true, refreshTokenEnc: true, clientKind: true },
  });
  if (row) {
    let refreshToken: string | null = null;
    try {
      refreshToken = decryptSecret(row.refreshTokenEnc, googleTokenAad(influencerId));
    } catch {
      /* unreadable: nothing to revoke */
    }
    return { connected: true, email: row.googleEmail, sub: row.googleSub, refreshToken, clientKind: toClientKind(row.clientKind) };
  }
  const influencer = await prisma.influencer.findUnique({ where: { id: influencerId }, select: { disconnectedGoogleEmail: true } });
  return { connected: false, email: influencer?.disconnectedGoogleEmail ?? null, sub: null, refreshToken: null };
}

/**
 * Whether ANOTHER influencer profile is connected with the same Google account. Google's revoke ends the app's access
 * for the whole account, not for one token, so revoking a refused or disconnected token of this profile would also kill
 * the other profile's working connection: callers skip the revoke when this is true. The account matches by address
 * (case-insensitive) or by stable id, either is enough to hold the revoke back; unknown accounts never match.
 */
export async function googleAccountSharedWithOthers(
  influencerId: string,
  email: string | null | undefined,
  sub?: string | null,
): Promise<boolean> {
  const same = [
    ...(email ? [{ googleEmail: { equals: email, mode: "insensitive" as const } }] : []),
    ...(sub ? [{ googleSub: sub }] : []),
  ];
  if (same.length === 0) return false;
  const others = await prisma.googleToken.count({ where: { influencerId: { not: influencerId }, OR: same } });
  return others > 0;
}

/**
 * Revokes a grant we are not keeping, unless another influencer profile is connected with the same Google account (Google's revoke ends the
 * app's access for the whole account, so it would disconnect that profile too). Throws when Google cannot be reached: callers that must not
 * fail because of it catch.
 */
export async function revokeGrantUnlessShared(influencerId: string, refreshToken: string, account: GoogleAccountRef): Promise<void> {
  if (!(await googleAccountSharedWithOthers(influencerId, account.email, account.sub))) await revokeToken(refreshToken);
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
  const since = new Date(Math.max(connectedAt.getTime(), now.getTime() - GMAIL_FAILURE_WINDOW_MS));
  const booking = { session: { service: { influencerId } } };
  // The latest e-mail that went out, and the latest one Gmail failed to send when no platform provider could take over (EMAIL_PROVIDER=none
  // leaves no sent row for a failed Gmail send; a forced resend that failed leaves the failure as a note on the earlier SENT row). Whichever is
  // newer decides.
  const [sent, failed] = await Promise.all([
    prisma.message.findFirst({
      where: { channel: "EMAIL", status: { in: ["SENT", "DELIVERED", "READ"] }, sentAt: { gte: since }, booking },
      orderBy: { sentAt: "desc" },
      select: { providerMessageId: true, sentAt: true },
    }),
    prisma.message.findFirst({
      where: { channel: "EMAIL", error: { startsWith: GMAIL_FAILED_PREFIX }, updatedAt: { gte: since }, booking },
      orderBy: { updatedAt: "desc" },
      select: { updatedAt: true },
    }),
  ]);
  if (failed && (!sent || !sent.sentAt || failed.updatedAt > sent.sentAt)) return { providerMessageId: null };
  return sent ? { providerMessageId: sent.providerMessageId } : null;
}

export type GoogleConnectionStatus =
  | { state: "not-connected"; requestsGmail: boolean; liveEvents?: number; previousEmail?: string | null }
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
  if (!row) {
    const requestsGmail = requestGmailByDefault();
    if (!opts.details) return { state: "not-connected", requestsGmail };
    // After a disconnect the old account's events are still on its calendar: say so, so reconnecting is a choice.
    const { email } = await getGoogleAccountOfRecord(influencerId);
    return { state: "not-connected", requestsGmail, liveEvents: await countLiveCalendarEvents(influencerId), previousEmail: email };
  }
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
 * can revoke it at Google. New paid bookings then wait as PAID until the influencer connects again. The account the
 * events are on is remembered (influencers.disconnected_google_email) so that connecting a DIFFERENT account later is
 * still recognised as a switch; the next successful connect clears it (saveGoogleToken).
 */
export async function deleteGoogleToken(influencerId: string): Promise<string | null> {
  const row = await prisma.googleToken.findUnique({ where: { influencerId } });
  if (!row) return null;
  await prisma.$transaction(async (tx) => {
    if (row.googleEmail) await tx.influencer.update({ where: { id: influencerId }, data: { disconnectedGoogleEmail: row.googleEmail } });
    await tx.googleToken.delete({ where: { influencerId } });
  });
  try {
    return decryptSecret(row.refreshTokenEnc, googleTokenAad(influencerId));
  } catch {
    return null;
  }
}
