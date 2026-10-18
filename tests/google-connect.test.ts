import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { NextRequest } from "next/server";
import { claimsFromIdToken } from "../lib/google";
import { compareAccounts, isAccountSwitch, mayRevokeOther, outcomeTarget, switchNeedsConfirmation } from "../lib/google-connect";
import { signToken, verifyToken } from "../lib/signing";

/**
 * "Switch account" and the OAuth callback (app/api/google). Events that already exist stay on the old Google account, so
 * the connect route must refuse a switch that was not confirmed when upcoming bookings have events, the callback must not
 * let a different account in by the back door (reconnect, Gmail button), the unticked-Calendar token must be revoked, and
 * the not-configured redirect must keep onboarding's ?step=3. Database- and Google-free: the token store, the session and
 * the Google HTTP endpoints are fakes.
 */

process.env.APP_SECRET = "test-app-secret-0123456789abcdef";
process.env.GOOGLE_CLIENT_ID = "client-id";
process.env.GOOGLE_CLIENT_SECRET = "client-secret";
// These tests drive the routes with the shared env pair and a database-free fake token store. Since doc/15 a new connection resolves its
// client by GOOGLE_CLIENT_MODE (default: the influencer's own, read from the database), so the file asks for mode "platform"; the own-client
// paths are tested in tests/google-credentials.test.ts and tests/google-client-routes.test.ts.
process.env.GOOGLE_CLIENT_MODE = "platform";
process.env.GOOGLE_REDIRECT_URI = "http://localhost:3000/api/google/callback";

const CALENDAR = "https://www.googleapis.com/auth/calendar.events";
const GMAIL = "https://www.googleapis.com/auth/gmail.send";
const NONCE = "nonce-1";

// ---- pure helpers ----

test("the outcome keeps the page's own query (onboarding's ?step=3)", () => {
  assert.deepEqual(outcomeTarget("/dashboard/settings", "connected"), { pathname: "/dashboard/settings", search: "?google=connected" });
  assert.deepEqual(outcomeTarget("/onboarding?step=3", "not-configured"), { pathname: "/onboarding", search: "?step=3&google=not-configured" });
  assert.deepEqual(outcomeTarget("/onboarding?step=3&google=denied", "connected"), { pathname: "/onboarding", search: "?step=3&google=connected" });
});

test("an account switch is a different, known email (case does not matter)", () => {
  assert.equal(isAccountSwitch("a@gmail.com", "b@gmail.com"), true);
  assert.equal(isAccountSwitch("A@Gmail.com", "a@gmail.com"), false);
  assert.equal(isAccountSwitch(null, "b@gmail.com"), false, "an unknown old account cannot be compared");
  assert.equal(isAccountSwitch("a@gmail.com", null), false);
});

test("N1: two accounts are compared by their stable id when both have one, by address only otherwise", () => {
  // A renamed address on the same account is not a switch; an address another account took over is one.
  assert.deepEqual(compareAccounts({ email: "old@x.com", sub: "s1" }, { email: "new@x.com", sub: "s1" }), { different: false, certain: true });
  assert.deepEqual(compareAccounts({ email: "a@x.com", sub: "s1" }, { email: "a@x.com", sub: "s2" }), { different: true, certain: true });
  // One side without a sub (a row from before it was recorded): the address decides, and it is never certain.
  assert.deepEqual(compareAccounts({ email: "old@x.com", sub: null }, { email: "new@x.com", sub: "s1" }), { different: true, certain: false });
  assert.deepEqual(compareAccounts({ email: "Old@x.com", sub: null }, { email: "old@x.com", sub: "s1" }), { different: false, certain: false });
  assert.deepEqual(compareAccounts({ email: null, sub: null }, { email: "new@x.com", sub: "s1" }), { different: false, certain: false });
});

test("N1: a token we do not keep may be revoked only when nothing is connected or the two are known to be different accounts", () => {
  assert.equal(mayRevokeOther({ connected: false, email: "old@x.com" }, { email: "new@x.com" }), true, "no connection to hurt");
  assert.equal(mayRevokeOther({ connected: true, email: "a@x.com", sub: "s1" }, { email: "b@x.com", sub: "s2" }), true, "different ids");
  assert.equal(mayRevokeOther({ connected: true, email: "a@x.com", sub: "s1" }, { email: "b@x.com", sub: "s1" }), false, "renamed, same account");
  assert.equal(mayRevokeOther({ connected: true, email: "a@x.com", sub: null }, { email: "b@x.com", sub: "s2" }), false, "old id unknown");
  assert.equal(mayRevokeOther({ connected: true, email: "a@x.com", sub: "s1" }, { email: "b@x.com", sub: null }), false, "new id unknown");
  assert.equal(mayRevokeOther({ connected: true, email: "a@x.com", sub: "s1" }, { email: "a@x.com", sub: "s1" }), false, "same account");
});

test("N1: the ID token's claims are read defensively", () => {
  const token = (payload: unknown) => `h.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.s`;
  assert.deepEqual(claimsFromIdToken(token({ email: "a@x.com", sub: "1234" })), { email: "a@x.com", sub: "1234" });
  assert.deepEqual(claimsFromIdToken(token({ email: "a@x.com" })), { email: "a@x.com", sub: null });
  assert.deepEqual(claimsFromIdToken(token({ email: 7, sub: 12 })), { email: null, sub: null }, "only strings count");
  assert.deepEqual(claimsFromIdToken(token({ sub: "x".repeat(256) })), { email: null, sub: null }, "an absurd id is not stored");
  assert.deepEqual(claimsFromIdToken(token({ sub: "" })), { email: null, sub: null });
  assert.deepEqual(claimsFromIdToken("garbage"), { email: null, sub: null });
  assert.deepEqual(claimsFromIdToken(undefined), { email: null, sub: null });
});

test("a switch needs confirmation only when upcoming bookings have events and it was not confirmed", () => {
  assert.equal(switchNeedsConfirmation({ liveEvents: 2, confirmed: false }), true);
  assert.equal(switchNeedsConfirmation({ liveEvents: 2, confirmed: true }), false);
  assert.equal(switchNeedsConfirmation({ liveEvents: 0, confirmed: false }), false);
});

// ---- the routes ----

const tokens = {
  liveEvents: 0,
  /** Whether a grant row exists, and the Google account on record (the grant's, or the one remembered at disconnect). */
  connected: true,
  connectedEmail: "old@gmail.com" as string | null,
  /** Whether another influencer profile is connected with the same Google account (Google's revoke would hit it too). */
  shared: false,
  saved: [] as { influencerId: string; email: string | null; sub: string | null; scope: string }[],
  counted: 0,
  /** The stable id stored with the grant (null: connected before it was recorded). */
  connectedSub: null as string | null,
  /** The refresh token stored with the grant, whatever its status (null: no grant, or unreadable), as the one-query read returns it. */
  connectedToken: null as string | null,
  /** What the shared-account lookup was asked, and whether it fails (the database hiccuping during the best-effort revoke). */
  sharedAsked: [] as { email: string | null | undefined; sub: string | null | undefined }[],
  sharedThrows: false,
  /** Everything that happened to the stores and to Google, in order ("save", "revoke:<token>"). */
  order: [] as string[],
};
let auth: { influencerId: string; email: string } | null = { influencerId: "inf1", email: "login@example.com" };

const accountRecord = async () => ({ connected: tokens.connected, email: tokens.connectedEmail, sub: tokens.connectedSub, refreshToken: tokens.connectedToken });
const sharedLookup = async (_influencerId: string, email?: string | null, sub?: string | null) => {
  tokens.sharedAsked.push({ email, sub });
  if (tokens.sharedThrows) throw new Error("database unavailable");
  return tokens.shared;
};

async function loadRoute(which: "connect" | "callback") {
  mock.module("@/lib/auth/session", { namedExports: { getAuth: async () => auth } });
  mock.module("@/lib/google-tokens", {
    namedExports: {
      NONCE_COOKIE: "g_oauth_nonce",
      OAUTH_STATE_PURPOSE: "google-oauth-state",
      googleAccountSharedWithOthers: sharedLookup,
      countLiveCalendarEvents: async () => (tokens.counted++, tokens.liveEvents),
      getGoogleAccountOfRecord: async () => ({ connected: tokens.connected, email: tokens.connectedEmail }),
      getGoogleAccountRecord: accountRecord,
      saveGoogleToken: async (influencerId: string, _rt: string, scope: string, email: string | null, sub: string | null = null) => {
        tokens.order.push("save");
        tokens.saved.push({ influencerId, email, sub, scope });
      },
    },
  });
  mock.module("@/lib/meeting", { namedExports: { requeuePendingMeetings: async () => 0 } });
  return await import(`../app/api/google/${which}/route.ts?${which}=${Math.random()}`);
}

function reset(over: Partial<typeof tokens> = {}) {
  Object.assign(
    tokens,
    { liveEvents: 0, connected: true, connectedEmail: "old@gmail.com", connectedSub: null, connectedToken: null, shared: false, sharedAsked: [], sharedThrows: false, saved: [], counted: 0, order: [] },
    over,
  );
  auth = { influencerId: "inf1", email: "login@example.com" };
}

const connectReq = (query: string) => new NextRequest(`http://localhost:3000/api/google/connect?${query}`);
const locationOf = (res: Response) => new URL(res.headers.get("location") ?? "http://none.invalid/");

test("connect: a switch without confirmation is refused while upcoming bookings have events, and never reaches Google", async () => {
  reset({ liveEvents: 2 });
  const { GET } = await loadRoute("connect");

  const res = await GET(connectReq("returnTo=%2Fdashboard%2Fsettings&switch=1"));

  const to = locationOf(res);
  assert.equal(to.pathname, "/dashboard/settings");
  assert.equal(to.searchParams.get("google"), "confirm-switch");
  assert.equal(res.headers.get("set-cookie"), null, "no OAuth round trip was started");
  mock.reset();
});

test("connect: a confirmed switch goes to Google's account chooser (no login hint) and the state remembers it", async () => {
  reset({ liveEvents: 2 });
  const { GET } = await loadRoute("connect");

  const res = await GET(connectReq("returnTo=%2Fdashboard%2Fsettings&switch=1&confirm=1"));

  const to = locationOf(res);
  assert.equal(to.host, "accounts.google.com");
  assert.equal(to.searchParams.get("login_hint"), null);
  const state = verifyToken<{ i: string; c: number }>("google-oauth-state", to.searchParams.get("state"));
  assert.equal(state?.i, "inf1");
  assert.equal(state?.c, 1);
  assert.match(res.headers.get("set-cookie") ?? "", /g_oauth_nonce=/);
  mock.reset();
});

test("connect: a switch with nothing at stake needs no confirmation", async () => {
  reset({ liveEvents: 0 });
  const { GET } = await loadRoute("connect");
  const res = await GET(connectReq("returnTo=%2Fdashboard%2Fsettings&switch=1"));
  assert.equal(locationOf(res).host, "accounts.google.com");
  mock.reset();
});

test("connect: a plain reconnect is not a switch, hints the connected Google account and is never refused", async () => {
  reset({ liveEvents: 5 });
  const { GET } = await loadRoute("connect");

  const res = await GET(connectReq("returnTo=%2Fdashboard%2Fsettings"));

  const to = locationOf(res);
  assert.equal(to.host, "accounts.google.com");
  assert.equal(to.searchParams.get("login_hint"), "old@gmail.com");
  assert.equal(verifyToken<{ c: number }>("google-oauth-state", to.searchParams.get("state"))?.c, 0);
  assert.equal(tokens.counted, 0, "no extra query on the normal path");
  mock.reset();
});

test("connect: without a stored account the login email is the hint", async () => {
  reset({ connectedEmail: null });
  const { GET } = await loadRoute("connect");
  const res = await GET(connectReq("returnTo=%2Fdashboard%2Fsettings"));
  assert.equal(locationOf(res).searchParams.get("login_hint"), "login@example.com");
  mock.reset();
});

test("connect: the not-configured redirect keeps onboarding's ?step=3", async () => {
  reset();
  const saved = process.env.GOOGLE_CLIENT_ID;
  delete process.env.GOOGLE_CLIENT_ID;
  try {
    const { GET } = await loadRoute("connect");
    const res = await GET(connectReq("returnTo=%2Fonboarding%3Fstep%3D3"));
    const to = locationOf(res);
    assert.equal(to.pathname, "/onboarding");
    assert.equal(to.searchParams.get("step"), "3");
    assert.equal(to.searchParams.get("google"), "not-configured");
  } finally {
    process.env.GOOGLE_CLIENT_ID = saved;
    mock.reset();
  }
});

test("connect: a visitor who is not logged in is sent to the login page", async () => {
  reset();
  auth = null;
  const { GET } = await loadRoute("connect");
  const res = await GET(connectReq("returnTo=%2Fdashboard%2Fsettings&switch=1&confirm=1"));
  assert.equal(locationOf(res).pathname, "/login");
  mock.reset();
});

// ---- the callback ----

const idToken = (email: string, sub?: string) => `x.${Buffer.from(JSON.stringify({ email, ...(sub ? { sub } : {}) })).toString("base64url")}.y`;

/** What the token endpoint hands out: the account's address, its stable id (omitted: an ID token without one), the permissions granted. */
type GoogleGrant = { email: string; scope: string; sub?: string; revokeFails?: boolean };

/** Replaces global fetch with Google's token and revoke endpoints; `google` says what the token endpoint hands out. */
function fakeGoogle(google: GoogleGrant) {
  const revoked: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL) => {
    const u = String(url);
    if (u.includes("/revoke")) {
      if (google.revokeFails) throw new Error("network down");
      const token = new URL(u).searchParams.get("token") ?? "";
      revoked.push(token);
      tokens.order.push(`revoke:${token}`);
      return new Response("{}", { status: 200 });
    }
    if (u.includes("/token")) {
      return new Response(JSON.stringify({ refresh_token: "rt-new", scope: google.scope, id_token: idToken(google.email, google.sub) }), { status: 200 });
    }
    throw new Error(`unexpected fetch ${u}`);
  }) as typeof fetch;
  return { revoked, restore: () => void (globalThis.fetch = realFetch) };
}

function callbackReq(opts: { c?: number; r?: string } = {}) {
  const state = signToken("google-oauth-state", { i: "inf1", n: NONCE, r: opts.r ?? "/dashboard/settings", g: 1, c: opts.c ?? 0 }, 600);
  return new NextRequest(`http://localhost:3000/api/google/callback?code=abc&state=${encodeURIComponent(state)}`, {
    headers: { cookie: `g_oauth_nonce=${NONCE}` },
  });
}

async function runCallback(google: GoogleGrant, opts: { c?: number; r?: string } = {}) {
  const fake = fakeGoogle(google);
  try {
    const { GET } = await loadRoute("callback");
    const res = await GET(callbackReq(opts));
    return { outcome: locationOf(res).searchParams.get("google"), to: locationOf(res), revoked: fake.revoked };
  } finally {
    fake.restore();
    mock.reset();
  }
}

test("redirects go to the public APP_URL, never to the address the server is bound to (0.0.0.0:3000 in a container)", async () => {
  reset({ connected: false, connectedEmail: null });
  const saved = process.env.APP_URL;
  process.env.APP_URL = "https://auto.example.test";
  try {
    // connect, signed out: the login redirect
    auth = null;
    const connect = await loadRoute("connect");
    const out = await connect.GET(new NextRequest("http://0.0.0.0:3000/api/google/connect?returnTo=%2Fdashboard%2Fsettings"));
    assert.equal(locationOf(out).origin, "https://auto.example.test");
    assert.equal(locationOf(out).pathname, "/login");
    assert.equal(locationOf(out).searchParams.get("next"), "/dashboard/settings");
    mock.reset();

    // callback: the page the influencer started from, with the outcome
    reset({ connected: false, connectedEmail: null });
    const fake = fakeGoogle({ email: "new@gmail.com", scope: `openid email ${CALENDAR}` });
    try {
      const callback = await loadRoute("callback");
      const state = signToken("google-oauth-state", { i: "inf1", n: NONCE, r: "/dashboard/settings", g: 1, c: 0 }, 600);
      const res = await callback.GET(new NextRequest(`http://0.0.0.0:3000/api/google/callback?code=abc&state=${encodeURIComponent(state)}`, {
        headers: { cookie: `g_oauth_nonce=${NONCE}` },
      }));
      const to = locationOf(res);
      assert.equal(to.origin, "https://auto.example.test");
      assert.equal(to.pathname, "/dashboard/settings");
      assert.ok(String(to.searchParams.get("google")).startsWith("connected"), "the outcome of a successful connect");
    } finally {
      fake.restore();
      mock.reset();
    }
  } finally {
    if (saved === undefined) delete process.env.APP_URL;
    else process.env.APP_URL = saved;
  }
});

test("callback: Calendar unticked on a first connection or another account -> the token Google issued is revoked, nothing saved", async () => {
  reset({ connected: false, connectedEmail: null });
  const first = await runCallback({ email: "new@gmail.com", scope: `openid email ${GMAIL}` });
  assert.equal(first.outcome, "missing-permission");
  assert.deepEqual(first.revoked, ["rt-new"]);

  // Both accounts have a stable id and the ids differ: a different account's grant cannot hurt the connection that works.
  reset({ connected: true, connectedEmail: "old@gmail.com", connectedSub: "sub-old" });
  const other = await runCallback({ email: "other@gmail.com", sub: "sub-other", scope: `openid email ${GMAIL}` });
  assert.equal(other.outcome, "missing-permission");
  assert.deepEqual(other.revoked, ["rt-new"]);
  assert.deepEqual(tokens.saved, []);
});

test("callback: Calendar unticked on the account that is already connected -> NOT revoked (Google would end the working connection too)", async () => {
  reset({ connected: true, connectedEmail: "old@gmail.com", connectedSub: "sub-old" });
  const r = await runCallback({ email: "OLD@gmail.com", sub: "sub-old", scope: `openid email ${GMAIL}` });
  assert.equal(r.outcome, "missing-permission");
  assert.deepEqual(r.revoked, []);
  assert.deepEqual(tokens.saved, []);

  // A connection whose account is unknown is treated the same way: better a stray grant than killing a working one.
  reset({ connected: true, connectedEmail: null });
  assert.deepEqual((await runCallback({ email: "any@gmail.com", sub: "sub-any", scope: `openid email ${GMAIL}` })).revoked, []);
});

test("N1: Calendar unticked after the account's address was renamed (same stable id) -> NOT revoked", async () => {
  reset({ connected: true, connectedEmail: "old@gmail.com", connectedSub: "sub-1" });
  const r = await runCallback({ email: "renamed@gmail.com", sub: "sub-1", scope: `openid email ${GMAIL}` });
  assert.equal(r.outcome, "missing-permission");
  assert.deepEqual(r.revoked, [], "it is the same Google account: revoking would end the connection that works");
});

test("N1: Calendar unticked on another address while the stored account has no stable id yet -> NOT revoked (cannot tell a rename from a switch)", async () => {
  reset({ connected: true, connectedEmail: "old@gmail.com", connectedSub: null });
  const r = await runCallback({ email: "other@gmail.com", sub: "sub-other", scope: `openid email ${GMAIL}` });
  assert.equal(r.outcome, "missing-permission");
  assert.deepEqual(r.revoked, []);
  // Nor when Google's ID token carries no id although the stored account has one.
  reset({ connected: true, connectedEmail: "old@gmail.com", connectedSub: "sub-old" });
  assert.deepEqual((await runCallback({ email: "other@gmail.com", scope: `openid email ${GMAIL}` })).revoked, []);
});

test("callback: after a disconnect, a different account is still a switch (the account is remembered) and is refused unconfirmed", async () => {
  reset({ connected: false, connectedEmail: "old@gmail.com", liveEvents: 3 }); // no grant row, but the old account is remembered
  const r = await runCallback({ email: "other@gmail.com", scope: `openid email ${CALENDAR}` });
  assert.equal(r.outcome, "switch-unconfirmed");
  assert.deepEqual(r.revoked, ["rt-new"]);
  assert.deepEqual(tokens.saved, []);
});

test("callback: after a disconnect, the same account reconnects, and a confirmed switch to another account goes through", async () => {
  reset({ connected: false, connectedEmail: "old@gmail.com", liveEvents: 3 });
  assert.equal((await runCallback({ email: "old@gmail.com", scope: `openid email ${CALENDAR} ${GMAIL}` })).outcome, "connected");
  reset({ connected: false, connectedEmail: "old@gmail.com", liveEvents: 3 });
  const switched = await runCallback({ email: "other@gmail.com", scope: `openid email ${CALENDAR} ${GMAIL}` }, { c: 1 });
  assert.equal(switched.outcome, "connected");
  assert.deepEqual(tokens.saved.map((s) => s.email), ["other@gmail.com"]);
});

const BOTH = `openid email ${CALENDAR} ${GMAIL}`;

test("callback: a confirmed switch revokes the OLD account's grant (its token is overwritten, so nobody could revoke it later), after the new one is saved; a reconnect of the same account does not", async () => {
  const known = { connected: true, connectedEmail: "old@gmail.com", connectedSub: "sub-old", connectedToken: "rt-old", liveEvents: 2 };
  reset(known);
  const switched = await runCallback({ email: "other@gmail.com", sub: "sub-other", scope: BOTH }, { c: 1 });
  assert.equal(switched.outcome, "connected");
  assert.deepEqual(tokens.saved.map((s) => [s.email, s.sub]), [["other@gmail.com", "sub-other"]], "the new account's id is stored with it");
  assert.deepEqual(switched.revoked, ["rt-old"], "the replaced grant is revoked at Google, the new one is kept");
  assert.deepEqual(tokens.order, ["save", "revoke:rt-old"], "the new connection is safe before anything is revoked");

  reset(known);
  const same = await runCallback({ email: "OLD@gmail.com", sub: "sub-old", scope: BOTH }, { c: 1 });
  assert.equal(same.outcome, "connected");
  assert.deepEqual(same.revoked, [], "the same account: Google's revoke would end the very connection just made");

  // Another influencer profile uses the old account: Google's revoke ends the app's access for the whole account, so it is skipped.
  reset({ ...known, shared: true });
  const shared = await runCallback({ email: "other@gmail.com", sub: "sub-other", scope: `openid email ${CALENDAR}` }, { c: 1 });
  assert.equal(shared.outcome, "connected-no-gmail");
  assert.deepEqual(shared.revoked, []);
  assert.deepEqual(tokens.sharedAsked, [{ email: "old@gmail.com", sub: "sub-old" }], "asked about the OLD account, by address and by id");

  // A grant whose token cannot be read has nothing to revoke.
  reset({ ...known, connectedToken: null });
  assert.deepEqual((await runCallback({ email: "other@gmail.com", sub: "sub-other", scope: BOTH }, { c: 1 })).revoked, []);
});

test("N1: an address renamed on the SAME Google account is not a switch: nothing is refused, nothing revoked", async () => {
  const renamed = { connected: true, connectedEmail: "old@gmail.com", connectedSub: "sub-1", connectedToken: "rt-old", liveEvents: 3 };

  // Reconnect (no Switch account) with upcoming events: an email-only comparison would call this a switch and refuse it.
  reset(renamed);
  const reconnect = await runCallback({ email: "renamed@gmail.com", sub: "sub-1", scope: BOTH });
  assert.equal(reconnect.outcome, "connected");
  assert.deepEqual(tokens.saved.map((s) => [s.email, s.sub]), [["renamed@gmail.com", "sub-1"]]);
  assert.deepEqual(reconnect.revoked, [], "revoking would end the connection that was just made");

  // The same through "Switch account" (confirmed), and with nothing at stake ("Send from my Gmail" with no upcoming bookings).
  reset(renamed);
  const confirmed = await runCallback({ email: "renamed@gmail.com", sub: "sub-1", scope: BOTH }, { c: 1 });
  assert.equal(confirmed.outcome, "connected");
  assert.deepEqual(confirmed.revoked, []);
  reset({ ...renamed, liveEvents: 0 });
  const gmailButton = await runCallback({ email: "renamed@gmail.com", sub: "sub-1", scope: BOTH });
  assert.equal(gmailButton.outcome, "connected");
  assert.deepEqual(gmailButton.revoked, []);
});

test("N1: a stored account without a stable id (connected before it was recorded) is compared by address and never leads to a revoke; the id is recorded now", async () => {
  reset({ connected: true, connectedEmail: "old@gmail.com", connectedSub: null, connectedToken: "rt-old", liveEvents: 2 });
  const r = await runCallback({ email: "other@gmail.com", sub: "sub-other", scope: BOTH }, { c: 1 });
  assert.equal(r.outcome, "connected", "the confirmed switch still goes through");
  assert.deepEqual(r.revoked, [], "but the old grant is left alone: it could be the same account under an older address");
  assert.deepEqual(tokens.saved.map((s) => s.sub), ["sub-other"]);

  // A plain reconnect of the same address fills the id in.
  reset({ connected: true, connectedEmail: "old@gmail.com", connectedSub: null, connectedToken: "rt-old", liveEvents: 2 });
  const same = await runCallback({ email: "old@gmail.com", sub: "sub-old", scope: BOTH });
  assert.equal(same.outcome, "connected");
  assert.deepEqual(tokens.saved.map((s) => s.sub), ["sub-old"]);
  assert.deepEqual(same.revoked, []);
});

test("N1/N2: the replaced grant is revoked whatever its status (a 'reconnect needed' grant is read as well), never the token just issued", async () => {
  // The one-query read returns the token of a flagged grant too (tests/google-tokens.test.ts covers the query itself).
  reset({ connected: true, connectedEmail: "old@gmail.com", connectedSub: "sub-old", connectedToken: "rt-flagged", liveEvents: 2 });
  const r = await runCallback({ email: "other@gmail.com", sub: "sub-other", scope: BOTH }, { c: 1 });
  assert.deepEqual(r.revoked, ["rt-flagged"]);

  // Google handed out the very token we already hold: revoking "the old one" would revoke the new one.
  reset({ connected: true, connectedEmail: "old@gmail.com", connectedSub: "sub-old", connectedToken: "rt-new", liveEvents: 2 });
  const same = await runCallback({ email: "other@gmail.com", sub: "sub-other", scope: BOTH }, { c: 1 });
  assert.equal(same.outcome, "connected");
  assert.deepEqual(same.revoked, []);
});

test("N1: a failing revoke (Google unreachable, or the shared-account lookup failing) still ends in 'connected'", async () => {
  const base = { connected: true, connectedEmail: "old@gmail.com", connectedSub: "sub-old", connectedToken: "rt-old", liveEvents: 2 };

  reset(base);
  const unreachable = await runCallback({ email: "other@gmail.com", sub: "sub-other", scope: BOTH, revokeFails: true }, { c: 1 });
  assert.equal(unreachable.outcome, "connected");
  assert.deepEqual(tokens.saved.map((s) => s.email), ["other@gmail.com"], "the new connection was saved first");
  assert.deepEqual(unreachable.revoked, []);

  reset({ ...base, sharedThrows: true });
  const realError = console.error;
  let logged = 0;
  console.error = () => void logged++;
  try {
    const lookupFails = await runCallback({ email: "other@gmail.com", sub: "sub-other", scope: BOTH }, { c: 1 });
    assert.equal(lookupFails.outcome, "connected");
    assert.deepEqual(tokens.saved.map((s) => s.email), ["other@gmail.com"]);
    assert.equal(logged, 1, "logged, not thrown");
  } finally {
    console.error = realError;
  }
});

// ---- disconnect (DELETE /api/dashboard/google) ----

async function loadDisconnect() {
  const calls = { deleted: 0 };
  mock.module("@/lib/auth/session", {
    namedExports: { requireApiAuth: async () => ({ influencerId: "inf1" }), requireRecentAuth: async () => ({ influencerId: "inf1" }) },
  });
  mock.module("@/lib/google-tokens", {
    namedExports: {
      countLiveCalendarEvents: async () => tokens.liveEvents,
      getGoogleAccountRecord: accountRecord,
      googleAccountSharedWithOthers: sharedLookup,
      deleteGoogleToken: async () => (calls.deleted++, "rt-old"),
      getGoogleStatus: async () => ({ state: "not-connected", requestsGmail: true }),
    },
  });
  const route = await import(`../app/api/dashboard/google/route.ts?disconnect=${Math.random()}`);
  return { DELETE: route.DELETE as (req: Request) => Promise<Response>, calls };
}

const deleteReq = (body?: unknown) =>
  new Request("http://localhost:3000/api/dashboard/google", {
    method: "DELETE",
    ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
  });

test("disconnect: refused without confirmation while upcoming bookings have events (the server asks, not just the dialog)", async () => {
  reset({ liveEvents: 2 });
  const fake = fakeGoogle({ email: "x", scope: "" });
  try {
    const { DELETE, calls } = await loadDisconnect();

    for (const body of [undefined, {}, { confirm: false }, { confirm: "true" }]) {
      const res = await DELETE(deleteReq(body));
      assert.equal(res.status, 409);
      const json = (await res.json()) as { needsConfirmation: boolean; liveEvents: number; error: string };
      assert.equal(json.needsConfirmation, true);
      assert.equal(json.liveEvents, 2);
      assert.match(json.error, /2 upcoming bookings/);
    }
    assert.equal(calls.deleted, 0, "nothing was disconnected");
    assert.deepEqual(fake.revoked, []);
  } finally {
    fake.restore();
    mock.reset();
  }
});

test("disconnect: confirmed, or with nothing at stake, disconnects and revokes the grant", async () => {
  reset({ liveEvents: 2 });
  const fake = fakeGoogle({ email: "x", scope: "" });
  try {
    const { DELETE, calls } = await loadDisconnect();
    assert.equal((await DELETE(deleteReq({ confirm: true }))).status, 200);
    assert.equal(calls.deleted, 1);
    assert.deepEqual(fake.revoked, ["rt-old"]);

    tokens.liveEvents = 0;
    assert.equal((await DELETE(deleteReq())).status, 200);
    assert.equal(calls.deleted, 2);
  } finally {
    fake.restore();
    mock.reset();
  }
});

test("callback: a different Google account that was not chosen with Switch account is refused when events would be stranded", async () => {
  reset({ liveEvents: 3, connectedSub: "sub-old" });
  const r = await runCallback({ email: "other@gmail.com", sub: "sub-other", scope: `openid email ${CALENDAR}` });
  assert.equal(r.outcome, "switch-unconfirmed");
  assert.deepEqual(r.revoked, ["rt-new"], "the new account's grant is revoked (both ids are known and differ), the old connection is untouched");
  assert.deepEqual(tokens.saved, []);
});

test("N1: a refused switch revokes the new grant only when the two accounts are known to differ by their stable id", async () => {
  // Another address, but the stored account has no id yet: still refused (events would be stranded if it is a real switch), not revoked.
  reset({ liveEvents: 3, connectedSub: null });
  const unknown = await runCallback({ email: "other@gmail.com", sub: "sub-other", scope: `openid email ${CALENDAR}` });
  assert.equal(unknown.outcome, "switch-unconfirmed");
  assert.deepEqual(unknown.revoked, [], "it could be the same account under an older address, and the revoke would end the working connection");
  assert.deepEqual(tokens.saved, []);

  // The same address, different id (the address was taken over by someone else): a switch, refused and revoked.
  reset({ liveEvents: 3, connectedSub: "sub-old" });
  const takenOver = await runCallback({ email: "old@gmail.com", sub: "sub-stranger", scope: `openid email ${CALENDAR}` });
  assert.equal(takenOver.outcome, "switch-unconfirmed");
  assert.deepEqual(takenOver.revoked, ["rt-new"]);
});

test("callback: reconnecting the same account works (case-insensitive) and keeps the page's query", async () => {
  reset({ liveEvents: 3 });
  const r = await runCallback({ email: "OLD@gmail.com", scope: `openid email ${CALENDAR} ${GMAIL}` }, { r: "/onboarding?step=3" });
  assert.equal(r.outcome, "connected");
  assert.equal(r.to.searchParams.get("step"), "3");
  assert.equal(tokens.saved.length, 1);
  assert.deepEqual(r.revoked, []);
});

test("callback: a switch the influencer confirmed goes through", async () => {
  reset({ liveEvents: 3 });
  const r = await runCallback({ email: "other@gmail.com", scope: `openid email ${CALENDAR} ${GMAIL}` }, { c: 1 });
  assert.equal(r.outcome, "connected");
  assert.deepEqual(tokens.saved.map((s) => s.email), ["other@gmail.com"]);
});

test("callback: a different account with no upcoming events at stake, or no known old account, is fine", async () => {
  reset({ liveEvents: 0 });
  assert.equal((await runCallback({ email: "other@gmail.com", scope: `openid email ${CALENDAR}` })).outcome, "connected-no-gmail");
  reset({ liveEvents: 4, connectedEmail: null });
  assert.equal((await runCallback({ email: "other@gmail.com", scope: `openid email ${CALENDAR}` })).outcome, "connected-no-gmail");
  assert.equal(tokens.counted, 0, "an unknown old account is not even counted");
});

// ---- S6: Google's revoke ends the app's access for the whole Google account ----

test("S6: a refused grant is not revoked while another influencer profile is connected with the same Google account", async () => {
  // Calendar unticked on a first connection: normally revoked (see above); not when the account is in use elsewhere.
  reset({ connected: false, connectedEmail: null, shared: true });
  const unticked = await runCallback({ email: "shared@gmail.com", scope: `openid email ${GMAIL}` });
  assert.equal(unticked.outcome, "missing-permission");
  assert.deepEqual(unticked.revoked, [], "revoking would disconnect the other profile too");

  // A refused switch: same.
  reset({ connected: true, connectedEmail: "old@gmail.com", connectedSub: "sub-old", liveEvents: 3, shared: true });
  const refused = await runCallback({ email: "shared@gmail.com", sub: "sub-shared", scope: `openid email ${CALENDAR}` });
  assert.equal(refused.outcome, "switch-unconfirmed");
  assert.deepEqual(refused.revoked, []);
  assert.deepEqual(tokens.sharedAsked, [{ email: "shared@gmail.com", sub: "sub-shared" }], "asked about the NEW account, by address and by id");
  assert.deepEqual(tokens.saved, [], "and it is still refused");

  // Nobody else uses the account: revoked as before.
  reset({ connected: true, connectedEmail: "old@gmail.com", connectedSub: "sub-old", liveEvents: 3, shared: false });
  assert.deepEqual((await runCallback({ email: "alone@gmail.com", sub: "sub-alone", scope: `openid email ${CALENDAR}` })).revoked, ["rt-new"]);
});

test("S6: disconnecting deletes our copy but does not revoke at Google while another profile uses the same account", async () => {
  reset({ liveEvents: 0, shared: true });
  const fake = fakeGoogle({ email: "x", scope: "" });
  try {
    tokens.connectedSub = "sub-old";
    const { DELETE, calls } = await loadDisconnect();
    assert.equal((await DELETE(deleteReq())).status, 200);
    assert.equal(calls.deleted, 1, "this profile is disconnected");
    assert.deepEqual(fake.revoked, [], "but the shared Google account is left authorised for the other profile");
    assert.deepEqual(tokens.sharedAsked, [{ email: "old@gmail.com", sub: "sub-old" }], "matched by address and by stable id");
  } finally {
    fake.restore();
    mock.reset();
  }
});
