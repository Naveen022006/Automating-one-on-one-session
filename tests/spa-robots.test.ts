// QA-7: robots.txt must follow the RUNTIME value of APP_URL. The route used to be statically generated at build time, so an image built
// without APP_URL (the Dockerfile sets none) served `Sitemap: http://localhost:3000/sitemap.xml` in production. No database needed.
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import robots, { dynamic } from "../app/robots";

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

test("the SPA can still render a profile page: its API stays allowed, private areas stay disallowed", () => {
  const rules = robots().rules;
  const rule = (Array.isArray(rules) ? rules[0] : rules) as { allow?: string[]; disallow?: string[] };
  assert.ok(rule.allow?.includes("/api/public/"));
  for (const p of ["/api/", "/dashboard", "/admin", "/onboarding", "/manage/", "/pay/"]) assert.ok(rule.disallow?.includes(p), p);
  assert.ok(!rule.disallow?.some((p) => p.startsWith("/assets")), "crawlers need the JS and CSS to render the SPA");
});
