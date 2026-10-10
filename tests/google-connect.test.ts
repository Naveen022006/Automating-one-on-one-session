import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { NextRequest } from "next/server";
import { isAccountSwitch, outcomeTarget, switchNeedsConfirmation } from "../lib/google-connect";
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

test("a switch needs confirmation only when upcoming bookings have events and it was not confirmed", () => {
  assert.equal(switchNeedsConfirmation({ liveEvents: 2, confirmed: false }), true);
  assert.equal(switchNeedsConfirmation({ liveEvents: 2, confirmed: true }), false);
  assert.equal(switchNeedsConfirmation({ liveEvents: 0, confirmed: false }), false);
});

// ---- the routes ----

const tokens = {
  liveEvents: 0,
  connectedEmail: "old@gmail.com" as string | null,
  saved: [] as { influencerId: string; email: string | null; scope: string }[],
  counted: 0,
};
let auth: { influencerId: string; email: string } | null = { influencerId: "inf1", email: "login@example.com" };

async function loadRoute(which: "connect" | "callback") {
  mock.module("@/lib/auth/session", { namedExports: { getAuth: async () => auth } });
  mock.module("@/lib/google-tokens", {
    namedExports: {
      NONCE_COOKIE: "g_oauth_nonce",
      OAUTH_STATE_PURPOSE: "google-oauth-state",
      countLiveCalendarEvents: async () => (tokens.counted++, tokens.liveEvents),
      getConnectedGoogleEmail: async () => tokens.connectedEmail,
      saveGoogleToken: async (influencerId: string, _rt: string, scope: string, email: string | null) => void tokens.saved.push({ influencerId, email, scope }),
    },
  });
  mock.module("@/lib/meeting", { namedExports: { requeuePendingMeetings: async () => 0 } });
  return await import(`../app/api/google/${which}/route.ts?${which}=${Math.random()}`);
}

function reset(over: Partial<typeof tokens> = {}) {
  Object.assign(tokens, { liveEvents: 0, connectedEmail: "old@gmail.com", saved: [], counted: 0 }, over);
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

const idToken = (email: string) => `x.${Buffer.from(JSON.stringify({ email })).toString("base64url")}.y`;

/** Replaces global fetch with Google's token and revoke endpoints; `google` says what the token endpoint hands out. */
function fakeGoogle(google: { email: string; scope: string }) {
  const revoked: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL) => {
    const u = String(url);
    if (u.includes("/revoke")) {
      revoked.push(new URL(u).searchParams.get("token") ?? "");
      return new Response("{}", { status: 200 });
    }
    if (u.includes("/token")) {
      return new Response(JSON.stringify({ refresh_token: "rt-new", scope: google.scope, id_token: idToken(google.email) }), { status: 200 });
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

async function runCallback(google: { email: string; scope: string }, opts: { c?: number; r?: string } = {}) {
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

test("callback: Calendar permission unticked -> the token Google already issued is revoked and nothing is saved", async () => {
  reset();
  const r = await runCallback({ email: "old@gmail.com", scope: `openid email ${GMAIL}` });
  assert.equal(r.outcome, "missing-permission");
  assert.deepEqual(r.revoked, ["rt-new"]);
  assert.deepEqual(tokens.saved, []);
});

test("callback: a different Google account that was not chosen with Switch account is refused when events would be stranded", async () => {
  reset({ liveEvents: 3 });
  const r = await runCallback({ email: "other@gmail.com", scope: `openid email ${CALENDAR}` });
  assert.equal(r.outcome, "switch-unconfirmed");
  assert.deepEqual(r.revoked, ["rt-new"], "the new account's grant is revoked, the old connection is untouched");
  assert.deepEqual(tokens.saved, []);
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
