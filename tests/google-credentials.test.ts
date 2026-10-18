import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { decryptSecret, encryptSecret } from "../lib/crypto";
import {
  CREDENTIAL_FAILURE_MESSAGES,
  getGoogleCredentials,
  googleClientAad,
  googleClientMode,
  googleRedirectUri,
  maskClientId,
  platformGoogleCredentials,
  toClientKind,
  type CredentialDeps,
} from "../lib/google-credentials";

/**
 * doc/15: which Google OAuth client an influencer's calls use. Database-free: the stored row is a fake that encrypts with the real
 * AES-256-GCM code (so the AAD binding is the real one).
 */

process.env.TOKEN_ENCRYPTION_KEY ||= randomBytes(32).toString("base64");

const OWN_ID = "111-own.apps.googleusercontent.com";
const OWN_SECRET = "GOCSPX-own-secret-0123456789abc";
const PLATFORM = { GOOGLE_CLIENT_ID: "222-platform.apps.googleusercontent.com", GOOGLE_CLIENT_SECRET: "platform-secret-0123456789abcdef" };

function deps(env: Record<string, string | undefined>, opts: { own?: boolean; as?: string } = {}) {
  const asked: string[] = [];
  const d: CredentialDeps = {
    env,
    loadOwn: async (influencerId) => {
      asked.push(influencerId);
      if (!opts.own) return null;
      // The row of `as` (default: the one asked for): a ciphertext is bound to the influencer it was written for.
      return { clientId: OWN_ID, clientSecretEnc: encryptSecret(OWN_SECRET, googleClientAad(opts.as ?? influencerId)) };
    },
    decrypt: decryptSecret,
  };
  return { d, asked };
}

const APP = { APP_URL: "https://sessions.example.com" };

type Expect = "own" | "platform" | "no-own-client" | "no-client";

// The matrix for a NEW connection (no kind given): the mode decides.
const NEW_CONNECTION: [mode: string | undefined, own: boolean, platform: boolean, expected: Expect][] = [
  [undefined, true, true, "own"],
  [undefined, true, false, "own"],
  [undefined, false, true, "no-own-client"], // the default never falls back to the shared pair
  [undefined, false, false, "no-own-client"],
  ["", false, true, "no-own-client"], // empty means the default
  ["own", true, true, "own"],
  ["own", false, true, "no-own-client"],
  ["platform", true, true, "platform"], // a saved own client is not used in platform mode
  ["platform", false, true, "platform"],
  ["platform", true, false, "no-client"],
  ["either", true, true, "own"],
  ["either", true, false, "own"],
  ["either", false, true, "platform"],
  ["either", false, false, "no-client"],
  ["EITHER", false, true, "platform"], // case does not matter
  ["nonsense", false, true, "no-own-client"], // an unknown value is the default, the safe side
];

for (const [mode, own, platform, expected] of NEW_CONNECTION) {
  test(`new connection: GOOGLE_CLIENT_MODE=${JSON.stringify(mode)}, own client ${own ? "saved" : "missing"}, shared pair ${platform ? "set" : "unset"} -> ${expected}`, async () => {
    const env = { ...APP, ...(mode === undefined ? {} : { GOOGLE_CLIENT_MODE: mode }), ...(platform ? PLATFORM : {}) };
    const { d } = deps(env, { own });
    const r = await getGoogleCredentials("inf-a", undefined, d);
    if (expected === "own" || expected === "platform") {
      assert.ok(r.ok);
      if (!r.ok) return;
      assert.equal(r.kind, expected);
      assert.equal(r.credentials.clientId, expected === "own" ? OWN_ID : PLATFORM.GOOGLE_CLIENT_ID);
      assert.equal(r.credentials.clientSecret, expected === "own" ? OWN_SECRET : PLATFORM.GOOGLE_CLIENT_SECRET);
      assert.equal(r.credentials.redirectUri, "https://sessions.example.com/api/google/callback");
    } else {
      assert.ok(!r.ok);
      if (r.ok) return;
      assert.equal(r.reason, expected);
      assert.equal(r.message, CREDENTIAL_FAILURE_MESSAGES[expected]);
    }
  });
}

test("an existing grant uses exactly the client it was issued with, whatever the mode says", async () => {
  // A grant made with the influencer's own client is refreshed with it even if the site now runs in platform mode ...
  const own = await getGoogleCredentials("inf-a", "own", deps({ ...APP, ...PLATFORM, GOOGLE_CLIENT_MODE: "platform" }, { own: true }).d);
  assert.ok(own.ok && own.kind === "own" && own.credentials.clientId === OWN_ID);
  // ... and one made with the shared pair keeps using it in the default mode while the pair is still configured ...
  const platform = await getGoogleCredentials("inf-a", "platform", deps({ ...APP, ...PLATFORM }, { own: true }).d);
  assert.ok(platform.ok && platform.kind === "platform" && platform.credentials.clientId === PLATFORM.GOOGLE_CLIENT_ID);
  // ... but a grant never silently switches client: no own client means no credentials, with the shared pair sitting right there.
  const missingOwn = await getGoogleCredentials("inf-a", "own", deps({ ...APP, ...PLATFORM }, { own: false }).d);
  assert.deepEqual(missingOwn, { ok: false, reason: "no-own-client", message: CREDENTIAL_FAILURE_MESSAGES["no-own-client"] });
  // ... and the shared pair being gone does not turn into the influencer's own client either.
  const missingPlatform = await getGoogleCredentials("inf-a", "platform", deps(APP, { own: true }).d);
  assert.deepEqual(missingPlatform, { ok: false, reason: "no-platform-client", message: CREDENTIAL_FAILURE_MESSAGES["no-platform-client"] });
});

test("only the asked-for influencer's client is ever read", async () => {
  const { d, asked } = deps(APP, { own: true });
  await getGoogleCredentials("inf-a", "own", d);
  await getGoogleCredentials("inf-b", undefined, d);
  assert.deepEqual(asked, ["inf-a", "inf-b"]);
  const platformOnly = deps({ ...APP, ...PLATFORM, GOOGLE_CLIENT_MODE: "platform" }, { own: true });
  await getGoogleCredentials("inf-c", undefined, platformOnly.d);
  assert.deepEqual(platformOnly.asked, [], "platform mode does not even look at an influencer's row");
});

test("the secret is bound to its influencer: a ciphertext copied onto another influencer cannot be read", async () => {
  const stolen = deps(APP, { own: true, as: "inf-a" });
  const r = await getGoogleCredentials("inf-b", "own", stolen.d);
  assert.deepEqual(r, { ok: false, reason: "unreadable", message: CREDENTIAL_FAILURE_MESSAGES.unreadable });
  assert.throws(() => decryptSecret(encryptSecret(OWN_SECRET, googleClientAad("inf-a")), googleClientAad("inf-b")));
  assert.equal(googleClientAad("inf-a"), "google-client:inf-a");
  // The ciphertext is not the secret, and has the versioned AES-GCM shape.
  const enc = encryptSecret(OWN_SECRET, googleClientAad("inf-a"));
  assert.ok(!enc.includes(OWN_SECRET) && enc.startsWith("v1."));
});

test("no failure message contains a secret, an id or an environment variable's value", async () => {
  for (const m of Object.values(CREDENTIAL_FAILURE_MESSAGES)) {
    assert.ok(!m.includes(OWN_SECRET) && !m.includes(PLATFORM.GOOGLE_CLIENT_SECRET) && !/GOCSPX|GOOGLE_CLIENT/.test(m), m);
  }
  assert.match(CREDENTIAL_FAILURE_MESSAGES["no-own-client"], /^Your Google client was removed or is no longer valid/);
});

test("GOOGLE_CLIENT_MODE parsing and the redirect URI default", () => {
  assert.equal(googleClientMode({}), "own");
  assert.equal(googleClientMode({ GOOGLE_CLIENT_MODE: " Platform " }), "platform");
  assert.equal(googleClientMode({ GOOGLE_CLIENT_MODE: "either" }), "either");
  assert.equal(googleClientMode({ GOOGLE_CLIENT_MODE: "x" }), "own");
  assert.equal(googleRedirectUri({ APP_URL: "https://sessions.example.com/" }), "https://sessions.example.com/api/google/callback");
  assert.equal(googleRedirectUri({}), "http://localhost:3000/api/google/callback");
  assert.equal(googleRedirectUri({ APP_URL: "https://a.example", GOOGLE_REDIRECT_URI: "https://b.example/cb" }), "https://b.example/cb", "an explicit value wins");
  assert.equal(platformGoogleCredentials({ GOOGLE_CLIENT_ID: "x" }), null, "both halves are needed");
});

test("helpers: client kind narrowing and the masked client ID", () => {
  assert.equal(toClientKind("own"), "own");
  for (const odd of ["platform", "", "OWN", null, undefined, "constructor"]) assert.equal(toClientKind(odd), "platform");
  assert.equal(maskClientId("123456789-abcdwxyz.apps.googleusercontent.com"), "…wxyz");
  assert.equal(maskClientId("1-ab.apps.googleusercontent.com"), "…");
  assert.ok(!maskClientId(OWN_ID).includes("111"), "the project number is not in the mask");
});
