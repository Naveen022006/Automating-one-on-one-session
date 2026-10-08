import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "node:test";
import { verifyWebhookSignature } from "../lib/payments";

test("webhook signature: accepts the correct HMAC of the raw body", () => {
  const body = '{"event":"payment.captured"}';
  const sig = createHmac("sha256", "s3cret").update(body).digest("hex");
  assert.equal(verifyWebhookSignature(body, sig, "s3cret"), true);
});

test("webhook signature: rejects tampered body, wrong secret, missing or malformed signature", () => {
  const body = '{"event":"payment.captured"}';
  const sig = createHmac("sha256", "s3cret").update(body).digest("hex");
  assert.equal(verifyWebhookSignature(body + " ", sig, "s3cret"), false);
  assert.equal(verifyWebhookSignature(body, sig, "other"), false);
  assert.equal(verifyWebhookSignature(body, null, "s3cret"), false);
  assert.equal(verifyWebhookSignature(body, "zz", "s3cret"), false);
});
