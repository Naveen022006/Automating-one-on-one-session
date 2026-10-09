import { NextRequest, NextResponse } from "next/server";
import { getAuth } from "@/lib/auth/session";
import { buildAuthUrl, requestGmailByDefault } from "@/lib/google";
import { NONCE_COOKIE, OAUTH_STATE_PURPOSE } from "@/lib/google-tokens";
import { safeNextPath } from "@/lib/http";
import { randomNonce, signToken } from "@/lib/signing";

const STATE_TTL_SEC = 600;

// Step 1 of the connect flow, started by the "Connect Google Calendar" button. Requires the influencer's login
// session (Phase 7 replaced the old CLI-generated signed connect link): only the logged-in owner can attach a
// calendar to their own profile.
export async function GET(req: NextRequest) {
  const auth = await getAuth();
  const returnTo = safeNextPath(req.nextUrl.searchParams.get("returnTo"), "/dashboard/settings");
  if (!auth) {
    const url = req.nextUrl.clone();
    url.pathname = "/login";
    url.search = `?next=${encodeURIComponent(returnTo)}`;
    return NextResponse.redirect(url);
  }

  // `state` is signed (so it cannot be forged) and carries a nonce that must match this browser's cookie on the
  // way back, so a callback URL cannot be replayed into a different person's session.
  const nonce = randomNonce();
  // ?gmail=1 asks for send-email permission too (the "Send from my Gmail" button); ?gmail=0 asks for Calendar only.
  const flag = req.nextUrl.searchParams.get("gmail");
  const gmail = flag === "1" ? true : flag === "0" ? false : requestGmailByDefault();
  const state = signToken(OAUTH_STATE_PURPOSE, { i: auth.influencerId, n: nonce, r: returnTo, g: gmail ? 1 : 0 }, STATE_TTL_SEC);

  let authUrl: string;
  try {
    authUrl = buildAuthUrl(state, auth.email, { gmail });
  } catch (e) {
    console.error("[google:connect] not configured", e instanceof Error ? e.message : e);
    const url = req.nextUrl.clone();
    url.pathname = returnTo.split("?")[0];
    url.search = "?google=not-configured";
    return NextResponse.redirect(url);
  }
  const res = NextResponse.redirect(authUrl);
  res.cookies.set(NONCE_COOKIE, nonce, {
    httpOnly: true,
    sameSite: "lax", // must be sent on the top-level redirect back from accounts.google.com
    secure: (process.env.APP_URL ?? "").startsWith("https://"),
    path: "/api/google",
    maxAge: STATE_TTL_SEC,
  });
  return res;
}
