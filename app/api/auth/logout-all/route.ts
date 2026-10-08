import { NextResponse } from "next/server";
import { clearSessionCookie, requireRecentAuth, revokeAllSessions } from "@/lib/auth/session";

// "Log out everywhere": sensitive, so it needs a password entry within the last 8 hours.
export async function POST() {
  const auth = await requireRecentAuth();
  if (auth instanceof NextResponse) return auth;
  const count = await revokeAllSessions(auth.userId);
  return clearSessionCookie(NextResponse.json({ ok: true, revoked: count, redirect: "/login" }));
}
