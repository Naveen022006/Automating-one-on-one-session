import { NextRequest, NextResponse } from "next/server";
import { getAuth } from "@/lib/auth/session";
import { buildAuthUrl, requestGmailByDefault } from "@/lib/google";
import { outcomeTarget, switchNeedsConfirmation, type GoogleOutcome } from "@/lib/google-connect";
import { NONCE_COOKIE, OAUTH_STATE_PURPOSE, countLiveCalendarEvents, getGoogleAccountOfRecord } from "@/lib/google-tokens";
import { safeNextPath } from "@/lib/http";
import { randomNonce, signToken } from "@/lib/signing";

const STATE_TTL_SEC = 600;

/** Back to the page the influencer started from (keeping its query, e.g. onboarding's ?step=3) with ?google=<outcome>. */
function backTo(req: NextRequest, returnTo: string, outcome: GoogleOutcome): NextResponse {
  const url = req.nextUrl.clone();
  const { pathname, search, hash } = outcomeTarget(returnTo, outcome);
  url.pathname = pathname;
  url.search = search;
  url.hash = hash ?? "";
  return NextResponse.redirect(url);
}

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

  // ?switch=1 is the "Switch account" button: it replaces the connection, but Calendar events that already exist stay on
  // the old account. With such upcoming bookings it is refused unless ?confirm=1 says the influencer was warned (the
  // dialog in web/src/components/app/GoogleConnect.tsx sends it); this check is the real gate, the dialog is only the explanation.
  const switching = req.nextUrl.searchParams.get("switch") === "1";
  if (switching && switchNeedsConfirmation({ liveEvents: await countLiveCalendarEvents(auth.influencerId), confirmed: req.nextUrl.searchParams.get("confirm") === "1" })) {
    return backTo(req, returnTo, "confirm-switch");
  }

  // `state` is signed (so it cannot be forged) and carries a nonce that must match this browser's cookie on the
  // way back, so a callback URL cannot be replayed into a different person's session. `c` records that a switch was
  // chosen on purpose, so the callback lets a different Google account through only then.
  const nonce = randomNonce();
  // ?gmail=1 asks for send-email permission too (the "Send from my Gmail" button); ?gmail=0 asks for Calendar only.
  const flag = req.nextUrl.searchParams.get("gmail");
  const gmail = flag === "1" ? true : flag === "0" ? false : requestGmailByDefault();
  const state = signToken(OAUTH_STATE_PURPOSE, { i: auth.influencerId, n: nonce, r: returnTo, g: gmail ? 1 : 0, c: switching ? 1 : 0 }, STATE_TTL_SEC);

  // Reconnecting or adding the Gmail permission should stay on the account the calendar events are on, so hint that
  // one (the login email is only a guess); a deliberate switch gets Google's account chooser.
  const hint = switching ? undefined : ((await getGoogleAccountOfRecord(auth.influencerId)).email ?? auth.email);
  let authUrl: string;
  try {
    authUrl = buildAuthUrl(state, hint, { gmail });
  } catch (e) {
    console.error("[google:connect] not configured", e instanceof Error ? e.message : e);
    return backTo(req, returnTo, "not-configured");
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
