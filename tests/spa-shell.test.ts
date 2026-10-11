// Pure tests of the SPA shell (lib/spa/head.ts and lib/spa/shell.ts): the template renderer, the head of every route
// class, and above all the escaping of influencer-controlled text that is written into the initial HTML. No database:
// the profile lookup is injected.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  escapeHtml,
  jsonLdText,
  renderHead,
  resolveHead,
  robotsDirective,
  type HeadContext,
  type ProfileHeadData,
} from "../lib/spa/head";
import { matchSpaRoute } from "../lib/spa/routes";
import {
  HEAD_PLACEHOLDER,
  NONCE_PLACEHOLDER,
  ShellTemplateError,
  loadShellTemplate,
  renderShell,
  resetShellTemplateCache,
  shellTemplateProblem,
} from "../lib/spa/shell";

/** What `vite build` writes (see web/dist/index.html), reduced to the parts the renderer cares about. */
const TEMPLATE = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <link rel="icon" href="/icon.svg" type="image/svg+xml" />
    <!--spa-head-->
    <meta property="csp-nonce" nonce="__CSP_NONCE__">
    <script type="module" crossorigin src="/assets/index-abc.js" nonce="__CSP_NONCE__"></script>
    <link rel="modulepreload" crossorigin href="/assets/chunk-abc.js" nonce="__CSP_NONCE__">
    <link rel="stylesheet" crossorigin href="/assets/index-abc.css" nonce="__CSP_NONCE__">
  </head>
  <body>
    <div id="root"></div>
    <noscript>This site needs JavaScript to work.<!--spa-support--></noscript>
  </body>
</html>
`;
const NONCE = "MDhhY2FjMzUtZDdiOC00MTUzLTg4YzMtMWJkMGMxN2EwMDc2";

const ctx = (over: Partial<HeadContext> = {}): HeadContext => ({
  appUrl: "https://app.example.com",
  brand: "Acme",
  supportEmail: "help@acme.example",
  designEnabled: false,
  loadProfile: async () => null,
  ...over,
});
const head = (path: string, c: HeadContext = ctx()) => resolveHead(matchSpaRoute(path)!, c);
const profile = (over: Partial<ProfileHeadData> = {}): ProfileHeadData => ({ slug: "priya", name: "Priya Sharma", bio: "Career coach.", preview: false, ...over });

test("renderShell: every nonce placeholder is replaced, the head is inserted, nothing is left over", () => {
  const html = renderShell(TEMPLATE, {
    nonce: NONCE,
    headHtml: "<title>T</title>",
    supportEmail: "help@acme.example",
  });
  assert.ok(!html.includes(NONCE_PLACEHOLDER) && !html.includes(HEAD_PLACEHOLDER) && !html.includes("<!--spa-support-->"));
  // The tags of the template that must run under the CSP all carry the request's nonce.
  assert.equal(html.split(`nonce="${NONCE}"`).length - 1, 4);
  for (const tag of html.match(/<(script|link)\b[^>]*>/g) ?? []) {
    if (/rel="icon"/.test(tag)) continue;
    assert.ok(tag.includes(`nonce="${NONCE}"`), tag);
  }
  assert.ok(html.includes("<title>T</title>"));
  // The shell no longer tells the browser which page groups it serves: there is only one kind of page.
  assert.ok(!html.includes("spa-groups"));
  assert.ok(html.includes("Questions: help@acme.example</noscript>"));
});

test("renderShell: the nonce differs per call and the support email is escaped", () => {
  const a = renderShell(TEMPLATE, { nonce: NONCE, headHtml: "", supportEmail: 'a"b<c>&d@x.example' });
  const b = renderShell(TEMPLATE, { nonce: "ZZZZ-other-nonce-ZZZZ", headHtml: "", supportEmail: "x@x.example" });
  assert.ok(a.includes(`nonce="${NONCE}"`) && !a.includes("ZZZZ-other"));
  assert.ok(b.includes('nonce="ZZZZ-other-nonce-ZZZZ"') && !b.includes(NONCE));
  assert.ok(a.includes("a&quot;b&lt;c&gt;&amp;d@x.example"));
  assert.ok(!a.includes('a"b<c>'));
});

test("renderShell: head text is inserted literally, replacement patterns such as $& are not interpreted", () => {
  const html = renderShell(TEMPLATE, { nonce: NONCE, headHtml: "<title>$&amp; $' $` $1</title>", supportEmail: "$&@x.example" });
  assert.ok(html.includes("<title>$&amp; $' $` $1</title>"));
  assert.ok(html.includes("Questions: $&amp;@x.example"));
});

test("renderShell refuses a template without the CSP or head placeholder, and a nonce of an unexpected shape", () => {
  const base = { nonce: NONCE, headHtml: "", supportEmail: "a@b.example" };
  assert.throws(() => renderShell(TEMPLATE.split(NONCE_PLACEHOLDER).join("fixed"), base), ShellTemplateError);
  assert.throws(() => renderShell(TEMPLATE.replace(HEAD_PLACEHOLDER, ""), base), ShellTemplateError);
  for (const bad of ["", "short", 'a"b'.repeat(10), "has space inside the nonce value", "x".repeat(300)]) {
    assert.throws(() => renderShell(TEMPLATE, { ...base, nonce: bad }), /nonce/, JSON.stringify(bad));
  }
  assert.equal(shellTemplateProblem(TEMPLATE), null);
  assert.match(shellTemplateProblem("<html></html>") ?? "", /__CSP_NONCE__/);
  assert.match(shellTemplateProblem("__CSP_NONCE__") ?? "", /spa-head/);
});

test("loadShellTemplate reads once and keeps it in production; a missing or unusable file is a clear ShellTemplateError", () => {
  resetShellTemplateCache();
  try {
    let reads = 0;
    const reader = (file: string) => {
      reads++;
      assert.ok(file.replace(/\\/g, "/").endsWith("/srv/app/web/dist/index.html"), file);
      return TEMPLATE;
    };
    assert.equal(loadShellTemplate(reader, "/srv/app", true), TEMPLATE);
    assert.equal(loadShellTemplate(reader, "/srv/app", true), TEMPLATE);
    assert.equal(reads, 1, "cached after the first read");

    resetShellTemplateCache();
    assert.throws(
      () => loadShellTemplate(() => { throw new Error("ENOENT"); }, "/srv/app"),
      (e: unknown) => e instanceof ShellTemplateError && /web\/dist\/index\.html is missing/.test(e.message),
    );
    resetShellTemplateCache();
    assert.throws(() => loadShellTemplate(() => "<html>no placeholders</html>", "/srv/app"), (e: unknown) => e instanceof ShellTemplateError && /__CSP_NONCE__/.test(e.message));
    // A failed read is not cached: once the file appears it works.
    assert.equal(loadShellTemplate(() => TEMPLATE, "/srv/app"), TEMPLATE);
  } finally {
    resetShellTemplateCache();
  }
});

test("loadShellTemplate in development reads the file again every time (npm run dev rebuilds it with new hashed file names)", () => {
  resetShellTemplateCache();
  try {
    let current = TEMPLATE;
    let reads = 0;
    const reader = () => {
      reads++;
      return current;
    };
    assert.equal(loadShellTemplate(reader, "/srv/app", false), TEMPLATE);
    current = TEMPLATE.replace("index-abc.js", "index-def.js");
    assert.ok(loadShellTemplate(reader, "/srv/app", false).includes("index-def.js"), "a rebuilt template is picked up");
    assert.equal(reads, 2);
    // The default follows NODE_ENV: kept only in production.
    const saved = process.env.NODE_ENV;
    try {
      (process.env as Record<string, string | undefined>).NODE_ENV = "production";
      assert.equal(loadShellTemplate(reader, "/srv/app"), current);
      current = TEMPLATE;
      assert.ok(loadShellTemplate(reader, "/srv/app").includes("index-def.js"), "production keeps the first read");
    } finally {
      (process.env as Record<string, string | undefined>).NODE_ENV = saved;
    }
  } finally {
    resetShellTemplateCache();
  }
});

test("head: the landing page has the absolute title, canonical, Open Graph, Twitter card and Organization JSON-LD", async () => {
  const h = await head("/");
  assert.equal(h.status, 200);
  assert.equal(h.title, "Acme: get paid for your time, send the Meet link automatically");
  assert.equal(h.canonical, "https://app.example.com/");
  assert.equal(h.robots, "index");
  assert.deepEqual(h.jsonLd, { "@context": "https://schema.org", "@type": "Organization", name: "Acme", url: "https://app.example.com", email: "help@acme.example" });
  const html = renderHead(h, "Acme", NONCE);
  assert.ok(html.includes("<title>Acme: get paid for your time, send the Meet link automatically</title>"));
  assert.ok(html.includes('<link rel="canonical" href="https://app.example.com/">'));
  assert.ok(html.includes('property="og:image" content="https://app.example.com/opengraph-image"'));
  assert.ok(html.includes('property="og:image:width" content="1200"') && html.includes('property="og:image:height" content="630"'));
  assert.ok(html.includes('name="twitter:card" content="summary_large_image"'));
  assert.ok(html.includes('property="og:type" content="website"') && html.includes('property="og:site_name" content="Acme"'));
  assert.ok(html.includes(`<script type="application/ld+json" nonce="${NONCE}">`));
  assert.ok(!html.includes('name="robots"'), "an indexable page carries no robots meta");
});

test("head: legal pages and register are indexable with their own canonical and description", async () => {
  const terms = await head("/terms");
  assert.equal(terms.title, "Terms of Service · Acme");
  assert.equal(terms.canonical, "https://app.example.com/terms");
  assert.equal(terms.robots, "index");
  assert.ok(terms.share);
  assert.equal((await head("/privacy")).title, "Privacy Policy · Acme");
  assert.equal((await head("/refund-policy")).title, "Refund and Cancellation Policy · Acme");
  assert.equal((await head("/contact")).canonical, "https://app.example.com/contact");
  const register = await head("/register");
  assert.equal(register.title, "Create your account · Acme");
  assert.equal(register.description, "Create a booking page for your paid 1:1 and group sessions.");
  assert.equal(register.robots, "index");
});

test("head: private screens are noindex without a share card; token screens also send no Referer; admin is noindex,nofollow", async () => {
  for (const path of ["/login", "/forgot-password", "/dashboard", "/dashboard/sessions", "/onboarding"]) {
    const h = await head(path);
    assert.equal(h.robots, "noindex", path);
    assert.equal(h.share, undefined, path);
    assert.equal(h.noReferrer, false, path);
    assert.equal(h.status, 200, path);
  }
  for (const path of ["/manage/tok", "/verify-email", "/reset-password"]) {
    const h = await head(path);
    assert.equal(h.robots, "noindex", path);
    assert.equal(h.noReferrer, true, path);
    assert.ok(renderHead(h, "Acme", NONCE).includes('<meta name="referrer" content="no-referrer">'));
  }
  assert.equal((await head("/pay/tok")).robots, "noindex,nofollow");
  assert.equal((await head("/admin")).robots, "noindex,nofollow");
  assert.equal((await head("/admin/login")).title, "Admin sign in · Acme");
  assert.equal((await head("/admin/payments")).title, "Payments · Admin");
  assert.equal((await head("/dashboard/earnings")).title, "Earnings · Dashboard");
  assert.equal(robotsDirective("index"), null);
  assert.equal(robotsDirective("noindex"), "noindex");
  assert.equal(robotsDirective("noindex,nofollow"), "noindex, nofollow");
  assert.ok(renderHead(await head("/admin"), "Acme", NONCE).includes('<meta name="robots" content="noindex, nofollow">'));
});

test("head: unknown URLs are real 404s, with the title template of their area", async () => {
  const unknown = await head("/a/b/c");
  assert.equal(unknown.status, 404);
  assert.equal(unknown.title, "Not found · Acme");
  assert.equal(unknown.robots, "noindex");
  assert.equal((await head("/admin/nope")).status, 404);
  assert.equal((await head("/admin/nope")).title, "Not found · Admin");
  assert.equal((await head("/admin/nope")).robots, "noindex,nofollow");
  assert.equal((await head("/dashboard/nope")).title, "Not found · Dashboard");
});

test("head: /design is a 404 unless the design page is enabled", async () => {
  const off = await head("/design", ctx({ designEnabled: false }));
  assert.equal(off.status, 404);
  assert.equal(off.title, "Not found · Acme");
  const on = await head("/design", ctx({ designEnabled: true }));
  assert.equal(on.status, 200);
  assert.equal(on.title, "Design system · Acme");
  assert.equal(on.robots, "noindex");
});

test("head: profile pages use the profile's data", async () => {
  const seen: string[] = [];
  const c = ctx({ loadProfile: async (slug) => (seen.push(slug), slug === "priya" ? profile({ bio: "x".repeat(300) }) : null) });
  const live = await head("/priya", c);
  assert.equal(live.status, 200);
  assert.equal(live.title, "Book a session with Priya Sharma · Acme");
  assert.equal(live.description, "x".repeat(160), "the bio is cut to 160 characters");
  assert.equal(live.canonical, "https://app.example.com/priya");
  assert.equal(live.robots, "index");
  assert.ok(live.share && live.share.title === live.title);

  const book = await head("/priya/book", c);
  assert.equal(book.title, "Book Priya Sharma · Acme");
  assert.equal(book.canonical, "https://app.example.com/priya/book");

  const noBio = await head("/priya", ctx({ loadProfile: async () => profile({ bio: null }) }));
  assert.equal(noBio.description, "Book a paid 1:1 or group session with Priya Sharma.");

  const gone = await head("/nobody", c);
  assert.equal(gone.status, 404);
  assert.equal(gone.title, "Not found · Acme");
  assert.equal(gone.robots, "noindex");
  assert.deepEqual(seen, ["priya", "priya", "nobody"]);
});

test("head: the owner's preview of a page that is not live yet is noindex and has no share card", async () => {
  const h = await head("/priya", ctx({ loadProfile: async () => profile({ preview: true }) }));
  assert.equal(h.status, 200);
  assert.equal(h.robots, "noindex");
  assert.equal(h.share, undefined);
  assert.ok(renderHead(h, "Acme", NONCE).includes('<meta name="robots" content="noindex">'));
});

test("head: a failing profile lookup is a 503 with Retry-After and noindex, never a 404 that crawlers would remember", async () => {
  const h = await head("/priya", ctx({ loadProfile: async () => { throw new Error("connection refused (secret-host:5432)"); } }));
  assert.equal(h.status, 503);
  assert.equal(h.retryAfterSec, 30);
  assert.equal(h.robots, "noindex");
  const html = renderHead(h, "Acme", NONCE);
  assert.ok(!html.includes("secret-host"), "the error text never reaches the page");
  assert.ok(!html.includes("connection refused"));
});

test("escaping: an influencer's name and bio cannot break out of the title, the attributes or the page", async () => {
  const evilName = `"><script>alert(1)</script>`;
  const evilBio = `</title><script>alert(2)</script><meta name="x" content="`;
  const c = ctx({ loadProfile: async () => profile({ name: evilName, bio: evilBio }) });
  for (const path of ["/priya", "/priya/book"]) {
    const h = await head(path, c);
    const headHtml = renderHead(h, "Acme", NONCE);
    const page = renderShell(TEMPLATE, { nonce: NONCE, headHtml, supportEmail: "a@b.example" });
    for (const out of [headHtml, page]) {
      assert.ok(!out.includes("<script>alert"), `${path}: a raw <script> from the name/bio`);
      assert.ok(!out.includes('"><script'), `${path}: attribute break-out`);
      assert.ok(!out.includes("</title><script"), `${path}: title break-out`);
      assert.ok(!out.includes('<meta name="x"'), `${path}: injected meta tag`);
      assert.equal(out.split("</title>").length - 1, 1, `${path}: exactly one real </title>`);
      assert.equal(out.split("<title>").length - 1, 1, `${path}: exactly one <title>`);
    }
    assert.ok(headHtml.includes("&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;"), `${path}: the name is shown, escaped`);
    // Every attribute value written by renderHead is quoted and contains no raw quote or angle bracket.
    for (const m of headHtml.matchAll(/(?:content|href)="([^"]*)"/g)) {
      assert.ok(!/[<>]/.test(m[1]), `${path}: raw angle bracket inside an attribute value: ${m[1].slice(0, 60)}`);
    }
  }
  assert.equal(escapeHtml(`&<>"'`), "&amp;&lt;&gt;&quot;&#39;");
});

test("escaping: JSON-LD cannot close its script block; the data survives a round trip", async () => {
  const evilBrand = `</script><script>alert(3)</script><!--`;
  const h = await head("/", ctx({ brand: evilBrand, supportEmail: `x"@</script>.example` }));
  const html = renderHead(h, evilBrand, NONCE);
  assert.equal(html.split("</script>").length - 1, 1, "only the JSON-LD block's own closing tag");
  assert.ok(html.includes("\\u003c/script>"));
  const ld = />(\{[^\n]*\})<\/script>/.exec(html)![1];
  assert.equal(JSON.parse(ld).name, evilBrand);
  assert.equal(JSON.parse(ld).email, `x"@</script>.example`);
  assert.ok(!html.includes("<script>alert"));
  assert.equal(jsonLdText({ a: "<b>&" }), '{"a":"\\u003cb>&"}');
  const page = renderShell(TEMPLATE, { nonce: NONCE, headHtml: html, supportEmail: "a@b.example" });
  assert.ok(!page.includes("<script>alert"));
});
