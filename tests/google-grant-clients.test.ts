import assert from "node:assert/strict";
import { test } from "node:test";
import { sendCustomerEmail, type CustomerEmailDeps, type InfluencerMailContext } from "../lib/customer-email";
import { EmailDisabledError, type OutgoingEmail } from "../lib/email/providers";
import {
  buildAuthUrl,
  createGoogleClient,
  exchangeCode,
  GoogleReconnectError,
  GoogleRequestError,
  GoogleTransientError,
  type GrantCredentialResolver,
} from "../lib/google";
import { CREDENTIAL_FAILURE_MESSAGES, type GoogleCredentials, type GoogleGrantRef } from "../lib/google-credentials";
import { checkGoogleConnections, type GoogleHealthDeps } from "../worker/google-health";

/**
 * doc/15: every refresh, exchange, health check and Gmail send uses the OAuth client the grant was issued with. Database-free: the
 * credential lookup, Google's endpoints and the mail transport are fakes that record what they were asked.
 */

const OWN_A: GoogleCredentials = { clientId: "1-a.apps.googleusercontent.com", clientSecret: "secret-of-a-0123456789abcdef", redirectUri: "https://x.example/api/google/callback" };
const OWN_B: GoogleCredentials = { clientId: "2-b.apps.googleusercontent.com", clientSecret: "secret-of-b-0123456789abcdef", redirectUri: "https://x.example/api/google/callback" };
const PLATFORM: GoogleCredentials = { clientId: "3-platform.apps.googleusercontent.com", clientSecret: "secret-of-platform-0123456789", redirectUri: "https://x.example/api/google/callback" };

/** Resolves by influencer and kind exactly like getGoogleCredentials: an own client is that influencer's, "platform" is the pair. */
const resolver: GrantCredentialResolver = async (grant) => {
  if (grant.clientKind === "platform") return { ok: true, kind: "platform", credentials: PLATFORM };
  const own = grant.influencerId === "inf-a" ? OWN_A : grant.influencerId === "inf-b" ? OWN_B : null;
  return own ? { ok: true, kind: "own", credentials: own } : { ok: false, reason: "no-own-client", message: CREDENTIAL_FAILURE_MESSAGES["no-own-client"] };
};

function tokenFetch(respond: (form: URLSearchParams) => Response) {
  const forms: URLSearchParams[] = [];
  const f = (async (_url: string | URL, init?: RequestInit) => {
    const form = new URLSearchParams(String(init?.body ?? ""));
    forms.push(form);
    return respond(form);
  }) as typeof fetch;
  return { f, forms };
}
const ok = () => new Response(JSON.stringify({ access_token: "at" }), { status: 200 });
const err = (status: number, error: string) => new Response(JSON.stringify({ error, error_description: error }), { status });

test("refresh uses the credentials of the grant's influencer and kind, and never another influencer's", async () => {
  const { f, forms } = tokenFetch(ok);
  const g = createGoogleClient(f, resolver);
  await g.refreshAccessToken("rt-a", { influencerId: "inf-a", clientKind: "own" });
  await g.refreshAccessToken("rt-b", { influencerId: "inf-b", clientKind: "own" });
  await g.refreshAccessToken("rt-p", { influencerId: "inf-a", clientKind: "platform" });
  assert.deepEqual(
    forms.map((x) => [x.get("client_id"), x.get("client_secret"), x.get("refresh_token"), x.get("grant_type")]),
    [
      [OWN_A.clientId, OWN_A.clientSecret, "rt-a", "refresh_token"],
      [OWN_B.clientId, OWN_B.clientSecret, "rt-b", "refresh_token"],
      [PLATFORM.clientId, PLATFORM.clientSecret, "rt-p", "refresh_token"],
    ],
  );
});

test("an own client that is missing means 'reconnect needed' with the plain reason, not a thrown 500 and not another client", async () => {
  const { f, forms } = tokenFetch(ok);
  await assert.rejects(createGoogleClient(f, resolver).refreshAccessToken("rt", { influencerId: "inf-gone", clientKind: "own" }), (e) => {
    assert.ok(e instanceof GoogleReconnectError);
    assert.match((e as Error).message, /^Your Google client was removed or is no longer valid/);
    return true;
  });
  assert.equal(forms.length, 0, "Google was never called, with anybody's credentials");
});

test("a missing shared pair is the operator's problem (transient), not the influencer's", async () => {
  const none: GrantCredentialResolver = async () => ({ ok: false, reason: "no-platform-client", message: CREDENTIAL_FAILURE_MESSAGES["no-platform-client"] });
  await assert.rejects(createGoogleClient(tokenFetch(ok).f, none).refreshAccessToken("rt", { influencerId: "inf-a", clientKind: "platform" }), GoogleTransientError);
});

test("invalid_client from Google: reconnect needed for an own client (they deleted it or changed its secret), transient for the shared pair", async () => {
  const f = tokenFetch(() => err(401, "invalid_client")).f;
  await assert.rejects(createGoogleClient(f, resolver).refreshAccessToken("rt", { influencerId: "inf-a", clientKind: "own" }), (e) => {
    assert.ok(e instanceof GoogleReconnectError);
    assert.match((e as Error).message, /Google client was removed or is no longer valid/);
    return true;
  });
  await assert.rejects(createGoogleClient(f, resolver).refreshAccessToken("rt", { influencerId: "inf-a", clientKind: "platform" }), GoogleTransientError);
  // invalid_grant is the grant being dead whichever client it was.
  const dead = tokenFetch(() => err(400, "invalid_grant")).f;
  await assert.rejects(createGoogleClient(dead, resolver).refreshAccessToken("rt", { influencerId: "inf-a", clientKind: "own" }), GoogleReconnectError);
  // Google being down is transient for both.
  const down = tokenFetch(() => err(503, "backendError")).f;
  await assert.rejects(createGoogleClient(down, resolver).refreshAccessToken("rt", { influencerId: "inf-a", clientKind: "own" }), GoogleTransientError);
});

test("without a grant (the legacy call shape) the shared pair from the environment is used, and a missing one throws as it always did", async () => {
  const saved = { id: process.env.GOOGLE_CLIENT_ID, secret: process.env.GOOGLE_CLIENT_SECRET };
  try {
    process.env.GOOGLE_CLIENT_ID = PLATFORM.clientId;
    process.env.GOOGLE_CLIENT_SECRET = PLATFORM.clientSecret;
    const { f, forms } = tokenFetch(ok);
    await createGoogleClient(f, resolver).refreshAccessToken("rt");
    assert.equal(forms[0].get("client_id"), PLATFORM.clientId);
    delete process.env.GOOGLE_CLIENT_SECRET;
    await assert.rejects(createGoogleClient(f, resolver).refreshAccessToken("rt"), /GOOGLE_CLIENT_SECRET is not set/);
  } finally {
    if (saved.id === undefined) delete process.env.GOOGLE_CLIENT_ID;
    else process.env.GOOGLE_CLIENT_ID = saved.id;
    if (saved.secret === undefined) delete process.env.GOOGLE_CLIENT_SECRET;
    else process.env.GOOGLE_CLIENT_SECRET = saved.secret;
  }
});

test("the consent URL and the code exchange use the credentials they are given", async () => {
  const url = new URL(buildAuthUrl("state-1", "me@x.co", { gmail: true, credentials: OWN_A }));
  assert.equal(url.searchParams.get("client_id"), OWN_A.clientId);
  assert.equal(url.searchParams.get("redirect_uri"), OWN_A.redirectUri);
  assert.ok(!url.toString().includes(OWN_A.clientSecret), "the secret is never in a URL");

  const { f, forms } = tokenFetch(() => new Response(JSON.stringify({ refresh_token: "rt", scope: "s" }), { status: 200 }));
  await exchangeCode("code-1", f, OWN_B);
  assert.equal(forms[0].get("client_id"), OWN_B.clientId);
  assert.equal(forms[0].get("client_secret"), OWN_B.clientSecret);
  assert.equal(forms[0].get("redirect_uri"), OWN_B.redirectUri);
  assert.equal(forms[0].get("code"), "code-1");

  const rejected = tokenFetch(() => err(401, "invalid_client")).f;
  await assert.rejects(exchangeCode("c", rejected, OWN_A), (e) => e instanceof GoogleRequestError && /invalid_client/.test((e as Error).message));
});

/* ---------- the daily health check ---------- */

test("the health check refreshes every connection with the client that issued it and flags a dead own client as dead", async () => {
  const seen: { token: string; grant: GoogleGrantRef }[] = [];
  const grants: Record<string, { refreshToken: string; connectedAt: Date; clientKind: "own" | "platform" }> = {
    "inf-a": { refreshToken: "t-a", connectedAt: new Date(1), clientKind: "own" },
    "inf-p": { refreshToken: "t-p", connectedAt: new Date(2), clientKind: "platform" },
    "inf-gone": { refreshToken: "t-gone", connectedAt: new Date(3), clientKind: "own" },
  };
  const client = createGoogleClient(tokenFetch(ok).f, resolver);
  const marked: string[] = [];
  const deps: GoogleHealthDeps = {
    listActive: async () => Object.keys(grants),
    load: async (id) => grants[id] ?? null,
    refresh: async (token, grant) => {
      seen.push({ token, grant });
      await client.refreshAccessToken(token, grant);
    },
    markDead: async (id, reason) => (marked.push(`${id}: ${reason}`), true),
    alert: async () => {},
    concurrency: 1,
  };
  const summary = await checkGoogleConnections(deps);
  assert.deepEqual(
    seen.map((s) => [s.token, s.grant.influencerId, s.grant.clientKind]),
    [["t-a", "inf-a", "own"], ["t-p", "inf-p", "platform"], ["t-gone", "inf-gone", "own"]],
  );
  assert.equal(summary.ok, 2);
  assert.equal(summary.dead, 1, "an influencer whose client is gone is told to reconnect, not left unchecked");
  assert.equal(marked.length, 1);
  assert.match(marked[0], /^inf-gone: Your Google client was removed or is no longer valid/);
});

/* ---------- Gmail send ---------- */

const email: OutgoingEmail = { to: { email: "asha@example.com", name: "Asha" }, subject: "S", html: "<p>h</p>", text: "t", tag: "booking-confirmation" };
const withGmail = (clientKind: "own" | "platform" | undefined): InfluencerMailContext => ({
  name: "Sam",
  replyTo: "sam@gmail.com",
  gmail: { refreshToken: "r", fromEmail: "sam@gmail.com", ...(clientKind ? { clientKind } : {}) },
});

function mailDeps(ctx: InfluencerMailContext | null, over: Partial<CustomerEmailDeps> = {}) {
  const calls = { grants: [] as GoogleGrantRef[], gmail: 0, platform: 0 };
  const d: CustomerEmailDeps = {
    loadContext: async () => ctx,
    refreshAccessToken: async (_t, grant) => (calls.grants.push(grant), "access"),
    sendGmail: async () => (calls.gmail++, { id: "g1" }),
    platformSend: async () => (calls.platform++, { providerMessageId: "p1" }),
    onReconnectNeeded: async () => {},
    ...over,
  };
  return { d, calls };
}

test("Gmail is refreshed with the influencer's own client when that is what their grant was issued with", async () => {
  const own = mailDeps(withGmail("own"));
  assert.equal((await sendCustomerEmail("inf-a", email, own.d)).via, "gmail");
  assert.deepEqual(own.calls.grants, [{ influencerId: "inf-a", clientKind: "own" }]);
  const platform = mailDeps(withGmail("platform"));
  await sendCustomerEmail("inf-b", email, platform.d);
  assert.deepEqual(platform.calls.grants, [{ influencerId: "inf-b", clientKind: "platform" }]);
});

test("with no platform e-mail and no Gmail, nothing is sent and the caller is told (via none)", async () => {
  const { d, calls } = mailDeps(null, {
    platformSend: async () => {
      throw new EmailDisabledError();
    },
  });
  const r = await sendCustomerEmail("inf-a", email, d);
  assert.deepEqual(r, { providerMessageId: null, via: "none" });
  assert.equal(calls.gmail, 0);
  const noGmail = mailDeps({ name: "Sam", replyTo: "sam@x.co", gmail: null }, { platformSend: async () => Promise.reject(new EmailDisabledError()) });
  assert.equal((await sendCustomerEmail("inf-a", email, noGmail.d)).via, "none");
});

test("with no platform e-mail, a failing Gmail send is reported with its reason instead of falling back", async () => {
  const { d } = mailDeps(withGmail("own"), {
    sendGmail: async () => {
      throw new GoogleTransientError("Gmail 429 quota");
    },
    platformSend: async () => Promise.reject(new EmailDisabledError()),
  });
  const r = await sendCustomerEmail("inf-a", email, d);
  assert.equal(r.via, "none");
  assert.match(r.fallbackReason ?? "", /429/);
});

test("any other platform failure still reaches the caller", async () => {
  const boom = mailDeps(null, { platformSend: async () => Promise.reject(new Error("provider down")) });
  await assert.rejects(sendCustomerEmail("inf-a", email, boom.d), /provider down/);
});
