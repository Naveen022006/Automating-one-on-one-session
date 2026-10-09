import { NextRequest, NextResponse } from "next/server";
import { getAuth } from "@/lib/auth/session";
import { CALENDAR_SCOPE, exchangeCode } from "@/lib/google";
import { hasGmailSendScope } from "@/lib/gmail";
import { NONCE_COOKIE, OAUTH_STATE_PURPOSE, saveGoogleToken } from "@/lib/google-tokens";
import { safeNextPath } from "@/lib/http";
import { requeuePendingMeetings } from "@/lib/meeting";
import { safeEqual, verifyToken } from "@/lib/signing";

type Outcome = "connected" | "connected-no-gmail" | "denied" | "missing-permission" | "failed" | "expired";

function back(req: NextRequest, returnTo: string, outcome: Outcome): NextResponse {
  const url = req.nextUrl.clone();
  const [path, query = ""] = returnTo.split("?");
  const params = new URLSearchParams(query);
  params.set("google", outcome);
  url.pathname = path;
  url.search = `?${params}`;
  const res = NextResponse.redirect(url);
  res.cookies.delete({ name: NONCE_COOKIE, path: "/api/google" });
  return res;
}

// Step 2 of the connect flow: Google redirects here with ?code=...&state=... The outcome is shown on the page the
// influencer started from (settings or onboarding) through ?google=<outcome>.
export async function GET(req: NextRequest) {
  const params = req.nextUrl.searchParams;
  const state = verifyToken<{ i: string; n: string; r?: string; g?: number }>(OAUTH_STATE_PURPOSE, params.get("state"));
  const returnTo = safeNextPath(state?.r, "/dashboard/settings");
  const cookieNonce = req.cookies.get(NONCE_COOKIE)?.value;
  if (!state || !cookieNonce || !safeEqual(state.n, cookieNonce)) return back(req, returnTo, "expired");

  // The browser finishing the flow must still be logged in as the influencer who started it.
  const auth = await getAuth();
  if (!auth || auth.influencerId !== state.i) return back(req, returnTo, "expired");

  if (params.get("error")) return back(req, returnTo, "denied");
  const code = params.get("code");
  if (!code) return back(req, returnTo, "failed");

  let gmailMissing = false;
  try {
    const { refreshToken, scope, email } = await exchangeCode(code);
    // Google lets users untick individual permissions on the consent screen; without this one we cannot create events.
    if (!scope.split(" ").includes(CALENDAR_SCOPE)) return back(req, returnTo, "missing-permission");
    await saveGoogleToken(state.i, refreshToken, scope, email);
    // Gmail is optional: people can untick it, and customer emails then go out from the platform address instead.
    gmailMissing = state.g === 1 && !hasGmailSendScope(scope);
  } catch (e) {
    console.error("[google:callback] connect failed", e instanceof Error ? e.message : e);
    return back(req, returnTo, "failed");
  }

  // Bookings that were paid while the connection was broken can get their Meet link now. A Redis hiccup here must
  // not undo a successful connection: the worker also re-queues these on start-up.
  try {
    const n = await requeuePendingMeetings(state.i);
    if (n > 0) console.log(`[google:callback] re-queued ${n} waiting booking(s) for influencer ${state.i}`);
  } catch (e) {
    console.error("[google:callback] could not re-queue waiting bookings", e);
  }
  return back(req, returnTo, gmailMissing ? "connected-no-gmail" : "connected");
}
