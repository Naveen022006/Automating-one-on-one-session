import assert from "node:assert/strict";
import { test } from "node:test";
import { CLIENT_UNUSABLE_MESSAGE, clientIdProblem, clientSecretProblem, INVALID_CLIENT_MESSAGE, verifyGoogleClient } from "../lib/google-client-check";

/**
 * doc/15, section C: the pasted Client ID and Client Secret are checked by posting a deliberately invalid authorization code to Google's
 * token endpoint. invalid_client = the pair is wrong; invalid_grant = the pair is accepted. Fetch is injected: nothing reaches Google.
 */

const ID = "1234567890-abcdef_ghi.apps.googleusercontent.com";
const SECRET = "GOCSPX-abcdefghijklmnopqrstuvwxyz1";

type Call = { url: string; body: URLSearchParams; method: string };
function fakeFetch(respond: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const f = (async (url: string | URL, init?: RequestInit) => {
    const call = { url: String(url), body: new URLSearchParams(String(init?.body ?? "")), method: String(init?.method) };
    calls.push(call);
    return respond(call);
  }) as typeof fetch;
  return { f, calls };
}
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

test("invalid_grant means Google accepted the pair; the request carries a fake code and the credentials, to the token endpoint only", async () => {
  const { f, calls } = fakeFetch(() => json(400, { error: "invalid_grant", error_description: "Malformed auth code." }));
  assert.deepEqual(await verifyGoogleClient(ID, SECRET, f, "https://sessions.example.com/api/google/callback"), { ok: true });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, "POST");
  assert.equal(new URL(calls[0].url).hostname, "oauth2.googleapis.com");
  assert.equal(calls[0].body.get("client_id"), ID);
  assert.equal(calls[0].body.get("client_secret"), SECRET);
  assert.equal(calls[0].body.get("grant_type"), "authorization_code");
  assert.equal(calls[0].body.get("redirect_uri"), "https://sessions.example.com/api/google/callback");
  assert.match(calls[0].body.get("code") ?? "", /^client-check/, "a code that can never be a real one");
});

test("invalid_client means the ID and the secret do not belong together, and says how to fix it without echoing either", async () => {
  const { f } = fakeFetch(() => json(401, { error: "invalid_client", error_description: "Unauthorized" }));
  const r = await verifyGoogleClient(ID, SECRET, f);
  assert.ok(!r.ok);
  if (r.ok) return;
  assert.equal(r.reason, "invalid-client");
  assert.equal(r.message, INVALID_CLIENT_MESSAGE);
  assert.match(r.message, /same OAuth client/);
  assert.match(r.message, /without spaces/);
  assert.ok(!r.message.includes(SECRET) && !r.message.includes(ID));
});

test("deleted_client and unauthorized_client mean the client itself is unusable, and say so", async () => {
  for (const error of ["deleted_client", "unauthorized_client"]) {
    const r = await verifyGoogleClient(ID, SECRET, fakeFetch(() => json(401, { error, error_description: "x" })).f);
    assert.ok(!r.ok && r.reason === "invalid-client", error);
    if (!r.ok) {
      assert.equal(r.message, CLIENT_UNUSABLE_MESSAGE);
      assert.match(r.message, /^Google says this client is invalid, deleted or not a Web application client/);
    }
  }
});

test("a network error, a timeout and a Google outage are 'could not check', never 'wrong credentials'", async () => {
  for (const make of [
    () => Promise.reject(new TypeError("fetch failed")),
    () => Promise.reject(Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" })),
  ]) {
    const f = (async () => make()) as unknown as typeof fetch;
    const r = await verifyGoogleClient(ID, SECRET, f);
    assert.ok(!r.ok && r.reason === "unreachable", JSON.stringify(r));
    if (!r.ok) assert.match(r.message, /Nothing was saved/);
  }
  const busy = await verifyGoogleClient(ID, SECRET, fakeFetch(() => new Response("<html>bad gateway</html>", { status: 502 })).f);
  assert.ok(!busy.ok && busy.reason === "unreachable");
  const limited = await verifyGoogleClient(ID, SECRET, fakeFetch(() => json(429, {})).f);
  assert.ok(!limited.ok && limited.reason === "unreachable");
});

test("an answer nobody expected is reported as such, with the error name but never the secret", async () => {
  const odd = await verifyGoogleClient(ID, SECRET, fakeFetch(() => json(400, { error: "invalid_scope", error_description: `client ${SECRET} not allowed` })).f);
  assert.ok(!odd.ok && odd.reason === "unexpected");
  if (!odd.ok) {
    assert.match(odd.message, /invalid_scope/);
    assert.ok(!odd.message.includes(SECRET));
  }
  const html = await verifyGoogleClient(ID, SECRET, fakeFetch(() => new Response("nope", { status: 403 })).f);
  assert.ok(!html.ok && html.reason === "unexpected" && /HTTP 403/.test(html.message));
});

test("the request has a timeout, so a hanging Google cannot hang the save", async () => {
  let signal: AbortSignal | null | undefined;
  const f = (async (_url: string | URL, init?: RequestInit) => {
    signal = init?.signal;
    return json(400, { error: "invalid_grant" });
  }) as typeof fetch;
  await verifyGoogleClient(ID, SECRET, f);
  assert.ok(signal instanceof AbortSignal);
});

test("format checks run first, never reach Google, and name the problem", async () => {
  let called = 0;
  const f = (async () => (called++, json(400, { error: "invalid_grant" }))) as unknown as typeof fetch;
  const bad = [
    [" " + ID, SECRET, "format-id", /space/],
    [ID + " ", SECRET, "format-id", /space/],
    ["not-an-id", SECRET, "format-id", /1234567890-abcdefg/],
    ["1234.apps.googleusercontent.com", SECRET, "format-id", /should look like/],
    [SECRET, SECRET, "format-id", /Client Secret/],
    [ID, "short", "format-secret", /20 to 80/],
    [ID, "x".repeat(81), "format-secret", /20 to 80/],
    [ID, "has space in the secret 1234567", "format-secret", /space/],
    [ID, ID, "format-secret", /Client ID/],
    [ID, "weird!chars!weird!chars!1234", "format-secret", /letters, digits/],
    ["", SECRET, "format-id", /should look like/],
    [ID, "", "format-secret", /20 to 80/],
  ] as const;
  for (const [id, secret, reason, text] of bad) {
    const r = await verifyGoogleClient(id, secret, f);
    assert.ok(!r.ok && r.reason === reason, `${id} / ${secret}: ${JSON.stringify(r)}`);
    if (!r.ok) assert.match(r.message, text);
  }
  assert.equal(called, 0, "not a single call to Google for a badly shaped value");
});

test("good shapes: the GOCSPX- prefix, underscores and dashes are accepted, and so are old-style secrets", () => {
  assert.equal(clientIdProblem(ID), null);
  assert.equal(clientIdProblem("1-a_B9.apps.googleusercontent.com"), null);
  assert.equal(clientSecretProblem(SECRET), null);
  assert.equal(clientSecretProblem("abcdefghij_klmnopqrst-uv"), null);
  assert.equal(clientSecretProblem("a".repeat(20)), null);
  assert.equal(clientSecretProblem("a".repeat(80)), null);
  assert.notEqual(clientIdProblem("1-a.apps.googleusercontent.com.evil.example"), null);
  assert.notEqual(clientIdProblem("http://1-a.apps.googleusercontent.com"), null);
});
