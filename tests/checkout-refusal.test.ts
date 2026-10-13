// QA-13 (doc/10-react-migration-qa-customer.md): a 409 from checkout is followed by a status read that decides the screen.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { checkoutRefusalOutcome } from "../web/src/lib/checkout-refusal";

const now = Date.parse("2030-01-01T10:00:00Z");
const iso = (ms: number) => new Date(ms).toISOString();

test("paid in another tab: confirm it; expired, cancelled or a hold past its end: the hold has ended; FAILED: failed", () => {
  for (const s of ["PAID", "SCHEDULED", "COMPLETED"]) assert.equal(checkoutRefusalOutcome({ status: s, holdExpiresAt: null }, now), "paid", s);
  assert.equal(checkoutRefusalOutcome({ status: "EXPIRED", holdExpiresAt: iso(now - 1) }, now), "hold-ended");
  assert.equal(checkoutRefusalOutcome({ status: "CANCELLED", holdExpiresAt: null }, now), "hold-ended");
  assert.equal(checkoutRefusalOutcome({ status: "PENDING_PAYMENT", holdExpiresAt: iso(now - 1) }, now), "hold-ended", "not swept yet");
  assert.equal(checkoutRefusalOutcome({ status: "HELD", holdExpiresAt: iso(now) }, now), "hold-ended", "ends exactly now");
  assert.equal(checkoutRefusalOutcome({ status: "FAILED", holdExpiresAt: null }, now), "failed");
});

test("anything the page cannot read keeps the server's message (unknown)", () => {
  assert.equal(checkoutRefusalOutcome({ status: "HELD", holdExpiresAt: iso(now + 60_000) }, now), "unknown", "still held: another reason");
  for (const v of [null, undefined, {}, { status: 3 }, { status: "REQUESTED" }]) assert.equal(checkoutRefusalOutcome(v as never, now), "unknown", JSON.stringify(v));
});

test("BookingFlow asks for the status after a 409 from checkout and uses this decision", () => {
  const src = readFileSync(path.join(__dirname, "../web/src/pages/booking/BookingFlow.tsx"), "utf8");
  assert.match(src, /res\.status === 409/);
  assert.match(src, /checkoutRefusalOutcome\(/);
});
