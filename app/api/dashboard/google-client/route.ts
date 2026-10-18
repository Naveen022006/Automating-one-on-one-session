import { NextResponse } from "next/server";
import { z } from "zod";
import { recordActivity } from "@/lib/activity";
import { requireApiAuth, requireRecentAuth } from "@/lib/auth/session";
import { prisma } from "@/lib/db";
import { jsonError, parseJson } from "@/lib/http";
import { revokeToken } from "@/lib/google";
import { verifyGoogleClient } from "@/lib/google-client-check";
import { switchNeedsConfirmation } from "@/lib/google-connect";
import { deleteGoogleClient, getSavedGoogleClient, googleClientMode, maskClientId, saveGoogleClient } from "@/lib/google-credentials";
import {
  countLiveCalendarEvents,
  deleteGoogleToken,
  getGoogleAccountRecord,
  getGoogleStatus,
  googleAccountSharedWithOthers,
  markReconnectNeeded,
} from "@/lib/google-tokens";
import { enforce, IDENTITY_RULES } from "@/lib/rate-limit";
import { loadGoogleClientView, toGoogleStatusView } from "@/lib/views/dashboard-settings";
import { jsonView } from "@/lib/views/http";

export const dynamic = "force-dynamic";

/**
 * The influencer's own Google OAuth client (doc/15-influencer-google-credentials.md).
 *
 * GET   { client, connection }: the client card (the client ID, "secret saved", when Google last accepted the pair, the exact redirect
 *       URI and scopes) next to the connection state as GET /api/dashboard/google returns it. Never the secret.
 * POST  { action: "save-client", clientId, clientSecret } checks the pair with Google and saves it encrypted;
 *       { action: "remove-client", confirm? } removes it (and disconnects Google when the connection was made with it).
 */
export async function GET() {
  const auth = await requireApiAuth();
  if (auth instanceof NextResponse) return auth;
  const [connection, client] = await Promise.all([getGoogleStatus(auth.influencerId, { details: true }), loadGoogleClientView(auth.influencerId)]);
  return jsonView({ client, connection: toGoogleStatusView(connection) });
}

const REPLACED_REASON = "You changed your Google client, so Google needs to be connected again.";

const schema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("save-client"), clientId: z.string().max(300), clientSecret: z.string().max(300) }),
  z.object({ action: z.literal("remove-client"), confirm: z.boolean().optional() }),
]);

export async function POST(req: Request) {
  // Both actions are sensitive (a secret goes in, or a connection goes away): a recent password entry is required, like Disconnect.
  const auth = await requireRecentAuth();
  if (auth instanceof NextResponse) return auth;
  const parsed = await parseJson(req, schema);
  if (!parsed.ok) return parsed.response;
  const body = parsed.data;
  const influencerId = auth.influencerId;

  if (body.action === "save-client") {
    if (googleClientMode() === "platform") {
      return jsonError("This site uses its own shared Google app, so there is no need to add a Google client of your own.", 409);
    }
    const limited = await enforce(IDENTITY_RULES.googleClientCheck, influencerId, "Too many checks of Google clients. Wait a while and try again.");
    if (limited) return limited;

    const clientId = body.clientId.trim();
    const clientSecret = body.clientSecret.trim();
    // Nothing is saved unless Google itself accepts the pair (an invalid code is posted with these credentials, see lib/google-client-check.ts).
    const check = await verifyGoogleClient(clientId, clientSecret);
    if (!check.ok) {
      const status = check.reason === "unreachable" ? 503 : check.reason === "unexpected" ? 502 : 400;
      return jsonError(check.message, status, { reason: check.reason, field: check.reason === "format-secret" ? "clientSecret" : "clientId" });
    }

    const [previous, grant] = await Promise.all([
      getSavedGoogleClient(influencerId),
      prisma.googleToken.findUnique({ where: { influencerId }, select: { clientKind: true } }),
    ]);
    await saveGoogleClient(influencerId, clientId, clientSecret);

    // A grant made with a DIFFERENT client cannot be refreshed with this one (Google ties a refresh token to its client). A new secret
    // for the same client ID keeps working. So: flag the connection for reconnect, say why, and revoke the old token at Google.
    const replacedGrant = grant !== null && (grant.clientKind !== "own" || previous?.clientId !== clientId);
    if (replacedGrant) {
      await markReconnectNeeded(influencerId, REPLACED_REASON);
      const record = await getGoogleAccountRecord(influencerId);
      if (record.refreshToken) {
        // A token of the shared client is revoked only when no other profile uses that Google account (Google's revoke ends the whole
        // account's access to the app). A token of the influencer's own client is theirs alone.
        const shared = grant.clientKind === "platform" && (await googleAccountSharedWithOthers(influencerId, record.email, record.sub));
        if (!shared) await revokeToken(record.refreshToken);
      }
    }
    await recordActivity({ influencerId, action: "google.client_saved", detail: { client: maskClientId(clientId), replaced: previous !== null }, req });
    return jsonView({ ok: true, replacedConnection: replacedGrant, client: await loadGoogleClientView(influencerId) });
  }

  // remove-client
  const saved = await getSavedGoogleClient(influencerId);
  if (!saved) return jsonError("No Google client is saved.", 404);
  // A connection made with this client cannot outlive it, so removing the client disconnects Google, with the same rule as Disconnect:
  // upcoming bookings with calendar events need the explicit confirmation (their events stay on the Google account).
  const grant = await prisma.googleToken.findUnique({ where: { influencerId }, select: { clientKind: true } });
  const disconnecting = grant !== null && grant.clientKind === "own";
  if (disconnecting) {
    const liveEvents = await countLiveCalendarEvents(influencerId);
    if (switchNeedsConfirmation({ liveEvents, confirmed: body.confirm === true })) {
      return NextResponse.json(
        {
          error: `You have ${liveEvents} upcoming booking${liveEvents === 1 ? "" : "s"} with a calendar event on your Google account. Removing your Google client disconnects Google and leaves those events and invites where they are. Confirm to remove it anyway.`,
          needsConfirmation: true,
          liveEvents,
        },
        { status: 409 },
      );
    }
  }
  let account: string | null = null;
  if (disconnecting) {
    account = (await getGoogleAccountRecord(influencerId)).email;
    const refreshToken = await deleteGoogleToken(influencerId);
    if (refreshToken) await revokeToken(refreshToken);
  }
  await deleteGoogleClient(influencerId);
  if (disconnecting) await recordActivity({ influencerId, action: "google.disconnected", detail: { account }, req });
  await recordActivity({ influencerId, action: "google.client_removed", detail: { client: maskClientId(saved.clientId) }, req });
  return jsonView({ ok: true, disconnected: disconnecting, client: await loadGoogleClientView(influencerId) });
}
