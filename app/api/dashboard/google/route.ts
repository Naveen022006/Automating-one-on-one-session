import { NextResponse } from "next/server";
import { requireApiAuth, requireRecentAuth } from "@/lib/auth/session";
import { revokeToken } from "@/lib/google";
import { deleteGoogleToken, getGoogleStatus } from "@/lib/google-tokens";

// GET: connection state for the dashboard. DELETE: disconnect (revokes the grant at Google too).
export async function GET() {
  const auth = await requireApiAuth();
  if (auth instanceof NextResponse) return auth;
  return NextResponse.json(await getGoogleStatus(auth.influencerId));
}

export async function DELETE() {
  const auth = await requireRecentAuth();
  if (auth instanceof NextResponse) return auth;
  const refreshToken = await deleteGoogleToken(auth.influencerId);
  if (refreshToken) await revokeToken(refreshToken);
  return NextResponse.json({ ok: true });
}
