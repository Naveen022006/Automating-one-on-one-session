import { NextResponse } from "next/server";
import { readJson } from "@/lib/http";
import { recordActivity } from "@/lib/activity";
import { requireApiAuth, requireRecentAuth } from "@/lib/auth/session";
import { revokeToken } from "@/lib/google";
import { switchNeedsConfirmation } from "@/lib/google-connect";
import { countLiveCalendarEvents, deleteGoogleToken, getGoogleAccountRecord, getGoogleStatus, googleAccountSharedWithOthers } from "@/lib/google-tokens";

// GET: connection state for the dashboard. DELETE: disconnect (revokes the grant at Google too).
export async function GET() {
  const auth = await requireApiAuth();
  if (auth instanceof NextResponse) return auth;
  return NextResponse.json(await getGoogleStatus(auth.influencerId, { details: true }));
}

export async function DELETE(req: Request) {
  const auth = await requireRecentAuth();
  if (auth instanceof NextResponse) return auth;
  // Disconnecting strands the Calendar events that already exist on this Google account, just like switching does, so
  // with upcoming bookings that have events it needs the explicit `{ "confirm": true }` the dialog sends. The server
  // asks for it itself; the dialog is only the explanation.
  const body = (await readJson(req)) as { confirm?: unknown } | null;
  const liveEvents = await countLiveCalendarEvents(auth.influencerId);
  if (switchNeedsConfirmation({ liveEvents, confirmed: body?.confirm === true })) {
    return NextResponse.json(
      {
        error: `You have ${liveEvents} upcoming booking${liveEvents === 1 ? "" : "s"} with a calendar event on this Google account. Disconnecting leaves those events and invites where they are. Confirm to disconnect anyway.`,
        needsConfirmation: true,
        liveEvents,
      },
      { status: 409 },
    );
  }
  // Google's revoke ends the app's access for the whole Google account, so skip it when another influencer profile is
  // connected with the same account: it would disconnect that profile too. (Our own copy of the token is deleted either way.)
  const { connected, email, sub } = await getGoogleAccountRecord(auth.influencerId);
  const shared = await googleAccountSharedWithOthers(auth.influencerId, email, sub);
  const refreshToken = await deleteGoogleToken(auth.influencerId);
  if (refreshToken && !shared) await revokeToken(refreshToken);
  // Only when a connection was really removed (a repeated DELETE is a no-op and writes nothing).
  if (connected || refreshToken) await recordActivity({ influencerId: auth.influencerId, action: "google.disconnected", detail: { account: email ?? null }, req });
  return NextResponse.json({ ok: true });
}
