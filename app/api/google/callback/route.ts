import { NextRequest, NextResponse } from "next/server";
import { recordActivity } from "@/lib/activity";
import { getAuth } from "@/lib/auth/session";
import { CALENDAR_SCOPE, exchangeCode, isClientRejection } from "@/lib/google";
import { hasGmailSendScope } from "@/lib/gmail";
import { compareAccounts, mayRevokeOther, outcomeTarget, type GoogleAccountRef, type GoogleOutcome } from "@/lib/google-connect";
import { getGoogleCredentials, toClientKind } from "@/lib/google-credentials";
import {
  NONCE_COOKIE,
  OAUTH_STATE_PURPOSE,
  countLiveCalendarEvents,
  getGoogleAccountRecord,
  revokeGrantUnlessShared,
  saveGoogleToken,
} from "@/lib/google-tokens";
import { safeNextPath } from "@/lib/http";
import { requeuePendingMeetings } from "@/lib/meeting";
import { safeEqual, verifyToken } from "@/lib/signing";

function back(req: NextRequest, returnTo: string, outcome: GoogleOutcome): NextResponse {
  const url = req.nextUrl.clone();
  const { pathname, search, hash } = outcomeTarget(returnTo, outcome);
  url.pathname = pathname;
  url.search = search;
  url.hash = hash ?? "";
  const res = NextResponse.redirect(url);
  res.cookies.delete({ name: NONCE_COOKIE, path: "/api/google" });
  return res;
}

/** Revokes a grant we are not keeping, unless another influencer profile uses the same Google account (lib/google-tokens.ts). */
const revokeUnlessShared = revokeGrantUnlessShared;

// Step 2 of the connect flow: Google redirects here with ?code=...&state=... The outcome is shown on the page the
// influencer started from (settings or onboarding) through ?google=<outcome>.
export async function GET(req: NextRequest) {
  const params = req.nextUrl.searchParams;
  const state = verifyToken<{ i: string; n: string; r?: string; g?: number; c?: number; k?: string }>(OAUTH_STATE_PURPOSE, params.get("state"));
  const returnTo = safeNextPath(state?.r, "/dashboard/settings");
  const cookieNonce = req.cookies.get(NONCE_COOKIE)?.value;
  if (!state || !cookieNonce || !safeEqual(state.n, cookieNonce)) return back(req, returnTo, "expired");

  // The browser finishing the flow must still be logged in as the influencer who started it.
  const auth = await getAuth();
  if (!auth || auth.influencerId !== state.i) return back(req, returnTo, "expired");

  if (params.get("error")) return back(req, returnTo, "denied");
  const code = params.get("code");
  if (!code) return back(req, returnTo, "failed");

  // The code was issued to the client the consent screen was shown for: the signed-in influencer's own client (recorded in the signed
  // state as `k`), never another influencer's and never a substitute. A state from before own clients existed has no `k`: platform.
  const clientKind = toClientKind(state.k);
  const creds = await getGoogleCredentials(state.i, clientKind).catch(() => null);
  if (!creds || !creds.ok) {
    console.error("[google:callback] no usable Google client", creds ? creds.reason : "lookup failed");
    return back(req, returnTo, clientKind === "own" ? "no-client" : "not-configured");
  }

  let gmailMissing = false;
  let connectedAccount: string | null = null;
  try {
    const { refreshToken, scope, email, sub } = await exchangeCode(code, fetch, creds.credentials);
    const incoming: GoogleAccountRef = { email, sub };
    // The account the calendar events are on (the connected one, or after a disconnect the one remembered then) together
    // with its stable id and the token we hold for it, read in one query.
    const record = await getGoogleAccountRecord(state.i);
    // "Different" decides what we ASK the influencer (confirm a switch); it may rest on the address alone.
    const differentAccount = compareAccounts(record, incoming).different;
    // Every REVOKE below needs more than that. Google's revoke ends the app's access for the whole Google account, so
    // revoking a token of what is really the same account (an address that was renamed since) would kill the connection
    // that works or was just made. So a token is only revoked when nothing is connected, or both sides have a `sub` and
    // the two differ. An account known by address only is left authorised rather than risk that.
    const mayRevoke = mayRevokeOther(record, incoming);
    // Google lets users untick individual permissions on the consent screen; without this one we cannot create events.
    // The token Google already issued would stay authorised for whatever they did tick, so revoke it (when the rule above allows).
    if (!scope.split(" ").includes(CALENDAR_SCOPE)) {
      if (mayRevoke) await revokeUnlessShared(state.i, refreshToken, incoming);
      return back(req, returnTo, "missing-permission");
    }
    // A different Google account than the one the calendar events are on, without having chosen "Switch account"
    // (reconnect, the Gmail button, or connecting again after a disconnect, where the account chooser let them pick
    // another one): the upcoming bookings' events would be stranded on the old account, so keep the old connection
    // and revoke the new grant (when the rule above allows).
    if (state.c !== 1 && differentAccount && (await countLiveCalendarEvents(state.i)) > 0) {
      if (mayRevoke) await revokeUnlessShared(state.i, refreshToken, incoming);
      return back(req, returnTo, "switch-unconfirmed");
    }
    // A confirmed switch to another account replaces the stored refresh token, so the old account's grant would stay
    // authorised at Google with nobody able to use or revoke it any more (our copy is gone), whatever its status (a grant
    // flagged "reconnect needed" usually still is). `record` holds it from before the overwrite. Never the token just issued.
    // The same goes for a grant made with ANOTHER KIND of client (doc/15, 4.9: the first own client replaces a connection made with the
    // shared one, here and only here, after Google accepted the consent): its token belongs to a different app, so revoking it cannot
    // hurt the new connection even for the same Google account.
    const kindChanged = record.connected && record.clientKind !== undefined && record.clientKind !== creds.kind;
    const replaced =
      record.connected && record.refreshToken && record.refreshToken !== refreshToken && ((differentAccount && mayRevoke) || kindChanged) ? record.refreshToken : null;
    await saveGoogleToken(state.i, refreshToken, scope, email, sub, creds.kind);
    connectedAccount = email ?? null;
    if (replaced) {
      // Best effort and after the new connection is safe. Skipped, like a disconnect, while another profile uses the same Google account
      // (Google's revoke ends the app's access for the whole account), whichever kind of client the old token belonged to.
      await revokeUnlessShared(state.i, replaced, record).catch((e) => console.error("[google:callback] could not revoke the replaced grant", e instanceof Error ? e.message : e));
    }
    // Gmail is optional: people can untick it, and customer emails then go out from the platform address instead.
    gmailMissing = state.g === 1 && !hasGmailSendScope(scope);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error("[google:callback] connect failed", message);
    // Google refusing the influencer's own client at the code exchange (deleted, wrong secret, changed since the page loaded).
    return back(req, returnTo, creds.kind === "own" && isClientRejection(message) ? "client-rejected" : "failed");
  }

  await recordActivity({ influencerId: state.i, action: "google.connected", detail: { account: connectedAccount }, req });
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
