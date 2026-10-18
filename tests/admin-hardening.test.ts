// Pure tests (no database) for the review fixes: fail-closed rate limits, security emails, the proxy's admin redirect, and the
// split-payout threshold rule.
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { NextRequest } from "next/server";
import { adminSecurityMessage, type AdminSecurityEvent } from "../lib/email/templates";
import { approvalRequired, payoutApprovalView } from "../lib/payouts";
import { consume, type RateLimitRule, type RateLimitStore } from "../lib/rate-limit/core";
import { enforce, setStore, tooManyRequests } from "../lib/rate-limit";
import { IDENTITY_RULES, ROUTE_RULES } from "../lib/rate-limit/policies";

const broken: RateLimitStore = {
  name: "broken",
  hit: async () => {
    throw new Error("store down");
  },
};
const rule: RateLimitRule = { name: "test-open", limit: 5, windowMs: 60_000 };

afterEach(() => setStore(null));

test("a store outage lets a normal rule through but refuses a failClosed rule", async () => {
  const errors: unknown[] = [];
  const open = await consume(broken, rule, "someone", { onError: (e) => errors.push(e) });
  assert.equal(open.allowed, true, "default: fail open");
  assert.equal(open.degraded, undefined);
  assert.equal(open.store, "none");
  assert.equal(errors.length, 1);

  const closed = await consume(broken, { ...rule, name: "test-closed", failClosed: true }, "someone", { onError: (e) => errors.push(e) });
  assert.equal(closed.allowed, false, "failClosed: refuse");
  assert.equal(closed.degraded, true);
  assert.equal(closed.remaining, 0);
  assert.ok(closed.retryAfterSec >= 1 && closed.retryAfterSec <= 30);
  assert.equal(errors.length, 2, "the outage is still reported");
});

test("a working store behaves the same for failClosed rules (it only matters during an outage)", async () => {
  let n = 0;
  const counting: RateLimitStore = { name: "counting", hit: async () => ({ current: ++n, previous: 0 }) };
  const strict: RateLimitRule = { name: "strict", limit: 2, windowMs: 60_000, failClosed: true };
  const results = [];
  for (let i = 0; i < 4; i++) results.push((await consume(counting, strict, "id")).allowed);
  assert.deepEqual(results, [true, true, false, false]);
});

test("enforce answers 503 (not 429) when a failClosed rule cannot be evaluated, and passes an open rule", async () => {
  setStore(broken);
  const closed = await enforce({ ...rule, name: "enf-closed", failClosed: true }, "admin|1.2.3.4", "Too many attempts.");
  assert.equal(closed?.status, 503);
  const body = await closed!.json();
  assert.match(body.error, /temporarily unavailable/);
  assert.ok(closed!.headers.get("Retry-After"));

  assert.equal(await enforce({ ...rule, name: "enf-open" }, "admin|1.2.3.4"), null, "an ordinary rule still fails open");

  // And a genuine limit is still a 429 with the caller's message.
  setStore({ name: "full", hit: async () => ({ current: 999, previous: 0 }) });
  const limited = await enforce({ ...rule, name: "enf-full", failClosed: true }, "x", "Too many attempts.");
  assert.equal(limited?.status, 429);
  assert.equal((await limited!.json()).error, "Too many attempts.");
  assert.equal(tooManyRequests({ allowed: false, limit: 1, remaining: 0, resetSec: 5, retryAfterSec: 5, store: "x" }).status, 429);
});

test("exactly the admin password/code rules fail closed; no other rule changes behaviour", () => {
  const closed = [
    ...Object.values(IDENTITY_RULES).filter((r) => (r as RateLimitRule).failClosed),
    ...ROUTE_RULES.filter((r) => r.failClosed),
  ]
    .map((r) => r.name)
    .sort();
  assert.deepEqual(closed, [
    "admin-mfa",
    "admin-mfa-admin",
    "admin-mfa-admin-ip",
    "admin-mfa-manage-admin",
    "admin-mfa-manage-admin-ip",
    "admin-password-user-ip",
    "admin-security",
  ]);
  // The management route also has a per-admin cap that does not depend on the IP.
  assert.equal(IDENTITY_RULES.adminMfaManageAdmin.limit, 30);
  assert.equal(IDENTITY_RULES.adminMfaManageAdmin.windowMs, 3_600_000);
  assert.equal(IDENTITY_RULES.adminMfaAdmin.limit, 30, "the login code step is capped at 30 per hour per admin");
});

test("security emails escape everything they interpolate and describe each event", () => {
  const events: AdminSecurityEvent[] = ["2fa-enabled", "2fa-disabled", "recovery-regenerated", "mfa-locked"];
  const at = new Date("2026-10-20T10:00:00Z");
  for (const event of events) {
    const m = adminSecurityMessage("<script>alert(1)</script> Bob", event, { at, ip: "203.0.113.9<img src=x>", lockedUntil: new Date("2026-10-20T10:15:00Z") });
    assert.ok(m.subject.length > 10, event);
    assert.ok(!m.html.includes("<script>alert(1)"), `${event}: name is escaped in the HTML`);
    assert.ok(!m.html.includes("<img src=x>"), `${event}: IP is escaped in the HTML`);
    assert.ok(m.html.includes("&lt;img src=x&gt;") || m.html.includes("&lt;img"), `${event}: escaped IP is shown`);
    assert.match(m.text, /Tue, 20 Oct 2026, 3:30 PM IST/, "the security e-mail says the time in IST");
  }
  const locked = adminSecurityMessage("Ana Admin", "mfa-locked", { at, lockedUntil: new Date("2026-10-20T10:15:00Z") });
  assert.match(locked.text, /until Tue, 20 Oct 2026, 3:45 PM IST/);
  assert.match(locked.text, /recovery code/i);
  assert.match(adminSecurityMessage("Ana", "2fa-disabled", { at }).text, /other sessions were signed out/i);
});

test("the proxy decides the admin redirect and the rewrite from the real URL, whatever x-pathname a client sends (nothing reads that header any more)", async () => {
  const { proxy } = await import("../proxy");
  // With an admin cookie the page goes to the shell for ITS path; a forged header changes nothing.
  const forged = await proxy(new NextRequest("http://localhost:3000/admin/payouts?tab=1", { headers: { "x-pathname": "/admin/security", cookie: "sa_admin=anything" } }));
  assert.ok((forged.headers.get("x-middleware-rewrite") ?? "").endsWith("/spa-shell/admin/payouts?tab=1"), forged.headers.get("x-middleware-rewrite") ?? String(forged.status));

  // Without any admin cookie the admin area redirects to the login before anything else.
  const anon = await proxy(new NextRequest("http://localhost:3000/admin/security", { headers: { "x-pathname": "/admin/login" } }));
  assert.equal(anon.status, 307);
  assert.match(anon.headers.get("location") ?? "", /\/admin\/login\?next=/);
});

test("the approval threshold counts the other unapproved payouts of the last 24 hours (no splitting under it)", () => {
  const th = { PAYOUT_FOUR_EYES: "true", PAYOUT_FOUR_EYES_MIN_MINOR: "100000" } as unknown as NodeJS.ProcessEnv;
  assert.equal(approvalRequired(59_000, th), false, "alone, below the threshold");
  assert.equal(approvalRequired(59_000, th, 0), false);
  assert.equal(approvalRequired(59_000, th, 40_999), false, "99,999 in total is still below");
  assert.equal(approvalRequired(59_000, th, 41_000), true, "reaching the threshold in total needs approval");
  assert.equal(approvalRequired(59_000, th, 500_000), true);
  assert.equal(approvalRequired(1, { PAYOUT_FOUR_EYES: "false", PAYOUT_FOUR_EYES_MIN_MINOR: "1" } as unknown as NodeJS.ProcessEnv, 999_999), false, "four-eyes off");

  const pending = { status: "PENDING", netMinor: 59_000, createdByEmail: "a@example.com", approvedAt: null, approvedByEmail: null };
  assert.equal(payoutApprovalView(pending, "b@example.com", th, 0).required, false);
  const split = payoutApprovalView(pending, "b@example.com", th, 59_000);
  assert.equal(split.required, true);
  assert.equal(split.canMarkPaid, false);
  assert.equal(split.canApprove, true);
});
