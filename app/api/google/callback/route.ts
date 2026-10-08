import { NextRequest, NextResponse } from "next/server";
import { CALENDAR_SCOPE, exchangeCode } from "@/lib/google";
import { NONCE_COOKIE, OAUTH_STATE_PURPOSE, saveGoogleToken } from "@/lib/google-tokens";
import { requeuePendingMeetings } from "@/lib/meeting";
import { safeEqual, verifyToken } from "@/lib/signing";

// Static messages only: nothing from the request is ever interpolated into the HTML.
function page(status: number, title: string, message: string) {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title></head><body style="font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem"><h1>${title}</h1><p>${message}</p></body></html>`;
  const res = new NextResponse(html, { status, headers: { "Content-Type": "text/html; charset=utf-8" } });
  res.cookies.delete({ name: NONCE_COOKIE, path: "/api/google" });
  return res;
}

// Step 2 of the connect flow: Google redirects here with ?code=...&state=...
export async function GET(req: NextRequest) {
  const params = req.nextUrl.searchParams;

  const state = verifyToken<{ i: string; n: string }>(OAUTH_STATE_PURPOSE, params.get("state"));
  const cookieNonce = req.cookies.get(NONCE_COOKIE)?.value;
  if (!state || !cookieNonce || !safeEqual(state.n, cookieNonce)) {
    return page(400, "Connection failed", "This sign-in session is invalid or has expired. Please open your connect link again.");
  }

  if (params.get("error")) {
    return page(400, "Not connected", "Google Calendar access was not granted, so session links cannot be created yet. Open your connect link to try again.");
  }
  const code = params.get("code");
  if (!code) return page(400, "Connection failed", "Google did not return an authorisation code. Please try again.");

  try {
    const { refreshToken, scope } = await exchangeCode(code);
    // Google lets users untick individual permissions on the consent screen; without this one we cannot create events.
    if (!scope.split(" ").includes(CALENDAR_SCOPE)) {
      return page(400, "Permission missing", "Calendar permission was not granted. Please try again and leave all permissions ticked.");
    }
    await saveGoogleToken(state.i, refreshToken, scope);
  } catch (e) {
    console.error("[google:callback] connect failed", e);
    return page(502, "Connection failed", "We could not complete the connection with Google. Please try again in a moment.");
  }

  // Bookings that were paid while the connection was broken can get their Meet link now. A Redis hiccup here must
  // not undo a successful connection: the worker also re-queues these on start-up.
  try {
    const n = await requeuePendingMeetings(state.i);
    if (n > 0) console.log(`[google:callback] re-queued ${n} waiting booking(s) for influencer ${state.i}`);
  } catch (e) {
    console.error("[google:callback] could not re-queue waiting bookings", e);
  }

  return page(200, "Google Calendar connected", "You're all set. Meet links will now be created automatically for new bookings. You can close this tab.");
}
