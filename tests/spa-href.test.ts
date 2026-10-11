// web/src/lib/href.ts: which links the SPA router handles itself (a client-side route change) and which must be a full page
// load. Every page of the app is an SPA page; what is left for the browser is other origins, the API, the built assets,
// metadata files and other schemes. `window` is faked before the module is used (it reads window.location at call time).
// Replaces tests/spa-groups.test.ts and tests/spa-groups-dev.test.ts (see doc/10-react-migration-deviations.md, D90).
import assert from "node:assert/strict";
import { before, test } from "node:test";

let isSpaHref: (href: string) => boolean;

before(async () => {
  const g = globalThis as Record<string, unknown>;
  g.window = { location: new URL("http://localhost:3000/demo") };
  ({ isSpaHref } = await import("../web/src/lib/href"));
});

test("every page of the app is a client-side navigation: public, auth, booking, dashboard and admin", () => {
  for (const href of [
    // public and booking
    "/", "/terms", "/contact", "/demo", "/demo/book?service=x", "/pay/tok", "/manage/tok", "/a/b/c", "/#how-it-works", "#main", "terms", "?x=1",
    // auth
    "/login", "/register", "/forgot-password", "/reset-password?token=x", "/verify-email?token=x",
    // dashboard and onboarding
    "/dashboard", "/dashboard/sessions", "/onboarding", "/onboarding?step=2", "/dashboard/settings#google", "/dashboard/nope",
    // admin
    "/admin", "/admin/login", "/admin/payments", "/admin/influencers/abc", "/admin/nope",
    // any other path of this origin: the router shows the Not found page
    "/anything/else/here",
  ]) {
    assert.equal(isSpaHref(href), true, href);
  }
});

test("never SPA: other origins, the API, the built assets, metadata files, other schemes", () => {
  for (const href of [
    "https://example.com/terms", "//example.com/terms", "http://localhost:3001/terms", "/api/auth/session", "/api/dashboard/earnings/export", "/assets/index-abc.js",
    "/sitemap.xml", "/robots.txt", "/icon.svg", "/opengraph-image", "/spa-shell/terms", "mailto:help@example.com", "tel:+911234567890", "javascript:void(0)",
  ]) {
    assert.equal(isSpaHref(href), false, href);
  }
  assert.equal(isSpaHref("http://localhost:3000/terms"), true, "an absolute URL on this origin is fine");
});

test("outside a browser there is no router to hand a link to", () => {
  const g = globalThis as Record<string, unknown>;
  const saved = g.window;
  try {
    delete g.window;
    assert.equal(isSpaHref("/terms"), false);
  } finally {
    g.window = saved;
  }
});
