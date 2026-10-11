// `/assets/<name>.<ext>` (the SPA's hashed build files) skips the proxy and is cached as immutable; `/assets/book` is NOT a file:
// it is the booking page of a profile whose slug is "assets" (the SPA route /:slug/book), possibly a private owner preview, so it must
// keep the proxy (CSP, nonce) and Next's normal headers and never be cached as immutable. The two rules are checked with the same
// routines Next uses to compile them (the proxy matcher and the `headers()` sources). No database.
import assert from "node:assert/strict";
import { test } from "node:test";
import nextConfig from "../next.config";
import { config } from "../proxy";

// Next's own routines for compiling a proxy matcher and a headers() source. They are internal modules without type declarations.
/* eslint-disable @typescript-eslint/no-require-imports */
const { getMiddlewareMatchers } = require("next/dist/build/analysis/get-page-static-info") as {
  getMiddlewareMatchers(matcher: unknown, nextConfig: object): { regexp: string }[];
};
const { match } = require("next/dist/compiled/path-to-regexp") as { match(source: string): (path: string) => false | object };

const regexps = getMiddlewareMatchers(config.matcher, {}).map((m) => new RegExp(m.regexp));
const proxyRuns = (path: string) => regexps.some((r) => r.test(path));

test("the proxy skips real asset files only; /assets/book and look-alikes keep the proxy", () => {
  for (const file of ["/assets/index-abc123.js", "/assets/index-TGIWFOG5.css", "/assets/inter-latin-wght-normal-Dx4kXJAl.woff2", "/assets/Landing-BTabndqr.js", "/assets/a_b-C.d.js"]) {
    assert.equal(proxyRuns(file), false, `${file} is a file: no proxy`);
  }
  for (const page of ["/assets", "/assets/", "/assets/book", "/assets/book/", "/assets/a/b.js", "/assets/.js", "/assets/x.", "/assetsx/book", "/terms", "/", "/demo/book", "/api/health", "/spa-shell/x"]) {
    assert.equal(proxyRuns(page), true, `${page} must go through the proxy`);
  }
  // The pre-existing exclusions are unchanged.
  for (const p of ["/_next/static/chunks/a.js", "/_next/image", "/favicon.ico", "/icon.svg", "/robots.txt", "/sitemap.xml", "/opengraph-image"]) assert.equal(proxyRuns(p), false, p);
});

test("the immutable Cache-Control applies to asset files only, never to /assets/book", async () => {
  const rules = await nextConfig.headers!();
  const immutable = rules.filter((r) => r.headers.some((h) => h.key === "Cache-Control" && /immutable/.test(h.value)));
  assert.equal(immutable.length, 1);
  const applies = (path: string) => rules.some((r) => r.headers.some((h) => /immutable/.test(h.value)) && match(r.source)(path) !== false);
  for (const file of ["/assets/index-abc123.js", "/assets/index-TGIWFOG5.css", "/assets/inter-latin-wght-normal-Dx4kXJAl.woff2"]) assert.equal(applies(file), true, file);
  for (const page of ["/assets", "/assets/", "/assets/book", "/assets/book/", "/assets/a/b.js", "/assets/.js", "/terms", "/demo/book"]) assert.equal(applies(page), false, page);
  // The security headers still apply to everything, assets included.
  const security = rules.find((r) => r.source === "/:path*");
  assert.ok(security && security.headers.some((h) => h.key === "X-Content-Type-Options"));
});
