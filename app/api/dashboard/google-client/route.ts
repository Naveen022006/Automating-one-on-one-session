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

const schema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("save-client"), clientId: z.string().max(300), clientSecret: z.string().max(300), confirm: z.boolean().optional() }),
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

    const [previous, grant] = await Promise.all([
      getSavedGoogleClient(influencerId),
      prisma.googleToken.findUnique({ where: { influencerId }, select: { clientKind: true } }),
    ]);
    // Saving NEVER touches an existing connection (doc/15, 4.9): a connection made with the shared client keeps using the shared client, and
    // the callback replaces it (and revokes its token) only after Google accepted the new client's consent. The one connection a save does
    // affect is the one made with the influencer's OWN client when its ID changes: its refresh token belongs to the old client, so the next
    // refresh is refused by Google and the connection is flagged by the existing path. That needs the confirmation Disconnect needs when
    // upcoming bookings have calendar events, and the server asks for it itself.
    const breaksOwnGrant = grant !== null && grant.clientKind === "own" && previous !== null && previous.clientId !== clientId;
    if (breaksOwnGrant) {
      const liveEvents = await countLiveCalendarEvents(influencerId);
      if (switchNeedsConfirmation({ liveEvents, confirmed: body.confirm === true })) {
        return NextResponse.json(
          {
            error: `You have ${liveEvents} upcoming booking${liveEvents === 1 ? "" : "s"} with a calendar event on your Google account. A different Google client stops your current connection, and those events and invites stay where they are. Confirm to replace the client anyway.`,
            needsConfirmation: true,
            liveEvents,
          },
          { status: 409 },
        );
      }
    }

    // Nothing is saved unless Google itself accepts the pair (an invalid code is posted with these credentials, see lib/google-client-check.ts).
    const check = await verifyGoogleClient(clientId, clientSecret);
    if (!check.ok) {
      const status = check.reason === "unreachable" ? 503 : check.reason === "unexpected" ? 502 : 400;
      return jsonError(check.message, status, { reason: check.reason, field: check.reason === "format-secret" ? "clientSecret" : "clientId" });
    }
    await saveGoogleClient(influencerId, clientId, clientSecret);
    await recordActivity({ influencerId, action: "google.client_saved", detail: { client: maskClientId(clientId), replaced: previous !== null }, req });
    return jsonView({ ok: true, replacedConnection: breaksOwnGrant, client: await loadGoogleClientView(influencerId) });
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
