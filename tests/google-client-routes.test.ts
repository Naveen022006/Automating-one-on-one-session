// Integration test of the influencer-owned Google client (doc/15): GET/POST /api/dashboard/google-client, and the OAuth connect and
// callback routes that use it. Needs DATABASE_URL, TOKEN_ENCRYPTION_KEY, APP_SECRET; skipped otherwise.
//
// Only `next/headers` (the cookie a request carries), the booking re-queue after a connection, and global fetch (Google's token and
// revoke endpoints) are replaced; nothing reaches Google. What it pins:
//   - the gate (401 signed out) and the exact key sets, through assertNoSecretKeys (the one allowed name is the boolean clientSecretSaved);
//   - a pair is saved only after Google accepted it; the secret is stored encrypted, bound to its influencer, and is in no response, log
//     line or activity row; the activity rows carry a masked tail of the client ID only;
//   - connect and callback use the signed-in influencer's OWN client, never another's and never the shared pair in the default mode, and a
//     missing client is a redirect with a plain outcome and no call to Google;
//   - replacing the client with a different ID flags the connection and revokes the old token; the same ID with a new secret keeps it;
//   - removing the client needs the disconnect confirmation when events exist, deletes the connection made with it, and leaves a
//     connection made with the shared pair alone;
//   - the save endpoint is rate limited per influencer.
import "dotenv/config";
import assert from "node:assert/strict";
import { after, before, mock, test } from "node:test";
import { NextRequest } from "next/server";
import { decryptSecret } from "../lib/crypto";
import { prisma } from "../lib/db";
import { signToken, verifyToken } from "../lib/signing";
import { assertNoSecretKeys } from "./helpers/assert-no-secret-keys";

const skip = process.env.DATABASE_URL && process.env.TOKEN_ENCRYPTION_KEY && process.env.APP_SECRET ? false : "DATABASE_URL / TOKEN_ENCRYPTION_KEY / APP_SECRET not set";
const run = `${Date.now()}${Math.floor(Math.random() * 1000)}`;

const ENV_KEYS = ["GOOGLE_CLIENT_MODE", "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_REDIRECT_URI", "GOOGLE_REQUEST_GMAIL_SEND", "MOCK_PROVIDERS_URL", "APP_URL", "RATE_LIMIT_STORE", "REDIS_URL", "RATE_LIMIT_ENABLED", "RATE_LIMIT_MULTIPLIER"] as const;
const savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};
let envSaved = false;
const realFetch = globalThis.fetch;
const realLog = { log: console.log, error: console.error, warn: console.warn };
const logged: string[] = [];

const CALENDAR = "https://www.googleapis.com/auth/calendar.events";
const GMAIL = "https://www.googleapis.com/auth/gmail.send";
const idOf = (tag: string) => `${run}${[...tag].map((ch) => ch.charCodeAt(0)).join("")}-client${tag}.apps.googleusercontent.com`;
const secretOf = (tag: string) => `GOCSPX-${tag}secret0123456789abcdefgh`;

interface Owner {
  label: string;
  influencerId: string;
  cookie: string;
}
const owners: Record<"A" | "B" | "C" | "D", Owner> = {
  A: { label: "A", influencerId: "", cookie: "" },
  B: { label: "B", influencerId: "", cookie: "" },
  C: { label: "C", influencerId: "", cookie: "" },
  D: { label: "D", influencerId: "", cookie: "" },
};
const { A, B, C, D } = owners;

const jar = new Map<string, string>();
type Handler = (req: Request) => Promise<Response>;
let clientRoute: { GET: () => Promise<Response>; POST: Handler };
let connectRoute: { GET: (req: NextRequest) => Promise<Response> };
let callbackRoute: { GET: (req: NextRequest) => Promise<Response> };
let authLib: typeof import("../lib/auth/session");
let credsLib: typeof import("../lib/google-credentials");
let tokensLib: typeof import("../lib/google-tokens");

type GoogleCall = { kind: "token" | "revoke"; form: URLSearchParams; token: string | null };
const googleCalls: GoogleCall[] = [];
const tokenCalls = () => googleCalls.filter((c) => c.kind === "token");
const revokes = () => googleCalls.filter((c) => c.kind === "revoke").map((c) => c.token);

function installFakeGoogle() {
  const body = (status: number, o: unknown) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    if (u.startsWith("https://oauth2.googleapis.com/token")) {
      const form = new URLSearchParams(String(init?.body ?? ""));
      googleCalls.push({ kind: "token", form, token: null });
      const secret = form.get("client_secret") ?? "";
      if (secret.includes("NETDOWN")) throw new TypeError("fetch failed");
      if (secret.includes("WRONG")) return body(401, { error: "invalid_client", error_description: "Unauthorized" });
      const code = form.get("code") ?? "";
      if (code.startsWith("client-check")) return body(400, { error: "invalid_grant", error_description: "Malformed auth code." });
      if (code === "real-code") {
        const clientId = form.get("client_id") ?? "";
        const idToken = `h.${Buffer.from(JSON.stringify({ email: `g-${clientId.slice(0, 20)}@example.com`, sub: `sub-${clientId}` })).toString("base64url")}.s`;
        return body(200, { refresh_token: `rt-${clientId}`, scope: `openid email ${CALENDAR} ${GMAIL}`, id_token: idToken });
      }
      return body(400, { error: "invalid_grant", error_description: "Bad Request" });
    }
    if (u.startsWith("https://oauth2.googleapis.com/revoke")) {
      googleCalls.push({ kind: "revoke", form: new URLSearchParams(), token: new URL(u).searchParams.get("token") });
      return body(200, {});
    }
    throw new Error(`unexpected network call in a test: ${u}`);
  }) as typeof fetch;
}

const asUser = (o: Owner | null) => {
  jar.clear();
  if (o) jar.set(authLib.sessionCookieName(), o.cookie);
};
const call = async (handler: () => Promise<Response>) => {
  const res = await handler();
  return { status: res.status, headers: res.headers, body: (await res.json()) as Record<string, unknown> };
};
const postJson = (o: Owner | null, body: unknown) => {
  asUser(o);
  return call(() => clientRoute.POST(new Request("http://localhost:3000/api/dashboard/google-client", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })));
};
const getView = (o: Owner | null) => {
  asUser(o);
  return call(() => clientRoute.GET());
};
const save = (o: Owner, clientId: string, clientSecret: string) => postJson(o, { action: "save-client", clientId, clientSecret });
const keys = (o: unknown) => Object.keys(o as object).sort();
const rowOf = (o: Owner) => prisma.influencerGoogleClient.findUnique({ where: { influencerId: o.influencerId } });
const grantOf = (o: Owner) => prisma.googleToken.findUnique({ where: { influencerId: o.influencerId } });
const activities = (o: Owner, action: string) => prisma.influencerActivity.findMany({ where: { influencerId: o.influencerId, action }, orderBy: { createdAt: "asc" } });

function connectReq(query = "returnTo=%2Fdashboard%2Fsettings") {
  return new NextRequest(`http://localhost:3000/api/google/connect?${query}`);
}
const locationOf = (res: Response) => new URL(res.headers.get("location") ?? "http://none.invalid/");

/** A callback request as Google's redirect would make it: a signed state for `o`, the matching cookie, and a code. */
function callbackReq(stateOwner: Owner, k: "own" | "platform" | undefined, code = "real-code") {
  const nonce = `nonce-${run}`;
  const state = signToken("google-oauth-state", { i: stateOwner.influencerId, n: nonce, r: "/dashboard/settings", g: 1, c: 0, ...(k ? { k } : {}) }, 600);
  return new NextRequest(`http://localhost:3000/api/google/callback?code=${code}&state=${encodeURIComponent(state)}`, { headers: { cookie: `g_oauth_nonce=${nonce}` } });
}

before(async () => {
  if (skip) return;
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  envSaved = true;
  process.env.RATE_LIMIT_STORE = "memory";
  process.env.APP_URL = "http://localhost:3000";
  console.log = (...a: unknown[]) => void logged.push(a.map(String).join(" "));
  console.error = (...a: unknown[]) => void logged.push(a.map(String).join(" "));
  console.warn = (...a: unknown[]) => void logged.push(a.map(String).join(" "));
  installFakeGoogle();

  mock.module("next/headers", {
    namedExports: {
      cookies: async () => ({ get: (name: string) => (jar.has(name) ? { name, value: jar.get(name) } : undefined) }),
      headers: async () => new Headers(),
    },
  });
  mock.module("@/lib/meeting", { namedExports: { requeuePendingMeetings: async () => 0 } });

  authLib = await import("../lib/auth/session");
  credsLib = await import("../lib/google-credentials");
  tokensLib = await import("../lib/google-tokens");
  clientRoute = await import("../app/api/dashboard/google-client/route");
  connectRoute = await import("../app/api/google/connect/route");
  callbackRoute = await import("../app/api/google/callback/route");

  for (const o of Object.values(owners)) {
    const inf = await prisma.influencer.create({ data: { slug: `gcr${o.label.toLowerCase()}${run}`, name: `Gcr ${o.label} ${run}`, email: `gcr-${o.label}-${run}@example.com`, onboardedAt: new Date() } });
    o.influencerId = inf.id;
    const user = await prisma.user.create({
      data: { email: `gcr-user-${o.label}-${run}@example.com`, passwordHash: "not-a-real-hash", emailVerifiedAt: new Date(), termsAcceptedAt: new Date(), influencerId: inf.id },
    });
    o.cookie = await authLib.createSession(user.id);
  }
});

after(async () => {
  console.log = realLog.log;
  console.error = realLog.error;
  console.warn = realLog.warn;
  globalThis.fetch = realFetch;
  try {
    if (!skip) {
      const step = async (what: string, fn: () => Promise<unknown>) => {
        try {
          await fn();
        } catch (e) {
          console.error(`[google-client-routes] cleanup step failed (${what}):`, e instanceof Error ? e.message : e);
        }
      };
      const ids = Object.values(owners).map((o) => o.influencerId).filter(Boolean);
      if (ids.length) {
        await step("bookings", () => prisma.booking.deleteMany({ where: { session: { service: { influencerId: { in: ids } } } } }));
        await step("sessions", () => prisma.session.deleteMany({ where: { service: { influencerId: { in: ids } } } }));
        await step("services", () => prisma.service.deleteMany({ where: { influencerId: { in: ids } } }));
        await step("influencers", () => prisma.influencer.deleteMany({ where: { id: { in: ids } } }));
      }
    }
  } finally {
    if (envSaved) {
      for (const k of ENV_KEYS) {
        if (savedEnv[k] === undefined) delete process.env[k];
        else process.env[k] = savedEnv[k];
      }
    }
    await prisma.$disconnect().catch(() => undefined);
  }
});

test("signed out: the card endpoint answers 401 for both GET and POST, and nothing happens", { skip }, async () => {
  assert.equal((await getView(null)).status, 401);
  assert.equal((await postJson(null, { action: "save-client", clientId: idOf("a"), clientSecret: secretOf("A") })).status, 401);
  assert.equal(googleCalls.length, 0);
  assert.equal(await rowOf(A), null);
});

test("GET: exactly the hand-picked keys, the exact redirect URI and scopes, no client yet, never a secret", { skip }, async () => {
  const out = await getView(A);
  assert.equal(out.status, 200);
  assert.equal(out.headers.get("cache-control"), "private, no-store");
  assert.equal(out.headers.get("access-control-allow-origin"), null);
  assert.deepEqual(keys(out.body), ["client", "connection"]);
  assert.deepEqual(keys(out.body.client), ["canConnect", "checkedAt", "clientId", "clientSecretSaved", "grantClient", "hasOwnClient", "mode", "origin", "redirectUri", "requiredScopes"]);
  assert.deepEqual(out.body.client, {
    mode: "own",
    hasOwnClient: false,
    clientId: null,
    clientSecretSaved: false,
    checkedAt: null,
    redirectUri: "http://localhost:3000/api/google/callback",
    origin: "http://localhost:3000",
    requiredScopes: [CALENDAR, GMAIL, "openid", "email"],
    canConnect: false,
    grantClient: null,
  });
  assert.equal((out.body.connection as { state: string }).state, "not-connected");
  assertNoSecretKeys(out.body, ["clientSecretSaved"]);
});

test("a badly shaped pair is refused before Google is asked, and names the field", { skip }, async () => {
  const badId = await save(A, "not-a-client-id", secretOf("A"));
  assert.equal(badId.status, 400);
  assert.equal(badId.body.field, "clientId");
  assert.equal(badId.body.reason, "format-id");
  const badSecret = await save(A, idOf("a"), "short");
  assert.equal(badSecret.status, 400);
  assert.equal(badSecret.body.field, "clientSecret");
  assert.equal(googleCalls.length, 0, "no call to Google for a badly shaped value");
  assert.equal(await rowOf(A), null);
  // The body is validated too: an action that does not exist, a missing field, a NUL character.
  assert.equal((await postJson(A, { action: "explode" })).status, 400);
  assert.equal((await postJson(A, { action: "save-client", clientId: idOf("a") })).status, 400);
  assert.equal((await postJson(A, { action: "save-client", clientId: `${idOf("a")}\u0000`, clientSecret: secretOf("A") })).status, 400);
});

test("a pair Google does not accept is not saved, and the message says what to check", { skip }, async () => {
  const wrong = await save(A, idOf("a"), "GOCSPX-WRONGsecret0123456789abc");
  assert.equal(wrong.status, 400);
  assert.equal(wrong.body.reason, "invalid-client");
  assert.match(String(wrong.body.error), /same OAuth client/);
  assert.equal(tokenCalls().length, 1, "Google was asked once");
  assert.equal(tokenCalls()[0].form.get("code")?.startsWith("client-check"), true, "with a code that can never be real");
  assert.equal(await rowOf(A), null, "nothing saved");
});

test("Google being unreachable is a 503 that saves nothing", { skip }, async () => {
  const down = await save(A, idOf("a"), "GOCSPX-NETDOWNsecret0123456789ab");
  assert.equal(down.status, 503);
  assert.equal(down.body.reason, "unreachable");
  assert.equal(await rowOf(A), null);
});

test("a good pair is saved encrypted and bound to its influencer, and shows up as 'secret saved' with the ID in full", { skip }, async () => {
  const before = tokenCalls().length;
  const ok = await save(A, `  ${idOf("a")}  `, secretOf("A")); // pasted with spaces around: trimmed
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(tokenCalls().length, before + 1);
  assert.deepEqual(keys(ok.body), ["client", "ok", "replacedConnection"]);
  assert.equal(ok.body.replacedConnection, false);
  assertNoSecretKeys(ok.body, ["clientSecretSaved"]);
  assert.ok(!JSON.stringify(ok.body).includes(secretOf("A")));

  const row = await rowOf(A);
  assert.ok(row);
  assert.equal(row.clientId, idOf("a"), "the ID is plain text");
  assert.ok(!row.clientSecretEnc.includes(secretOf("A")) && row.clientSecretEnc.startsWith("v1."));
  assert.equal(decryptSecret(row.clientSecretEnc, credsLib.googleClientAad(A.influencerId)), secretOf("A"));
  assert.throws(() => decryptSecret(row.clientSecretEnc, credsLib.googleClientAad(B.influencerId)), "bound to its influencer");
  assert.ok(Math.abs(row.checkedAt.getTime() - Date.now()) < 60_000, "checkedAt is when Google accepted it");

  const view = await getView(A);
  const client = view.body.client as Record<string, unknown>;
  assert.equal(client.hasOwnClient, true);
  assert.equal(client.clientId, idOf("a"));
  assert.equal(client.clientSecretSaved, true);
  assert.equal(client.canConnect, true);
  assert.equal(typeof client.checkedAt, "string");
  assert.ok(!JSON.stringify(view.body).includes(secretOf("A")) && !JSON.stringify(view.body).includes(row.clientSecretEnc));
  assertNoSecretKeys(view.body, ["clientSecretSaved"]);

  // B cannot see A's client, and A's request cannot reach B's.
  const other = await getView(B);
  assert.equal((other.body.client as { clientId: unknown }).clientId, null);
  assert.ok(!JSON.stringify(other.body).includes(idOf("a")));
});

test("the activity log gets 'Google client saved' with a masked tail of the ID, never the secret or the whole ID", { skip }, async () => {
  const rows = await activities(A, "google.client_saved");
  assert.equal(rows.length, 1);
  const text = JSON.stringify(rows[0]);
  assert.ok(!text.includes(secretOf("A")) && !text.includes(idOf("a")) && !text.includes(run), text);
  assert.deepEqual(rows[0].detail, { client: `…${idOf("a").split("-")[1].replace(".apps.googleusercontent.com", "").slice(-4)}`, replaced: false });
  const { summariseActivity } = await import("../lib/activity-actions");
  assert.match(summariseActivity("google.client_saved", rows[0].detail), /^Google client saved \(…/);
});

test("connect: the consent screen is for the signed-in influencer's own client, and the state remembers which kind", { skip }, async () => {
  asUser(A);
  const res = await connectRoute.GET(connectReq());
  const to = locationOf(res);
  assert.equal(to.host, "accounts.google.com");
  assert.equal(to.searchParams.get("client_id"), idOf("a"));
  assert.equal(to.searchParams.get("redirect_uri"), "http://localhost:3000/api/google/callback");
  assert.ok(!to.toString().includes(secretOf("A")));
  const state = verifyToken<{ i: string; k: string }>("google-oauth-state", to.searchParams.get("state"));
  assert.equal(state?.i, A.influencerId);
  assert.equal(state?.k, "own");
});

test("connect: no usable client means a redirect back with a plain outcome, no OAuth round trip, and never another client", { skip }, async () => {
  asUser(B); // B has no client of their own; A's exists and the shared pair is not configured
  const res = await connectRoute.GET(connectReq("returnTo=%2Fonboarding%3Fstep%3D3"));
  const to = locationOf(res);
  assert.equal(to.pathname, "/onboarding");
  assert.equal(to.searchParams.get("step"), "3");
  assert.equal(to.searchParams.get("google"), "no-client");
  assert.equal(res.headers.get("set-cookie"), null, "no OAuth round trip was started");

  // The shared pair being configured changes nothing in the default mode.
  process.env.GOOGLE_CLIENT_ID = "9-shared.apps.googleusercontent.com";
  process.env.GOOGLE_CLIENT_SECRET = "shared-secret-0123456789abcdef";
  try {
    assert.equal(locationOf(await connectRoute.GET(connectReq())).searchParams.get("google"), "no-client");
    // In "either" mode B falls back to it, and the state says so; A (with a client) still uses their own.
    process.env.GOOGLE_CLIENT_MODE = "either";
    const viaShared = locationOf(await connectRoute.GET(connectReq()));
    assert.equal(viaShared.searchParams.get("client_id"), "9-shared.apps.googleusercontent.com");
    assert.equal(verifyToken<{ k: string }>("google-oauth-state", viaShared.searchParams.get("state"))?.k, "platform");
    asUser(A);
    assert.equal(locationOf(await connectRoute.GET(connectReq())).searchParams.get("client_id"), idOf("a"));
    // Platform mode with the pair missing is a configuration problem, said as such.
    process.env.GOOGLE_CLIENT_MODE = "platform";
    delete process.env.GOOGLE_CLIENT_ID;
    asUser(B);
    assert.equal(locationOf(await connectRoute.GET(connectReq())).searchParams.get("google"), "not-configured");
  } finally {
    delete process.env.GOOGLE_CLIENT_ID;
    delete process.env.GOOGLE_CLIENT_SECRET;
    delete process.env.GOOGLE_CLIENT_MODE;
  }
});

test("callback: the code is exchanged with the client of the influencer in the signed state, and the grant remembers it was an own client", { skip }, async () => {
  await credsLib.saveGoogleClient(B.influencerId, idOf("b"), secretOf("B"));
  const before = tokenCalls().length;

  asUser(A);
  const a = await callbackRoute.GET(callbackReq(A, "own"));
  assert.equal(locationOf(a).searchParams.get("google"), "connected");
  asUser(B);
  const b = await callbackRoute.GET(callbackReq(B, "own"));
  assert.equal(locationOf(b).searchParams.get("google"), "connected");

  const exchanges = tokenCalls().slice(before);
  assert.deepEqual(
    exchanges.map((c) => [c.form.get("client_id"), c.form.get("client_secret"), c.form.get("code"), c.form.get("redirect_uri")]),
    [
      [idOf("a"), secretOf("A"), "real-code", "http://localhost:3000/api/google/callback"],
      [idOf("b"), secretOf("B"), "real-code", "http://localhost:3000/api/google/callback"],
    ],
    "each influencer's code went to Google with their own pair and nobody else's",
  );
  const gA = await grantOf(A);
  const gB = await grantOf(B);
  assert.equal(gA?.clientKind, "own");
  assert.equal(gB?.clientKind, "own");
  assert.equal(decryptSecret(gA!.refreshTokenEnc, tokensLib.googleTokenAad(A.influencerId)), `rt-${idOf("a")}`);
  // The read side hands the kind to every later refresh.
  const lookup = await tokensLib.getRefreshToken(A.influencerId);
  assert.ok(lookup.state === "ok" && lookup.clientKind === "own");
  const active = await tokensLib.getActiveGrant(B.influencerId);
  assert.equal(active?.clientKind, "own");
});

test("callback: a state for one influencer in another's browser is refused before Google is asked; a missing client is a plain outcome", { skip }, async () => {
  const before = googleCalls.length;
  asUser(B);
  const crossed = await callbackRoute.GET(callbackReq(A, "own")); // A's state, B's session
  assert.equal(locationOf(crossed).searchParams.get("google"), "expired");
  asUser(C); // C has no client at all
  const none = await callbackRoute.GET(callbackReq(C, "own"));
  assert.equal(locationOf(none).searchParams.get("google"), "no-client");
  assert.equal(googleCalls.length, before, "Google was not called with anybody's credentials");
  assert.equal(await grantOf(C), null);

  // Google rejecting the saved client at the exchange is a specific outcome, not a generic failure.
  await credsLib.saveGoogleClient(C.influencerId, idOf("c"), "GOCSPX-WRONGsecret0123456789abc");
  asUser(C);
  const rejected = await callbackRoute.GET(callbackReq(C, "own", "some-other-code"));
  assert.equal(locationOf(rejected).searchParams.get("google"), "client-rejected", "invalid_client at the exchange names the client, not just 'failed'");
  assert.equal(await grantOf(C), null);
  await credsLib.saveGoogleClient(C.influencerId, idOf("c"), secretOf("C"));
  const badCode = await callbackRoute.GET(callbackReq(C, "own", "some-other-code"));
  assert.equal(locationOf(badCode).searchParams.get("google"), "failed", "a good client with a bad code is an ordinary failure");
  assert.equal(await grantOf(C), null);
  await credsLib.deleteGoogleClient(C.influencerId);
});

test("callback: a state signed before own clients existed (no kind) means the shared pair, and without it nothing is exchanged", { skip }, async () => {
  const before = googleCalls.length;
  asUser(C);
  const res = await callbackRoute.GET(callbackReq(C, undefined));
  assert.equal(locationOf(res).searchParams.get("google"), "not-configured");
  assert.equal(googleCalls.length, before);
});

test("replacing the own client: the SAME ID with a new secret keeps the connection; a DIFFERENT ID needs the confirmation when events exist and never writes to the connection itself", { skip }, async () => {
  // Same ID, new secret (rotated in Google Cloud): the grant is untouched.
  const rotated = await save(A, idOf("a"), "GOCSPX-Arotated0123456789abcdefgh");
  assert.equal(rotated.status, 200);
  assert.equal(rotated.body.replacedConnection, false);
  assert.equal((await grantOf(A))?.status, "ACTIVE");
  assert.equal(decryptSecret((await rowOf(A))!.clientSecretEnc, credsLib.googleClientAad(A.influencerId)), "GOCSPX-Arotated0123456789abcdefgh");
  assert.deepEqual(revokes(), []);

  // An upcoming booking with a calendar event: a different client ID is refused until the influencer confirms, and nothing is saved.
  const service = await prisma.service.create({ data: { influencerId: A.influencerId, title: `Gcr A ${run}`, durationMin: 30, priceMinor: 1000 } });
  const start = new Date(Date.now() + 3 * 86_400_000);
  const session = await prisma.session.create({ data: { serviceId: service.id, startTime: start, endTime: new Date(start.getTime() + 30 * 60_000) } });
  await prisma.booking.create({ data: { sessionId: session.id, status: "SCHEDULED", customerName: "Gcr Customer", customerEmail: `gcr-a-${run}@example.com`, whatsappE164: "+919876543210", eventId: `evta${run}` } });
  const before = tokenCalls().length;
  const refused = await save(A, idOf("a2"), secretOf("A2"));
  assert.equal(refused.status, 409);
  assert.equal(refused.body.needsConfirmation, true);
  assert.equal(refused.body.liveEvents, 1);
  assert.equal(tokenCalls().length, before, "Google was not even asked");
  assert.equal((await rowOf(A))?.clientId, idOf("a"));

  const replaced = await postJson(A, { action: "save-client", clientId: idOf("a2"), clientSecret: secretOf("A2"), confirm: true });
  assert.equal(replaced.status, 200);
  assert.equal(replaced.body.replacedConnection, true, "the response says the connection made with the old client stops working");
  assert.equal((await rowOf(A))?.clientId, idOf("a2"));
  // The save itself never wrote to the connection or revoked anything: the old token fails at its next refresh (Google ties it to the old client)
  // and the existing path flags it then.
  assert.equal((await grantOf(A))?.status, "ACTIVE");
  assert.deepEqual(revokes(), []);

  const saved = await activities(A, "google.client_saved");
  assert.deepEqual(saved.map((r) => (r.detail as { replaced: boolean }).replaced), [false, true, true]);
  for (const r of saved) assert.ok(!JSON.stringify(r).includes("secret") && !JSON.stringify(r).includes(secretOf("A2")));
});

test("the FIRST own client leaves a connection made with the shared client alone; the callback replaces it, revokes its token, and a failed callback changes nothing", { skip }, async () => {
  await tokensLib.saveGoogleToken(C.influencerId, "rt-shared-first", `openid email ${CALENDAR}`, "c-first@example.com", "sub-c-first", "platform");
  const before = googleCalls.length;
  const first = await save(C, idOf("c"), secretOf("C"));
  assert.equal(first.status, 200);
  assert.equal(first.body.replacedConnection, false);
  assert.equal((await grantOf(C))?.status, "ACTIVE", "saving never flags the shared-client connection");
  assert.equal((await grantOf(C))?.clientKind, "platform");
  assert.equal(googleCalls.slice(before).filter((c) => c.kind === "revoke").length, 0, "and never revokes its token");
  const view = await getView(C);
  assert.equal((view.body.connection as { state: string }).state, "connected");
  assert.equal((view.body.client as { grantClient: string }).grantClient, "platform");

  // A callback that fails (a bad code) leaves the old connection exactly as it was.
  asUser(C);
  const failed = await callbackRoute.GET(callbackReq(C, "own", "not-a-real-code"));
  assert.equal(locationOf(failed).searchParams.get("google"), "failed");
  assert.equal((await grantOf(C))?.status, "ACTIVE");
  assert.equal((await grantOf(C))?.clientKind, "platform");
  assert.ok(!revokes().includes("rt-shared-first"));

  // A successful one swaps the connection to the own client and only then revokes the shared one's token.
  const ok = await callbackRoute.GET(callbackReq(C, "own"));
  assert.equal(locationOf(ok).searchParams.get("google"), "connected");
  const after = await grantOf(C);
  assert.equal(after?.clientKind, "own");
  assert.equal(after?.status, "ACTIVE");
  assert.equal(decryptSecret(after!.refreshTokenEnc, tokensLib.googleTokenAad(C.influencerId)), `rt-${idOf("c")}`);
  assert.ok(revokes().includes("rt-shared-first"), "the previous (shared-client) token was revoked after the new connection was safe");
  assert.ok(!revokes().includes(`rt-${idOf("c")}`), "never the token just issued");
  await prisma.googleToken.deleteMany({ where: { influencerId: C.influencerId } });
  await credsLib.deleteGoogleClient(C.influencerId);
});

test("GOOGLE_CLIENT_MODE=platform: there is no own client to save", { skip }, async () => {
  process.env.GOOGLE_CLIENT_MODE = "platform";
  try {
    const before = googleCalls.length;
    const out = await save(D, idOf("d"), secretOf("D"));
    assert.equal(out.status, 409);
    assert.equal(googleCalls.length, before);
    assert.equal(await rowOf(D), null);
    assert.equal(((await getView(D)).body.client as { mode: string }).mode, "platform");
  } finally {
    delete process.env.GOOGLE_CLIENT_MODE;
  }
});

test("removing the client: 404 when there is none; the disconnect confirmation when events exist; then the connection made with it goes too", { skip }, async () => {
  assert.equal((await postJson(D, { action: "remove-client" })).status, 404);

  // B: an own client, an own grant, and an upcoming paid booking with a calendar event.
  const service = await prisma.service.create({ data: { influencerId: B.influencerId, title: `Gcr ${run}`, durationMin: 30, priceMinor: 1000 } });
  const start = new Date(Date.now() + 3 * 86_400_000);
  const session = await prisma.session.create({ data: { serviceId: service.id, startTime: start, endTime: new Date(start.getTime() + 30 * 60_000) } });
  await prisma.booking.create({ data: { sessionId: session.id, status: "SCHEDULED", customerName: "Gcr Customer", customerEmail: `gcr-cust-${run}@example.com`, whatsappE164: "+919876543210", eventId: `evt${run}` } });

  const refused = await postJson(B, { action: "remove-client" });
  assert.equal(refused.status, 409);
  assert.equal(refused.body.needsConfirmation, true);
  assert.equal(refused.body.liveEvents, 1);
  assert.ok(await rowOf(B), "nothing was removed");
  assert.ok(await grantOf(B));
  assert.deepEqual(revokes().filter((t) => t === `rt-${idOf("b")}`), []);

  const done = await postJson(B, { action: "remove-client", confirm: true });
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.equal(done.body.disconnected, true);
  assert.equal(await rowOf(B), null);
  assert.equal(await grantOf(B), null, "a connection cannot outlive the client it was made with");
  assert.deepEqual(revokes().filter((t) => t === `rt-${idOf("b")}`), [`rt-${idOf("b")}`]);
  assert.equal(((done.body.client as { hasOwnClient: boolean }).hasOwnClient), false);
  assert.equal((await activities(B, "google.client_removed")).length, 1);
  assert.equal((await activities(B, "google.disconnected")).length, 1);
  const removed = await activities(B, "google.client_removed");
  assert.ok(!JSON.stringify(removed).includes(idOf("b")) && !JSON.stringify(removed).includes(secretOf("B")));

  // A repeat is a clean 404, not an error.
  assert.equal((await postJson(B, { action: "remove-client", confirm: true })).status, 404);
});

test("removing a client leaves a connection made with the shared pair alone", { skip }, async () => {
  await credsLib.saveGoogleClient(C.influencerId, idOf("c"), secretOf("C"));
  await tokensLib.saveGoogleToken(C.influencerId, "rt-shared-C", `openid email ${CALENDAR}`, "c@example.com", "sub-c", "platform");
  const out = await postJson(C, { action: "remove-client" });
  assert.equal(out.status, 200);
  assert.equal(out.body.disconnected, false);
  assert.equal((await grantOf(C))?.status, "ACTIVE");
  assert.equal((await grantOf(C))?.clientKind, "platform");
  assert.ok(!revokes().includes("rt-shared-C"));
  await prisma.googleToken.deleteMany({ where: { influencerId: C.influencerId } });
});

test("saving is limited per influencer across any number of requests", { skip }, async () => {
  // Bad shapes are refused after the limiter, so they use up the allowance without calling Google.
  const statuses: number[] = [];
  for (let i = 0; i < 14; i++) statuses.push((await save(D, "nope", "nope")).status);
  assert.deepEqual(statuses.slice(0, 12), Array(12).fill(400));
  assert.deepEqual(statuses.slice(12), [429, 429]);
  // Another influencer is not affected.
  assert.equal((await save(C, "nope", "nope")).status, 400);
});

test("no secret, client ID or token reached the logs", { skip }, async () => {
  const text = logged.join("\n");
  for (const secret of [secretOf("A"), secretOf("B"), secretOf("A2"), "GOCSPX-Arotated0123456789abcdefgh", `rt-${idOf("a")}`, `rt-${idOf("b")}`]) {
    assert.ok(!text.includes(secret), `${secret.slice(0, 12)}... was logged`);
  }
});
