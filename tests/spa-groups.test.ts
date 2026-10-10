// web/src/lib/groups.ts in a MIXED deployment: the shell says `<meta name="spa-groups" content="public,booking">`, so a link
// to a page of a group that is still served by Next must be a full page load, not a client-side route change. The browser
// globals are faked before the module loads (it reads the meta tag once, at import).
import assert from "node:assert/strict";
import { before, test } from "node:test";

let isSpaHref: (href: string) => boolean;
let enabledGroups: ReadonlySet<string>;

before(async () => {
  const g = globalThis as Record<string, unknown>;
  g.window = { location: new URL("http://localhost:3000/demo") };
  g.document = { querySelector: (sel: string) => (sel === 'meta[name="spa-groups"]' ? { getAttribute: () => "public,booking" } : null) };
  ({ isSpaHref, enabledGroups } = await import("../web/src/lib/groups"));
});

test("the groups come from the shell's meta tag", () => {
  assert.deepEqual([...enabledGroups].sort(), ["booking", "public"]);
});

test("pages of enabled groups are client-side navigations, everything else is a full page load", () => {
  for (const href of ["/", "/terms", "/contact", "/demo", "/demo/book?service=x", "/pay/tok", "/manage/tok", "/a/b/c", "/#how-it-works", "#main", "terms", "?x=1"]) {
    assert.equal(isSpaHref(href), true, href);
  }
  // auth, dashboard and admin are not enabled: their links must reach the old Next pages with a real navigation.
  for (const href of ["/login", "/register", "/forgot-password", "/dashboard", "/dashboard/sessions", "/onboarding", "/admin", "/admin/login", "/admin/nope", "/dashboard/nope"]) {
    assert.equal(isSpaHref(href), false, href);
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
