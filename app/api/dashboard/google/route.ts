import { NextResponse } from "next/server";
import { requireApiAuth, requireRecentAuth } from "@/lib/auth/session";
import { revokeToken } from "@/lib/google";
import { switchNeedsConfirmation } from "@/lib/google-connect";
import { countLiveCalendarEvents, deleteGoogleToken, getGoogleStatus } from "@/lib/google-tokens";

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
  const body = (await req.json().catch(() => null)) as { confirm?: unknown } | null;
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
  const refreshToken = await deleteGoogleToken(auth.influencerId);
  if (refreshToken) await revokeToken(refreshToken);
  return NextResponse.json({ ok: true });
}
