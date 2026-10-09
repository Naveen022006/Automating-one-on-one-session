import { NextResponse } from "next/server";
import { clearSessionCookie, getAuth, revokeSession } from "@/lib/auth/session";

export async function POST() {
  const auth = await getAuth();
  if (auth) await revokeSession(auth.sessionId);
  return clearSessionCookie(NextResponse.json({ ok: true, redirect: "/login" }));
}
