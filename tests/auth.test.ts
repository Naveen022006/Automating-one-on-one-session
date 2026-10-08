import assert from "node:assert/strict";
import { test } from "node:test";
import { isCsrfExempt, isSameOriginRequest } from "../lib/auth/csrf";
import { hashPassword, needsRehash, passwordProblem, verifyPassword } from "../lib/auth/password";
import { slugProblem, suggestSlug } from "../lib/auth/slug";
import { hashToken, randomToken } from "../lib/auth/tokens";
import { safeNextPath } from "../lib/http";

// Pure auth rules (no database): password hashing and policy, slugs, CSRF origin checks, redirects, tokens.

test("passwords hash with a random salt and verify only the right password", async () => {
  const a = await hashPassword("correct horse battery");
  const b = await hashPassword("correct horse battery");
  assert.notEqual(a, b, "salted");
  assert.match(a, /^scrypt\$\d+\$\d+\$\d+\$/);
  assert.equal(await verifyPassword("correct horse battery", a), true);
  assert.equal(await verifyPassword("correct horse batterY", a), false);
  assert.equal(await verifyPassword("anything", "not-a-hash"), false);
  assert.equal(needsRehash(a), false);
  assert.equal(needsRehash("scrypt$1024$8$1$c2FsdA$aGFzaA"), true);
});

test("password policy: length, common passwords, sequences, personal info", () => {
  assert.match(passwordProblem("short")!, /at least 10/);
  assert.match(passwordProblem("password123")!, /too common/);
  assert.match(passwordProblem("aaaaaaaaaaaa")!, /repeated/);
  assert.match(passwordProblem("1234567890")!, /common|sequence/);
  assert.match(passwordProblem("qwertyuiop")!, /common|sequence/);
  assert.match(passwordProblem("priya.sharma-2026", { email: "priya.sharma@example.com" })!, /email/);
  assert.equal(passwordProblem("Monsoon tea at 4pm!"), null);
});

test("slugs: format, reserved words, suggestions", () => {
  assert.equal(slugProblem("priya-sharma"), null);
  assert.ok(slugProblem("ab"), "too short");
  assert.ok(slugProblem("Priya"), "uppercase");
  assert.ok(slugProblem("-priya"), "leading hyphen");
  assert.ok(slugProblem("pri--ya"), "double hyphen");
  for (const reserved of ["dashboard", "login", "api", "manage", "admin", "register"]) {
    assert.match(slugProblem(reserved)!, /reserved/, reserved);
  }
  assert.equal(suggestSlug("Priya Sharma"), "priya-sharma");
  assert.equal(suggestSlug("José Ñúñez"), "jose-nunez");
  assert.equal(suggestSlug("!!"), "creator");
  assert.equal(suggestSlug("Dashboard"), "dashboard-sessions");
});

test("CSRF: same-origin requests pass, cross-site writes are rejected, webhooks and reads are exempt", () => {
  const url = "https://app.example.com/api/dashboard/services";
  const h = (o: Record<string, string>) => new Headers(o);
  assert.equal(isSameOriginRequest(h({ origin: "https://app.example.com" }), url, "https://app.example.com"), true);
  assert.equal(isSameOriginRequest(h({ origin: "https://evil.example" }), url, "https://app.example.com"), false);
  assert.equal(isSameOriginRequest(h({ origin: "null", "sec-fetch-site": "cross-site" }), url), false);
  assert.equal(isSameOriginRequest(h({ "sec-fetch-site": "same-origin" }), url), true);
  assert.equal(isSameOriginRequest(h({ "sec-fetch-site": "cross-site" }), url), false);
  // Behind a proxy the request URL can be internal; APP_URL is the public origin.
  assert.equal(isSameOriginRequest(h({ origin: "https://app.example.com" }), "http://10.0.0.5:3000/api/x", "https://app.example.com"), true);
  assert.equal(isCsrfExempt("GET", "/api/dashboard/services"), true);
  assert.equal(isCsrfExempt("POST", "/api/webhooks/payment"), true);
  assert.equal(isCsrfExempt("POST", "/api/auth/login"), false);
});

test("post-login redirects stay on this site", () => {
  assert.equal(safeNextPath("/dashboard/sessions?view=past"), "/dashboard/sessions?view=past");
  assert.equal(safeNextPath("https://evil.example"), "/dashboard");
  assert.equal(safeNextPath("//evil.example"), "/dashboard");
  assert.equal(safeNextPath("/\\evil.example"), "/dashboard");
  assert.equal(safeNextPath("/\t/evil.example"), "/dashboard", "browsers strip tabs: /<TAB>/evil would become //evil");
  assert.equal(safeNextPath("/%09/evil.example"), "/%09/evil.example", "an encoded tab stays a harmless path");
  assert.equal(safeNextPath("/a\\b"), "/dashboard");
  assert.equal(safeNextPath(undefined, "/x"), "/x");
});

test("session tokens are random and stored only as a hash", () => {
  const t = randomToken();
  assert.ok(t.length >= 43);
  assert.notEqual(randomToken(), t);
  assert.match(hashToken(t), /^[0-9a-f]{64}$/);
  assert.equal(hashToken(t), hashToken(t));
});
