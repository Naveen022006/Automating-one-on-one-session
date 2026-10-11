import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { networkInterfaces, tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { GOOGLE_CLIENT_SECRET, META_APP_ID, META_APP_SECRET, META_ES_CONFIG_ID } from "../scripts/mock-providers/fixtures";
import { createMockServer } from "../scripts/mock-providers/server";
import { defaultStateFile } from "../scripts/mock-providers/state";
import { control, raw, startMock, type TestMock } from "./helpers/mock-server";

// The mock is a development tool that stands in for Google and Meta: it must never be reachable from the network, never start where
// it could mislead real users, and never hold or echo anything real (doc/11-provider-simulator.md, 3.9).

let t: TestMock;
before(async () => {
  t = await startMock();
});
after(async () => {
  await t.stop();
});

async function withEnv(vars: Record<string, string | undefined>, fn: () => Promise<void>) {
  const proc = process.env as Record<string, string | undefined>;
  const saved = Object.keys(vars).map((k) => [k, proc[k]] as const);
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete proc[k];
    else proc[k] = v;
  }
  try {
    await fn();
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete proc[k];
      else proc[k] = v;
    }
  }
}

test("it refuses to start in production, for an app that is not local, on a serverless platform, or with a state file outside the temp directory", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "mock-providers-test-"));
  const stateFile = path.join(dir, "state.json");
  try {
    await withEnv({ NODE_ENV: "production" }, async () => {
      await assert.rejects(createMockServer({ port: 0, appUrl: "http://localhost:3000", stateFile }), /NODE_ENV is production/);
    });
    for (const marker of ["VERCEL", "NETLIFY", "AWS_LAMBDA_FUNCTION_NAME", "LAMBDA_TASK_ROOT"]) {
      await withEnv({ [marker]: "1" }, async () => {
        await assert.rejects(createMockServer({ port: 0, appUrl: "http://localhost:3000", stateFile }), /serverless/, marker);
      });
    }
    for (const appUrl of ["https://app.example.com", "http://192.168.1.5:3000", "http://localhost.evil.com", "http://localhost@evil.com", ""]) {
      await assert.rejects(createMockServer({ port: 0, appUrl, stateFile }), /local address/, appUrl);
    }
    await assert.rejects(createMockServer({ port: 0, appUrl: "http://localhost:3000", stateFile: path.join(process.cwd(), "mock-state.json") }), /temp directory/);
    assert.equal(existsSync(path.join(process.cwd(), "mock-state.json")), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("it listens on 127.0.0.1 only and is not reachable on the machine's other addresses", async () => {
  assert.equal(t.mock.address().address, "127.0.0.1");
  assert.match(t.mock.url, /^http:\/\/127\.0\.0\.1:\d+$/);
  const external = Object.values(networkInterfaces())
    .flat()
    .find((i) => i && i.family === "IPv4" && !i.internal);
  if (external) {
    await assert.rejects(fetch(`http://${external.address}:${t.mock.address().port}/__mock`, { signal: AbortSignal.timeout(3000) }), "the mock must not answer on a non-loopback address");
  }
});

test("a Host header that is not the mock's own is refused (DNS-rebinding defence)", async () => {
  const port = t.mock.address().port;
  for (const host of ["evil.example", `evil.example:${port}`, "127.0.0.1", `127.0.0.1:${port + 1}`, `localhost.evil.com:${port}`]) {
    const res = await raw(t.mock, "GET", "/__mock", { host });
    assert.equal(res.status, 421, `Host: ${JSON.stringify(host)}`);
  }
  for (const host of [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]) {
    assert.equal((await raw(t.mock, "GET", "/__mock", { host })).status, 200, host);
  }
  // A request target that tries to move the host.
  assert.equal((await raw(t.mock, "GET", "http://evil.example/__mock")).status, 400);
});

test("control POSTs need the control token AND a same-origin request", async () => {
  const body = JSON.stringify({ key: "google.meet", value: "pending_2s" });
  const json = { "content-type": "application/json" };
  const origin = t.mock.url;
  assert.equal((await raw(t.mock, "POST", "/__mock/faults", json, body)).status, 403, "no token");
  assert.equal((await raw(t.mock, "POST", "/__mock/faults", { ...json, "x-mock-control": "wrong" }, body)).status, 403, "wrong token");
  const good = { ...json, "x-mock-control": t.mock.controlToken };
  assert.equal((await raw(t.mock, "POST", "/__mock/faults", { ...good, "sec-fetch-site": "cross-site" }, body)).status, 403, "cross-site");
  assert.equal((await raw(t.mock, "POST", "/__mock/faults", { ...good, "sec-fetch-site": "same-site" }, body)).status, 403, "same-site is not same-origin");
  assert.equal((await raw(t.mock, "POST", "/__mock/faults", { ...good, origin: "http://evil.example" }, body)).status, 403, "foreign Origin");
  assert.equal((await raw(t.mock, "POST", "/__mock/faults", { ...good, origin: "null" }, body)).status, 403, "opaque Origin");
  assert.equal(t.mock.state().faults["google.meet"], undefined, "none of the refused requests changed anything");

  assert.equal((await raw(t.mock, "POST", "/__mock/faults", { ...good, "sec-fetch-site": "same-origin", origin }, body)).status, 200);
  assert.equal(t.mock.state().faults["google.meet"]?.value, "pending_2s");
  await control(t.mock, "/__mock/faults", { key: "google.meet", value: "instant" });
  assert.equal(t.mock.state().faults["google.meet"], undefined, "back to the default clears it");

  // The pages' own forms: the token travels as a hidden field.
  const form = new URLSearchParams({ _mock: t.mock.controlToken, _back: "/__mock/faults", key: "latency.google", value: "300" }).toString();
  const res = await raw(t.mock, "POST", "/__mock/faults", { "content-type": "application/x-www-form-urlencoded", origin }, form);
  assert.equal(res.status, 303);
  assert.equal(res.headers.location, "/__mock/faults");
  assert.equal(t.mock.state().faults["latency.google"]?.value, "300");
  const noToken = new URLSearchParams({ key: "latency.google", value: "0" }).toString();
  assert.equal((await raw(t.mock, "POST", "/__mock/faults", { "content-type": "application/x-www-form-urlencoded", origin }, noToken)).status, 403);
  // A redirect target outside /__mock is ignored.
  const evil = new URLSearchParams({ _mock: t.mock.controlToken, _back: "https://evil.example/", key: "latency.google", value: "0" }).toString();
  assert.equal((await raw(t.mock, "POST", "/__mock/faults", { "content-type": "application/x-www-form-urlencoded" }, evil)).headers.location, "/__mock");
  // Unknown faults and values are refused.
  await assert.rejects(control(t.mock, "/__mock/faults", { key: "nope", value: "x" }), /400/);
  await assert.rejects(control(t.mock, "/__mock/faults", { key: "meta.send", value: "999" }), /400/);
});

test("the state file is in the OS temp directory, never in the repository", () => {
  const tmp = path.resolve(tmpdir());
  assert.ok(path.resolve(defaultStateFile()).startsWith(tmp), defaultStateFile());
  assert.ok(!path.resolve(defaultStateFile()).startsWith(path.resolve(process.cwd())));
  assert.ok(path.resolve(t.dir).startsWith(tmp));
});

test("no page or response contains the mock's client or app secrets, and state.json shortens every token", async () => {
  for (const route of ["/__mock", "/__mock/requests", "/__mock/faults", "/__mock/state.json"]) {
    const res = await raw(t.mock, "GET", route);
    assert.equal(res.status, 200, route);
    assert.ok(!res.text.includes(GOOGLE_CLIENT_SECRET), `${route} leaks GOOGLE_CLIENT_SECRET`);
    assert.ok(!res.text.includes(META_APP_SECRET), `${route} leaks META_APP_SECRET`);
  }
  assert.equal((await raw(t.mock, "GET", "/__mock/state.json?full=1")).status, 403, "full=1 needs the control token");
  assert.equal((await raw(t.mock, "GET", "/__mock/state.json?full=1", { "x-mock-control": t.mock.controlToken })).status, 200);
});

test("pages are served with a locked-down CSP, no sniffing and no caching", async () => {
  const res = await raw(t.mock, "GET", "/__mock");
  const csp = String(res.headers["content-security-policy"]);
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /script-src 'nonce-[A-Za-z0-9+/=]+'/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.match(csp, /base-uri 'none'/);
  assert.match(csp, /form-action 'self' http:\/\/localhost:3000/);
  assert.equal(res.headers["x-content-type-options"], "nosniff");
  assert.equal(res.headers["cache-control"], "no-store");
  assert.match(res.text, /MOCK PROVIDERS\. Nothing here is Google or Meta/);
});

test("the request log redacts credential-like query values", async () => {
  await raw(t.mock, "GET", "/__mock/state.json?token=SOME-SECRET-VALUE&code=ABC123&x=visible");
  const logged = [...t.mock.state().requests].reverse().find((r) => r.path.startsWith("/__mock/state.json"));
  assert.ok(logged);
  assert.ok(!logged.path.includes("SOME-SECRET-VALUE") && !logged.path.includes("ABC123"));
  assert.match(logged.path, /x=visible/);
});

test("a token the mock did not mint is rejected, and never echoed, logged or printed", async () => {
  const real = "ya29.something-real-looking-0123456789";
  const base = "/google/calendar/v3/calendars/primary/events/abcde12345";
  const res = await raw(t.mock, "GET", base, { authorization: `Bearer ${real}` });
  assert.equal(res.status, 401);
  assert.ok(!res.text.includes(real));
  const gmail = await raw(t.mock, "POST", "/google/gmail/v1/users/me/messages/send", { authorization: `Bearer ${real}`, "content-type": "application/json" }, JSON.stringify({ raw: "AAAA" }));
  assert.equal(gmail.status, 401);
  assert.ok(!gmail.text.includes(real));
  assert.equal((await raw(t.mock, "GET", base)).status, 401, "no token at all");
  assert.equal((await raw(t.mock, "GET", base, { authorization: "Basic abc" })).status, 401);
  const logged = JSON.stringify(t.mock.state().requests);
  assert.ok(!logged.includes(real), "the unknown token is not in the request log");
  assert.ok(t.mock.state().requests.some((r) => r.auth === "Bearer <unknown token, not logged>"));
  assert.ok(!JSON.stringify(t.mock.state()).includes(real));
  assert.ok(!(await raw(t.mock, "GET", "/__mock/requests")).text.includes(real));
});

test("a webhook target outside the local machine is refused, so the mock can never be made to send anywhere else", async () => {
  const post = (url: string) => raw(t.mock, "POST", "/__mock/webhooks/target", { "content-type": "application/json", "x-mock-control": t.mock.controlToken }, JSON.stringify({ url }));
  assert.equal((await post("https://example.com/hook")).status, 400);
  assert.equal((await post("http://169.254.169.254/latest/meta-data")).status, 400);
  assert.equal(t.mock.state().webhooks.target, "http://localhost:3000/api/webhooks/whatsapp");
  assert.equal((await post("http://127.0.0.1:3999/hook")).status, 200);
  await post("http://localhost:3000/api/webhooks/whatsapp");
});

test("the Meta side never echoes or logs the app secret, a client secret in a query, or a token it did not mint", async () => {
  const unknown = "EAAB-real-looking-meta-token-0123456789";
  const appToken = `${META_APP_ID}|${META_APP_SECRET}`;
  const debug = await raw(t.mock, "GET", "/meta/v26.0/debug_token?input_token=whatever", { authorization: `Bearer ${appToken}` });
  assert.equal(debug.status, 200);
  assert.equal(debug.json().data.is_valid, false);
  assert.ok(!debug.text.includes(META_APP_SECRET));
  const bad = await raw(t.mock, "GET", "/meta/v26.0/990000000002001?fields=id", { authorization: `Bearer ${unknown}` });
  assert.equal(bad.status, 400);
  assert.equal(bad.json().error.code, 190);
  assert.ok(!bad.text.includes(unknown));
  const exchange = await raw(t.mock, "GET", `/meta/v26.0/oauth/access_token?client_id=${META_APP_ID}&client_secret=${META_APP_SECRET}&code=SOME-CODE`);
  assert.equal(exchange.status, 400);
  assert.ok(!exchange.text.includes(META_APP_SECRET) && !exchange.text.includes("SOME-CODE"));
  const sdk = await raw(t.mock, "GET", "/meta/en_US/sdk.js");
  const dialog = await raw(t.mock, "GET", `/meta/dialog/embedded-signup?app_id=${META_APP_ID}&config_id=${META_ES_CONFIG_ID}&response_type=code&opener=http://localhost:3000&session=abcdef12345`);
  for (const res of [sdk, dialog]) assert.ok(!res.text.includes(META_APP_SECRET) && !res.text.includes(GOOGLE_CLIENT_SECRET));
  const logged = JSON.stringify(t.mock.state().requests);
  assert.ok(!logged.includes(unknown) && !logged.includes(META_APP_SECRET) && !logged.includes("SOME-CODE"), "none of them is in the request log");
  assert.match(logged, /client_secret=\[redacted\]/);
});

test("every credential the mock mints is marked MOCK-NOT-REAL-, and no Meet link points at meet.google.com", async () => {
  const origin = t.mock.url;
  const query = new URLSearchParams({
    client_id: "mock-client-id.apps.mock-google.invalid",
    redirect_uri: "http://localhost:3000/api/google/callback",
    response_type: "code",
    scope: "openid email https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/gmail.send",
    include_granted_scopes: "true",
    access_type: "offline",
    prompt: "consent",
    state: "s",
  });
  const page = await raw(t.mock, "GET", `/google/o/oauth2/v2/auth?${query}`);
  const decisionId = /name="decisionId" value="([^"]+)"/.exec(page.text)![1];
  const form = new URLSearchParams({ decisionId, account: "creator@mock-google.invalid", action: "allow" });
  form.append("scope", "https://www.googleapis.com/auth/calendar.events");
  const decision = await raw(t.mock, "POST", "/google/o/oauth2/v2/auth/decision", { "content-type": "application/x-www-form-urlencoded", origin, "sec-fetch-site": "same-origin" }, form.toString());
  const code = new URL(String(decision.headers.location)).searchParams.get("code")!;
  const token = await raw(
    t.mock,
    "POST",
    "/google/token",
    { "content-type": "application/x-www-form-urlencoded" },
    new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: "http://localhost:3000/api/google/callback", client_id: "mock-client-id.apps.mock-google.invalid", client_secret: "MOCK-NOT-REAL-google-client-secret" }).toString(),
  );
  assert.equal(token.status, 200, token.text);
  const body = token.json();
  for (const v of [code, body.access_token, body.refresh_token]) assert.match(String(v), /^MOCK-NOT-REAL-/);
  const idToken = String(body.id_token).split(".");
  assert.equal(Buffer.from(idToken[0], "base64url").toString().includes('"alg":"none"'), true, "the ID token is unsigned and says so");
  assert.equal(Buffer.from(idToken[2], "base64url").toString(), "MOCK-NOT-REAL");
  assert.match(JSON.parse(Buffer.from(idToken[1], "base64url").toString()).email, /@mock-google\.invalid$/);

  const event = await raw(
    t.mock,
    "POST",
    "/google/calendar/v3/calendars/primary/events?conferenceDataVersion=1&sendUpdates=all",
    { authorization: `Bearer ${body.access_token}`, "content-type": "application/json" },
    JSON.stringify({ id: "secevent00001", summary: "s", start: { dateTime: "2030-01-01T10:00:00Z" }, end: { dateTime: "2030-01-01T10:30:00Z" }, conferenceData: { createRequest: { requestId: "r" } } }),
  );
  assert.equal(event.status, 200, event.text);
  assert.ok(!event.text.includes("meet.google.com"), "a random code in Meet's real format could be a stranger's live meeting");
  assert.match(event.json().hangoutLink, new RegExp(`^${origin}/meet/mock-`));

  const state = t.mock.state();
  for (const k of [...Object.keys(state.google.codes), ...Object.keys(state.google.refreshTokens), ...Object.keys(state.google.accessTokens)]) assert.match(k, /^MOCK-NOT-REAL-/, k);
  const text = JSON.stringify(state);
  assert.ok(!/(ya29\.|1\/\/0|"EAA)/.test(text), "no real-looking token prefixes");
  assert.ok(!text.includes("https://meet.google.com"));
});
