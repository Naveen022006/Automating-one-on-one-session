import assert from "node:assert/strict";
import { test } from "node:test";
import { IDENTITY_RULES, matchRouteRule } from "../lib/rate-limit/policies";
import { MemoryStore, consume } from "../lib/rate-limit/core";

/**
 * doc/15: the endpoints that call Google or move a credential are rate limited. The proxy picks the rule from lib/rate-limit/policies.ts,
 * so the rules are pinned by what they match.
 */

test("saving or removing a Google client has its own tight limit, keyed by the session", () => {
  const rule = matchRouteRule("POST", "/api/dashboard/google-client");
  assert.equal(rule?.name, "dashboard-google-client");
  assert.equal(rule?.by, "session-or-ip");
  assert.ok(rule && rule.limit <= 10, "it calls Google, so a handful per hour");
  assert.ok(rule && rule.windowMs >= 60 * 60_000);
  // Reading the card is ordinary dashboard traffic.
  assert.equal(matchRouteRule("GET", "/api/dashboard/google-client")?.name, "dashboard");
  // Look-alikes do not get the tight rule, and the old disconnect endpoint keeps the general dashboard rule.
  assert.equal(matchRouteRule("POST", "/api/dashboard/google-client/extra")?.name, "dashboard");
  assert.equal(matchRouteRule("DELETE", "/api/dashboard/google")?.name, "dashboard");
});

test("the OAuth round trip keeps its own rule", () => {
  assert.equal(matchRouteRule("GET", "/api/google/connect")?.name, "google-oauth");
  assert.equal(matchRouteRule("GET", "/api/google/callback")?.name, "google-oauth");
});

test("the administrator's account help (verify an address, hand over a reset link) is limited per address", () => {
  for (const tail of ["verify-email", "reset-link"]) {
    const rule = matchRouteRule("POST", `/api/admin/influencers/abc123/${tail}`);
    assert.equal(rule?.name, "admin-account-help", tail);
    assert.ok(rule && rule.limit <= 30 && rule.windowMs >= 60 * 60_000);
  }
  assert.equal(matchRouteRule("GET", "/api/admin/influencers/abc123/verify-email")?.name, "admin", "only POST is the action");
  assert.equal(matchRouteRule("POST", "/api/admin/influencers/abc123/reset-link/x")?.name, "admin");
});

test("the per-influencer check limit holds across addresses and devices (it is keyed by the influencer, not the IP)", async () => {
  const rule = IDENTITY_RULES.googleClientCheck;
  assert.ok(rule.limit <= 12 && rule.windowMs === 60 * 60_000);
  const store = new MemoryStore();
  const results: boolean[] = [];
  for (let i = 0; i < rule.limit + 3; i++) results.push((await consume(store, rule, "influencer-1")).allowed);
  assert.deepEqual(results.slice(0, rule.limit), Array(rule.limit).fill(true));
  assert.deepEqual(results.slice(rule.limit), [false, false, false]);
  assert.equal((await consume(store, rule, "influencer-2")).allowed, true, "another influencer has their own allowance");
});
