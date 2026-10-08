import assert from "node:assert/strict";
import { test } from "node:test";
import { SELF_SERVICE_PURPOSE } from "../lib/self-service";
import { signToken, verifyToken } from "../lib/signing";

// Round-trip test for the customer self-service signed link, mirroring tests/signature.test.ts. An explicit
// key is passed so the test needs no APP_SECRET env var and no DB.
const KEY = "test-self-service-secret-key";

test("self-service token: a valid token verifies and returns the booking id", () => {
  const token = signToken(SELF_SERVICE_PURPOSE, { b: "bk_123" }, 3600, KEY);
  const data = verifyToken<{ b: string }>(SELF_SERVICE_PURPOSE, token, KEY);
  assert.equal(data?.b, "bk_123");
});

test("self-service token: a tampered body is rejected", () => {
  const token = signToken(SELF_SERVICE_PURPOSE, { b: "bk_123" }, 3600, KEY);
  const [body, sig] = token.split(".");
  const forged = Buffer.from(JSON.stringify({ b: "bk_999", exp: Math.floor(Date.now() / 1000) + 3600 })).toString(
    "base64url",
  );
  assert.equal(verifyToken(SELF_SERVICE_PURPOSE, `${forged}.${sig}`, KEY), null);
  // The genuine body is unaffected.
  assert.ok(verifyToken(SELF_SERVICE_PURPOSE, `${body}.${sig}`, KEY));
});

test("self-service token: an expired token is rejected", () => {
  const expired = signToken(SELF_SERVICE_PURPOSE, { b: "bk_123" }, -10, KEY);
  assert.equal(verifyToken(SELF_SERVICE_PURPOSE, expired, KEY), null);
});

test("self-service token: a token minted for another purpose is rejected (no cross-purpose replay)", () => {
  const dashboardToken = signToken("influencer-dashboard-link", { b: "bk_123" }, 3600, KEY);
  assert.equal(verifyToken(SELF_SERVICE_PURPOSE, dashboardToken, KEY), null);
});

test("self-service token: a token signed with a different key is rejected", () => {
  const token = signToken(SELF_SERVICE_PURPOSE, { b: "bk_123" }, 3600, KEY);
  assert.equal(verifyToken(SELF_SERVICE_PURPOSE, token, "other-key"), null);
});
