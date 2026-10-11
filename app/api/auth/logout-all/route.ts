import { NextResponse } from "next/server";
import { recordActivity } from "@/lib/activity";
import { clearSessionCookie, requireRecentAuth, revokeAllSessions } from "@/lib/auth/session";

// "Log out everywhere": sensitive, so it needs a password entry within the last 8 hours.
export async function POST(req: Request) {
  const auth = await requireRecentAuth();
  if (auth instanceof NextResponse) return auth;
  const count = await revokeAllSessions(auth.userId);
  await recordActivity({ influencerId: auth.influencerId, action: "auth.logout_all", detail: { sessions: count }, req });
  return clearSessionCookie(NextResponse.json({ ok: true, revoked: count, redirect: "/login" }));
}
