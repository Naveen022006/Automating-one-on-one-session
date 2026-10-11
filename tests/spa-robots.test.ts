// QA-7 / M6: robots.txt. (1) It follows the RUNTIME value of APP_URL: the route used to be statically generated at build time, so an image
// built without APP_URL (the Dockerfile sets none) served `Sitemap: http://localhost:3000/sitemap.xml` in production. (2) Its Disallow
// rules are exact pages and folders: a prefix such as `/design` or `/admin` also hid real profiles (`/design-with-asha`,
// `/admin-academy`). No database needed.
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import robots, { dynamic } from "../app/robots";
import { ROBOTS_ALLOW, ROBOTS_DISALLOW, robotsAllows } from "../lib/robots-rules";

const saved = process.env.APP_URL;
afterEach(() => {
  if (saved === undefined) delete process.env.APP_URL;
  else process.env.APP_URL = saved;
});

test("robots.txt is rendered per request (a static one freezes the build machine's APP_URL)", () => {
  assert.equal(dynamic, "force-dynamic");
});

test("the sitemap line uses the APP_URL of the moment, without a trailing slash", () => {
  process.env.APP_URL = "https://book.example.com/";
  assert.equal(robots().sitemap, "https://book.example.com/sitemap.xml");
  process.env.APP_URL = "https://other.example.org";
  assert.equal(robots().sitemap, "https://other.example.org/sitemap.xml");
});

test("the route renders the rules of lib/robots-rules.ts", () => {
  const rules = robots().rules;
  const rule = (Array.isArray(rules) ? rules[0] : rules) as { allow?: string[]; disallow?: string[]; userAgent?: string };
  assert.deepEqual(rule.allow, ROBOTS_ALLOW);
  assert.deepEqual(rule.disallow, ROBOTS_DISALLOW);
  assert.ok(!rule.disallow?.some((p) => p.startsWith("/assets")), "crawlers need the JS and CSS to render the SPA");
});

test("private areas, token pages and the API are closed to crawlers, with and without a query string", () => {
  for (const blocked of [
    "/dashboard", "/dashboard/sessions", "/dashboard/sessions?view=past", "/dashboard?x=1",
    "/admin", "/admin/login", "/admin/influencers/abc", "/admin?next=%2Fadmin",
    "/onboarding", "/onboarding?step=2", "/onboarding/x",
    "/manage/tok", "/pay/tok",
    "/design", "/design?x=1", "/design/x",
    "/reset-password", "/reset-password?token=x", "/verify-email", "/verify-email?token=x",
    "/api/auth/session", "/api/dashboard/shell", "/api/pay/tok", "/api/slots?serviceId=x",
  ]) {
    assert.equal(robotsAllows(blocked), false, `${blocked} must be disallowed`);
  }
});

test("M6: real profiles whose slug merely STARTS with a reserved word, and the pages the SPA needs, stay crawlable", () => {
  for (const open of [
    "/design-with-asha", "/design-with-asha/book", "/admin-academy", "/admin-academy/book", "/dashboard-tips", "/onboarding-coach",
    "/reset-password-help", "/verify-email-pro", "/payments", "/pay-me", "/manage-my-time", "/designer", "/adminer",
    "/", "/terms", "/privacy", "/refund-policy", "/contact", "/register", "/demo", "/demo/book", "/demo/book?service=svc_1",
    "/api/public/profiles/demo", "/assets/index-abc.js", "/sitemap.xml", "/opengraph-image",
  ]) {
    assert.equal(robotsAllows(open), true, `${open} must stay allowed`);
  }
});

test("the matcher itself behaves like the standard (longest rule wins, `$` anchors), so the two tests above prove something", () => {
  assert.equal(robotsAllows("/a/b", ["/"], ["/a/"]), false);
  assert.equal(robotsAllows("/a", ["/"], ["/a$"]), false);
  assert.equal(robotsAllows("/ab", ["/"], ["/a$"]), true, "$ means nothing may follow");
  assert.equal(robotsAllows("/ab", ["/"], ["/a"]), false, "no $: a prefix");
  assert.equal(robotsAllows("/api/public/x", ["/api/public/"], ["/api/"]), true, "the longer Allow wins");
  assert.equal(robotsAllows("/x", [], []), true);
});
