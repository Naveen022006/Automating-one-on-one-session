import assert from "node:assert/strict";
import { test } from "node:test";
import { exchangeCode, buildAuthUrl, createGoogleClient, revokeToken } from "../lib/google";
import { sendGmail } from "../lib/gmail";
import {
  REAL_ENDPOINTS,
  googleEndpoints,
  graphBase,
  graphOrigin,
  isLocalAppUrl,
  isLoopbackMockUrl,
  mockFacebookSdkUrl,
  mockProvidersOverride,
} from "../lib/provider-endpoints";
import { sendWhatsApp } from "../lib/whatsapp";
import { embeddedSignupConfig, getPhoneNumber } from "../lib/whatsapp-connect";

// The local-mock override (doc/11-provider-simulator.md) must be inert everywhere except a development machine: the resolver is
// pure and takes an env record, and the call-site tests write process.env (restored after each test) and spy on fetch.

type Env = Record<string, string | undefined>;
const MOCK = "http://127.0.0.1:4010";
const ACTIVE: Env = { MOCK_PROVIDERS_URL: MOCK, APP_URL: "http://localhost:3000" };
const REAL_GOOGLE = {
  auth: "https://accounts.google.com/o/oauth2/v2/auth",
  token: "https://oauth2.googleapis.com/token",
  revoke: "https://oauth2.googleapis.com/revoke",
  calendar: "https://www.googleapis.com/calendar/v3",
  gmailSend: "https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
};
const MOCK_GOOGLE = {
  auth: `${MOCK}/google/o/oauth2/v2/auth`,
  token: `${MOCK}/google/token`,
  revoke: `${MOCK}/google/revoke`,
  calendar: `${MOCK}/google/calendar/v3`,
  gmailSend: `${MOCK}/google/gmail/v1/users/me/messages/send`,
};

/** Asserts that EVERY function of the module answers with the real services for `env`. */
function assertReal(env: Env, label: string) {
  assert.deepEqual(googleEndpoints(env), REAL_GOOGLE, label);
  assert.equal(graphOrigin(env), "https://graph.facebook.com", label);
  assert.equal(graphBase(env), "https://graph.facebook.com/v26.0", label);
  assert.equal(mockFacebookSdkUrl(env), undefined, label);
  assert.equal(mockProvidersOverride(env).active, false, label);
}

test("with MOCK_PROVIDERS_URL unset (or blank) every URL is the real service", () => {
  assertReal({}, "empty env");
  assertReal({ MOCK_PROVIDERS_URL: "", APP_URL: "http://localhost:3000" }, "blank");
  assert.deepEqual(googleEndpoints({}), REAL_GOOGLE);
  assert.deepEqual(REAL_ENDPOINTS, {
    googleAuth: REAL_GOOGLE.auth,
    googleToken: REAL_GOOGLE.token,
    googleRevoke: REAL_GOOGLE.revoke,
    googleCalendar: REAL_GOOGLE.calendar,
    gmailSend: REAL_GOOGLE.gmailSend,
    graphOrigin: "https://graph.facebook.com",
  });
  assert.equal(graphBase({}), "https://graph.facebook.com/v26.0");
  assert.equal(graphBase({ WHATSAPP_GRAPH_VERSION: "v27.0" }), "https://graph.facebook.com/v27.0");
  assert.deepEqual(mockProvidersOverride({}), { active: false, problem: null }, "unset is not a problem");
});

test("active on a development machine: NODE_ENV unset, development or test, a local APP_URL and a loopback mock", () => {
  for (const nodeEnv of [undefined, "", "development", "test"]) {
    const env = { ...ACTIVE, NODE_ENV: nodeEnv };
    assert.deepEqual(googleEndpoints(env), MOCK_GOOGLE, `NODE_ENV=${nodeEnv}`);
    assert.equal(graphOrigin(env), `${MOCK}/meta`);
    assert.equal(graphBase(env), `${MOCK}/meta/v26.0`);
    assert.equal(graphBase({ ...env, WHATSAPP_GRAPH_VERSION: "v27.0" }), `${MOCK}/meta/v27.0`);
    assert.equal(mockFacebookSdkUrl(env), `${MOCK}/meta/en_US/sdk.js`);
    assert.deepEqual(mockProvidersOverride(env), { active: true, origin: MOCK });
  }
  for (const appUrl of ["http://127.0.0.1:3000", "http://[::1]:3000", "http://app.localhost:3000", "https://localhost:3000", "http://localhost:3000/"]) {
    assert.equal(mockProvidersOverride({ ...ACTIVE, APP_URL: appUrl }).active, true, appUrl);
  }
  for (const mock of ["http://localhost:4010", "http://[::1]:4010", "http://127.0.0.1:4010/"]) {
    const o = mockProvidersOverride({ ...ACTIVE, MOCK_PROVIDERS_URL: mock });
    assert.equal(o.active, true, mock);
    assert.equal(o.active && o.origin, new URL(mock).origin);
  }
});

test("inert in production and on any other NODE_ENV or serverless platform, for every function", () => {
  for (const nodeEnv of ["production", "staging", "prod", "Production", "PRODUCTION", " production", "preview"]) {
    assertReal({ ...ACTIVE, NODE_ENV: nodeEnv }, `NODE_ENV=${JSON.stringify(nodeEnv)}`);
  }
  assert.match((mockProvidersOverride({ ...ACTIVE, NODE_ENV: "production" }) as { problem: string }).problem, /NODE_ENV/);
  assertReal({ ...ACTIVE, VERCEL: "1" }, "VERCEL");
  assertReal({ ...ACTIVE, NETLIFY: "true" }, "NETLIFY");
  assertReal({ ...ACTIVE, AWS_LAMBDA_FUNCTION_NAME: "fn" }, "AWS_LAMBDA_FUNCTION_NAME");
  assertReal({ ...ACTIVE, LAMBDA_TASK_ROOT: "/var/task" }, "LAMBDA_TASK_ROOT");
  assertReal({ ...ACTIVE, NODE_ENV: "development", VERCEL: "1" }, "development on Vercel");
});

test("inert unless APP_URL is set to a local address (unset does not count as local)", () => {
  const bad: (string | undefined)[] = [
    undefined,
    "",
    "not a url",
    " http://localhost:3000",
    "http://localhost:3000 ",
    "ftp://localhost",
    "https://app.example.com",
    "http://192.168.1.5:3000",
    "http://0.0.0.0:3000",
    "http://localhost.example.com",
    "http://127.0.0.1.nip.io:3000",
    "http://evil.localhost.com",
    "http://localhost@evil.com",
    "http://localhost:pw@evil.com",
    "http://[::2]:3000",
    "http://localhost.:3000",
    "http://.localhost:3000",
  ];
  for (const appUrl of bad) {
    assertReal({ ...ACTIVE, APP_URL: appUrl }, `APP_URL=${JSON.stringify(appUrl)}`);
    assert.equal(isLocalAppUrl(appUrl), false, String(appUrl));
  }
  assert.match((mockProvidersOverride({ ...ACTIVE, APP_URL: undefined }) as { problem: string }).problem, /APP_URL/);
  for (const ok of ["http://localhost:3000", "http://127.0.0.1", "https://localhost", "http://[::1]:3000", "http://a.b.localhost:3000/x"]) {
    assert.equal(isLocalAppUrl(ok), true, ok);
  }
});

test("inert unless MOCK_PROVIDERS_URL is a plain loopback origin", () => {
  const bad = [
    "http://192.168.1.10:4010",
    "https://mock.example.com",
    "http://127.0.0.1.evil.com:4010",
    "http://user:pw@127.0.0.1:4010",
    "http://127.0.0.1@evil.com:4010",
    "http://127.0.0.1:4010/x",
    "http://127.0.0.1:4010/?a=1",
    "http://127.0.0.1:4010?a=1",
    "http://127.0.0.1:4010#f",
    "http://127.0.0.1:4010/#",
    "http://127.0.0.1:4010/?",
    "file:///etc/passwd",
    " http://127.0.0.1:4010",
    "http://127.0.0.1:4010 ",
    "http://app.localhost:4010",
    "http://0.0.0.0:4010",
    "http://127.0.0.2:4010",
    "mock",
    "http://127.0.0.1:4010\\@evil.com",
  ];
  for (const mock of bad) {
    assertReal({ ...ACTIVE, MOCK_PROVIDERS_URL: mock }, `MOCK_PROVIDERS_URL=${JSON.stringify(mock)}`);
    assert.equal(isLoopbackMockUrl(mock), false, mock);
  }
  assert.match((mockProvidersOverride({ ...ACTIVE, MOCK_PROVIDERS_URL: "http://192.168.1.10:4010" }) as { problem: string }).problem, /127\.0\.0\.1/);
  assert.equal(isLoopbackMockUrl(undefined), false);
});

test("embeddedSignupConfig carries the mock SDK URL only while the override is active", () => {
  const base = { META_APP_ID: "app", META_ES_CONFIG_ID: "cfg", META_APP_SECRET: "secret" };
  const e = (o: Env) => o as unknown as NodeJS.ProcessEnv;
  assert.deepEqual(embeddedSignupConfig(e(base)), { appId: "app", configId: "cfg", graphVersion: "v26.0" }, "today's three keys, no sdkUrl");
  assert.equal("sdkUrl" in embeddedSignupConfig(e({ ...base, ...ACTIVE, MOCK_PROVIDERS_URL: "" }))!, false);
  assert.deepEqual(embeddedSignupConfig(e({ ...base, ...ACTIVE })), { appId: "app", configId: "cfg", graphVersion: "v26.0", sdkUrl: `${MOCK}/meta/en_US/sdk.js` });
  assert.equal(embeddedSignupConfig(e({ ...base, ...ACTIVE, NODE_ENV: "production" }))?.sdkUrl, undefined, "production with the mock URL set: no sdkUrl");
  assert.equal("sdkUrl" in embeddedSignupConfig(e({ ...base, ...ACTIVE, NODE_ENV: "production" }))!, false);
  assert.equal("sdkUrl" in embeddedSignupConfig(e({ ...base, ...ACTIVE, APP_URL: "https://app.example.com" }))!, false, "non-local APP_URL");
  assert.equal(embeddedSignupConfig(e({ ...ACTIVE })), null, "no Meta app: still no config");
});

/* ---------- the call sites, with fetch spied on and the environment written into process.env ---------- */

const TOUCHED = [
  "NODE_ENV", "APP_URL", "MOCK_PROVIDERS_URL", "VERCEL", "NETLIFY", "AWS_LAMBDA_FUNCTION_NAME", "LAMBDA_TASK_ROOT",
  "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_REDIRECT_URI", "GOOGLE_REQUEST_GMAIL_SEND",
  "WHATSAPP_GRAPH_VERSION", "MESSAGING_DRY_RUN", "WHATSAPP_DISABLED",
] as const;

/** Runs `fn` with process.env set to exactly `vars` for the keys the module reads; restores everything afterwards. */
async function withEnv(vars: Env, fn: () => Promise<void>) {
  const proc = process.env as Record<string, string | undefined>;
  const saved = TOUCHED.map((k) => [k, proc[k]] as const);
  for (const k of TOUCHED) delete proc[k];
  Object.assign(proc, {
    GOOGLE_CLIENT_ID: "cid",
    GOOGLE_CLIENT_SECRET: "csecret",
    GOOGLE_REDIRECT_URI: "http://localhost:3000/api/google/callback",
  });
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete proc[k];
    else proc[k] = v;
  }
  try {
    await fn();
  } finally {
    for (const k of TOUCHED) delete proc[k];
    for (const [k, v] of saved) if (v !== undefined) proc[k] = v;
  }
}

/** Every provider URL the clients call, collected through a spy fetch that answers like the services do. */
async function collectUrls(): Promise<{ authUrl: string; urls: Record<string, string> }> {
  const urls: Record<string, string> = {};
  const answer = (name: string, body: unknown) =>
    (async (u: string | URL | Request) => {
      urls[name] = String(u);
      return new Response(JSON.stringify(body), { status: 200 });
    }) as unknown as typeof fetch;
  const when = { start: new Date("2030-01-01T10:00:00Z"), end: new Date("2030-01-01T10:30:00Z") };

  const authUrl = buildAuthUrl("state");
  await createGoogleClient(answer("refresh", { access_token: "at" })).refreshAccessToken("rt");
  await createGoogleClient(answer("insert", { id: "abcde" })).insertEvent("at", {
    id: "abcde", summary: "s", description: "d", ...when, attendee: { email: "a@b.co", displayName: "A" }, conferenceRequestId: "r",
  });
  await createGoogleClient(answer("get", { id: "abcde" })).getEvent("at", "abcde");
  await createGoogleClient(answer("update", { id: "abcde" })).updateEvent("at", "abcde", when);
  await createGoogleClient(answer("delete", {})).deleteEvent("at", "abcde");
  await exchangeCode("code", answer("exchange", { refresh_token: "rt", scope: "s" }));
  await revokeToken("rt", answer("revoke", {}));
  await sendGmail("at", { fromName: "F", fromEmail: "f@b.co", to: { email: "t@b.co" }, subject: "s", html: "<p>h</p>", text: "t" }, answer("gmail", { id: "m1" }));
  await getPhoneNumber("111", "tok", answer("phone", { id: "111" }));
  await sendWhatsApp({ to: "+919876543210", template: "reschedule", credentials: { token: "t", phoneNumberId: "333" } }, answer("send", { messages: [{ id: "wamid.1" }] }));
  return { authUrl, urls };
}

test("call sites: the clients send to the mock only while the override is active, otherwise to the real hosts", async () => {
  const cases: { label: string; env: Env; mock: boolean }[] = [
    { label: "active", env: ACTIVE, mock: true },
    { label: "production", env: { ...ACTIVE, NODE_ENV: "production" }, mock: false },
    { label: "non-local APP_URL", env: { ...ACTIVE, APP_URL: "https://app.example.com" }, mock: false },
    { label: "unset", env: { APP_URL: "http://localhost:3000" }, mock: false },
    { label: "serverless", env: { ...ACTIVE, VERCEL: "1" }, mock: false },
  ];
  for (const c of cases) {
    await withEnv(c.env, async () => {
      const { authUrl, urls } = await collectUrls();
      const auth = new URL(authUrl);
      if (c.mock) {
        assert.equal(auth.origin, MOCK, c.label);
        assert.equal(auth.pathname, "/google/o/oauth2/v2/auth");
        assert.ok(urls.refresh.startsWith(`${MOCK}/google/token`), urls.refresh);
        assert.ok(urls.exchange.startsWith(`${MOCK}/google/token`), urls.exchange);
        assert.ok(urls.revoke.startsWith(`${MOCK}/google/revoke?token=`), urls.revoke);
        for (const k of ["insert", "get", "update", "delete"]) assert.ok(urls[k].startsWith(`${MOCK}/google/calendar/v3/calendars/primary/events`), `${k}: ${urls[k]}`);
        assert.equal(urls.gmail, `${MOCK}/google/gmail/v1/users/me/messages/send`);
        for (const k of ["phone", "send"]) assert.ok(urls[k].startsWith(`${MOCK}/meta/v26.0/`), `${k}: ${urls[k]}`);
      } else {
        assert.equal(auth.origin, "https://accounts.google.com", c.label);
        assert.equal(auth.pathname, "/o/oauth2/v2/auth");
        assert.ok(urls.refresh.startsWith("https://oauth2.googleapis.com/token"), `${c.label}: ${urls.refresh}`);
        assert.ok(urls.exchange.startsWith("https://oauth2.googleapis.com/token"));
        assert.ok(urls.revoke.startsWith("https://oauth2.googleapis.com/revoke?token="));
        for (const k of ["insert", "get", "update", "delete"]) assert.ok(urls[k].startsWith("https://www.googleapis.com/calendar/v3/calendars/primary/events"), `${c.label} ${k}: ${urls[k]}`);
        assert.equal(urls.gmail, "https://gmail.googleapis.com/gmail/v1/users/me/messages/send");
        for (const k of ["phone", "send"]) assert.ok(urls[k].startsWith("https://graph.facebook.com/v26.0/"), `${c.label} ${k}: ${urls[k]}`);
      }
      // Nothing of the mock leaks into a real URL, and nothing real into a mock one.
      const all = [authUrl, ...Object.values(urls)];
      assert.equal(all.some((u) => u.includes("127.0.0.1:4010")), c.mock && all.every((u) => u.includes("127.0.0.1:4010")), c.label);
    });
  }
});

test("call sites: the calendar URL is resolved per call, so a client created before the override still follows it", async () => {
  const seen: string[] = [];
  const client = createGoogleClient((async (u: string | URL | Request) => {
    seen.push(String(u));
    return new Response(JSON.stringify({ id: "abcde" }), { status: 200 });
  }) as unknown as typeof fetch);
  await withEnv({ APP_URL: "http://localhost:3000" }, async () => {
    await client.getEvent("at", "abcde");
  });
  await withEnv(ACTIVE, async () => {
    await client.getEvent("at", "abcde");
  });
  assert.ok(seen[0].startsWith("https://www.googleapis.com/"));
  assert.ok(seen[1].startsWith(`${MOCK}/google/calendar/v3/`));
});
