import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "node:test";
import {
  isVerifyRequestValid,
  mapWhatsAppStatus,
  parseWhatsAppStatuses,
  verifyMetaSignature,
} from "../lib/whatsapp-webhook";

test("status mapping: sent/delivered/read/failed map to MessageStatus; unknown -> null", () => {
  assert.equal(mapWhatsAppStatus("sent"), "SENT");
  assert.equal(mapWhatsAppStatus("delivered"), "DELIVERED");
  assert.equal(mapWhatsAppStatus("read"), "READ");
  assert.equal(mapWhatsAppStatus("failed"), "FAILED");
  assert.equal(mapWhatsAppStatus("bogus"), null);
});

test("verify token: accepts the correct token, rejects wrong token/mode/missing expected", () => {
  assert.equal(isVerifyRequestValid("subscribe", "secret", "secret"), true);
  assert.equal(isVerifyRequestValid("subscribe", "wrong", "secret"), false);
  assert.equal(isVerifyRequestValid("unsubscribe", "secret", "secret"), false);
  assert.equal(isVerifyRequestValid("subscribe", "secret", undefined), false);
  assert.equal(isVerifyRequestValid(null, null, "secret"), false);
});

test("parseWhatsAppStatuses flattens entry[].changes[].value.statuses[] and keeps error on failed", () => {
  const payload = {
    entry: [
      {
        changes: [
          {
            value: {
              statuses: [
                { id: "wamid.1", status: "delivered" },
                { id: "wamid.2", status: "failed", errors: [{ code: 131026, title: "undeliverable", message: "no account" }] },
                { id: "wamid.3", status: "bogus" },
                { status: "sent" },
              ],
            },
          },
        ],
      },
    ],
  };

  const updates = parseWhatsAppStatuses(payload);
  assert.equal(updates.length, 2);
  assert.deepEqual(updates[0], { providerMessageId: "wamid.1", status: "DELIVERED", error: null });
  assert.equal(updates[1].providerMessageId, "wamid.2");
  assert.equal(updates[1].status, "FAILED");
  assert.equal(updates[1].error, "no account");
});

test("parseWhatsAppStatuses tolerates empty/malformed payloads", () => {
  assert.deepEqual(parseWhatsAppStatuses(undefined), []);
  assert.deepEqual(parseWhatsAppStatuses({}), []);
  assert.deepEqual(parseWhatsAppStatuses({ entry: [{}] }), []);
});

test("parseWhatsAppStatuses omits error on non-FAILED so a later callback cannot clobber it", () => {
  const payload = {
    entry: [{ changes: [{ value: { statuses: [{ id: "wamid.1", status: "delivered" }] } }] }],
  };
  const [u] = parseWhatsAppStatuses(payload);
  assert.equal(u.status, "DELIVERED");
  assert.equal("error" in u, false);
});

test("verifyMetaSignature: accepts the correct sha256= HMAC of the raw body", () => {
  const body = '{"object":"whatsapp_business_account"}';
  const sig = "sha256=" + createHmac("sha256", "app-secret").update(body).digest("hex");
  assert.equal(verifyMetaSignature(body, sig, "app-secret"), true);
});

test("verifyMetaSignature: rejects tampered body, wrong secret, missing/malformed header or secret", () => {
  const body = '{"object":"whatsapp_business_account"}';
  const sig = "sha256=" + createHmac("sha256", "app-secret").update(body).digest("hex");
  assert.equal(verifyMetaSignature(body + " ", sig, "app-secret"), false);
  assert.equal(verifyMetaSignature(body, sig, "other"), false);
  assert.equal(verifyMetaSignature(body, null, "app-secret"), false);
  assert.equal(verifyMetaSignature(body, sig, undefined), false);
  // Missing "sha256=" prefix.
  assert.equal(
    verifyMetaSignature(body, createHmac("sha256", "app-secret").update(body).digest("hex"), "app-secret"),
    false,
  );
  // Non-hex / wrong-length digest.
  assert.equal(verifyMetaSignature(body, "sha256=zz", "app-secret"), false);
});

test("isVerifyRequestValid: still rejects a wrong-length token under constant-time compare", () => {
  assert.equal(isVerifyRequestValid("subscribe", "secretlonger", "secret"), false);
});
