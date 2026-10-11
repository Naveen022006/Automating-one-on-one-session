// The internal shell route handler (app/spa-shell/[[...path]]/route.ts) end to end, without a database: the profile-free route
// classes only (the profile lookup is covered by the injected-loader tests in spa-shell.test.ts and by the smoke script).
// The template is a fixture in a temporary working directory, because the route reads web/dist/index.html from process.cwd()
// at run time exactly as in production.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { NextRequest } from "next/server";

const NONCE = "MDhhY2FjMzUtZDdiOC00MTUzLTg4YzMtMWJkMGMxN2EwMDc2";
const TEMPLATE = `<!doctype html><html lang="en"><head><meta charset="utf-8" /><!--spa-head-->
<meta property="csp-nonce" nonce="__CSP_NONCE__"><script type="module" src="/assets/index-1.js" nonce="__CSP_NONCE__"></script></head>
<body><div id="root"></div><noscript>JS.<!--spa-support--></noscript></body></html>`;

let GET: (req: NextRequest) => Promise<Response>;
let HEAD: (req: NextRequest) => Promise<Response>;
let resetCache: () => void;
let dir = "";
let previousCwd = "";

before(async () => {
  previousCwd = process.cwd();
  dir = mkdtempSync(path.join(os.tmpdir(), "spa-shell-route-"));
  mkdirSync(path.join(dir, "web", "dist"), { recursive: true });
  writeFileSync(path.join(dir, "web", "dist", "index.html"), TEMPLATE);
  process.chdir(dir);
  delete process.env.ENABLE_DESIGN_PAGE;
  const route = await import("../app/spa-shell/[[...path]]/route");
  GET = route.GET;
  HEAD = route.HEAD;
  resetCache = (await import("../lib/spa/shell")).resetShellTemplateCache;
  resetCache();
});

after(() => {
  process.chdir(previousCwd);
  rmSync(dir, { recursive: true, force: true });
});

/** What proxy.ts sends: the original path as `/spa-shell<path>` and the nonce in x-nonce. */
const call = (path: string, headers: Record<string, string> = { "x-nonce": NONCE }, fn = GET) =>
  fn(new NextRequest(`http://localhost:3000/spa-shell${path === "/" ? "" : path}`, { headers }));

test("without the proxy's x-nonce header the route is a plain 404 (it is not a public URL)", async () => {
  const res = await call("/terms", {});
  assert.equal(res.status, 404);
  assert.ok(!(await res.text()).includes('id="root"'));
});

test("a static page: 200 HTML, the request's nonce in every tag, head tags, no-store, no robots header for an indexable page", async () => {
  const res = await call("/terms");
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "text/html; charset=utf-8");
  assert.equal(res.headers.get("cache-control"), "no-store");
  assert.equal(res.headers.get("x-robots-tag"), null);
  const html = await res.text();
  assert.ok(html.includes("<title>Terms of Service · "));
  assert.ok(html.includes('<link rel="canonical" href="'));
  assert.equal(html.split(`nonce="${NONCE}"`).length - 1, 2, "both template tags carry the nonce");
  assert.ok(!html.includes("__CSP_NONCE__") && !html.includes("<!--spa-head-->") && !html.includes("<!--spa-support-->"));
  assert.ok(!html.includes("spa-groups"), "the shell no longer carries a page-group switch");
});

test("the landing page carries the Organization JSON-LD with the nonce", async () => {
  const html = await (await call("/")).text();
  assert.ok(html.includes(`<script type="application/ld+json" nonce="${NONCE}">{"@context":"https://schema.org","@type":"Organization"`));
  assert.ok(html.includes('property="og:image"'));
});

test("private, token and admin pages: robots header and Referrer-Policy fallback", async () => {
  const manage = await call("/manage/abc");
  assert.equal(manage.status, 200);
  assert.equal(manage.headers.get("x-robots-tag"), "noindex");
  assert.equal(manage.headers.get("referrer-policy"), "no-referrer");
  const admin = await call("/admin/login");
  assert.equal(admin.headers.get("x-robots-tag"), "noindex, nofollow");
  assert.equal(admin.headers.get("referrer-policy"), null);
  assert.equal((await call("/dashboard/sessions")).headers.get("x-robots-tag"), "noindex");
});

test("unknown URLs answer a real 404 with noindex, in the shell", async () => {
  for (const [path, title] of [["/a/b/c", "Not found · "], ["/admin/nope", "Not found · Admin"], ["/dashboard/nope", "Not found · Dashboard"]]) {
    const res = await call(path);
    assert.equal(res.status, 404, path);
    assert.ok((res.headers.get("x-robots-tag") ?? "").startsWith("noindex"), path);
    assert.ok((await res.text()).includes(`<title>${title}`), path);
  }
});

test("/design is a 404 in production unless ENABLE_DESIGN_PAGE=true, and a normal page otherwise", async () => {
  const env = process.env as Record<string, string | undefined>;
  const saved = { NODE_ENV: env.NODE_ENV, ENABLE_DESIGN_PAGE: env.ENABLE_DESIGN_PAGE };
  try {
    env.NODE_ENV = "production";
    delete env.ENABLE_DESIGN_PAGE;
    assert.equal((await call("/design")).status, 404);
    env.ENABLE_DESIGN_PAGE = "true";
    assert.equal((await call("/design")).status, 200);
    env.ENABLE_DESIGN_PAGE = "false";
    assert.equal((await call("/design")).status, 404);
    env.NODE_ENV = "development";
    delete env.ENABLE_DESIGN_PAGE;
    assert.equal((await call("/design")).status, 200);
  } finally {
    env.NODE_ENV = saved.NODE_ENV;
    if (saved.ENABLE_DESIGN_PAGE === undefined) delete env.ENABLE_DESIGN_PAGE;
    else env.ENABLE_DESIGN_PAGE = saved.ENABLE_DESIGN_PAGE;
  }
});

test("a Next client prefetch or RSC navigation (a stale tab) gets an empty 204, so Next falls back to a normal page load", async () => {
  const variants: Record<string, string>[] = [{ "x-nonce": NONCE, rsc: "1" }, { "x-nonce": NONCE, "next-router-prefetch": "1" }, { "x-nonce": NONCE, rsc: "1", "next-router-prefetch": "1" }];
  for (const headers of variants) {
    const res = await call("/terms", headers);
    assert.equal(res.status, 204);
    assert.equal(await res.text(), "");
  }
  // And the real document request, which has neither header, still gets the shell.
  assert.equal((await call("/terms")).status, 200);
});

test("HEAD answers the same status and headers with no body", async () => {
  const res = await call("/manage/abc", { "x-nonce": NONCE }, HEAD);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("x-robots-tag"), "noindex");
  assert.equal(await res.text(), "");
});

test("a missing or unusable template is a 500 with one clear log line, never a blank page with scripts that the CSP would block", async () => {
  const realError = console.error;
  const lines: string[] = [];
  console.error = (...a: unknown[]) => void lines.push(a.join(" "));
  const file = path.join(dir, "web", "dist", "index.html");
  try {
    // A template whose placeholders were lost (a build without html.cspNonce).
    writeFileSync(file, "<html><head></head><body><div id='root'></div></body></html>");
    resetCache();
    for (let i = 0; i < 3; i++) {
      const res = await call("/terms");
      assert.equal(res.status, 500);
      assert.ok(!(await res.text()).includes("root"));
    }
    assert.equal(lines.length, 1, "logged once per process, not once per request");
    assert.match(lines[0], /\[spa-shell\].*__CSP_NONCE__/);
  } finally {
    console.error = realError;
    writeFileSync(file, TEMPLATE);
    resetCache();
  }
  assert.equal((await call("/terms")).status, 200, "recovers once the file is right");
});
