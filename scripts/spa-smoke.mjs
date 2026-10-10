#!/usr/bin/env node
/**
 * HTTP smoke test of a running server (doc/10-react-migration-plan.md, section 7.3). Dependency-free (Node 22 `fetch`),
 * needs no cookies, no login and no test data, so it is safe to point at a staging deployment and to run in CI.
 *
 *   node scripts/spa-smoke.mjs http://127.0.0.1:3001 [--no-db] [--old] [--verbose]
 *
 * Default mode expects the server to run with SPA_GROUPS=all: one sample URL per route class must return the SPA shell with
 * the right status, robots and Referrer-Policy, and the CSP nonce in the header must equal EVERY nonce in the HTML (a mismatch
 * is a blank page under the strict CSP). It also checks the security headers, the immutable asset caching, the internal
 * shell route, the two session endpoints, the CSRF Origin check, and that no body leaks a stack trace or a connection string.
 *
 *   --no-db    the server has no database (the docker CI job): profile routes may answer 503 and the profile API is skipped
 *   --old      the server runs with SPA_GROUPS empty: checks that the OLD Next pages are served (no shell) and that the same
 *              guards, headers and endpoints behave as before
 *   --verbose  print a line for every passing check too (by default only failures, skips and the summary)
 *
 * Exit code 1 if any check fails.
 */

const args = process.argv.slice(2);
const base = (args.find((a) => !a.startsWith("--")) ?? "").replace(/\/$/, "");
const NO_DB = args.includes("--no-db");
const OLD = args.includes("--old");
const VERBOSE = args.includes("--verbose");
if (!base) {
  console.error("usage: node scripts/spa-smoke.mjs <base-url> [--no-db] [--old] [--verbose]");
  process.exit(2);
}

let failures = 0;
let passes = 0;
function check(name, ok, detail = "") {
  if (ok) {
    passes++;
    if (VERBOSE) console.log(`PASS  ${name}`);
  } else {
    failures++;
    console.log(`FAIL  ${name}${detail ? `\n        ${detail}` : ""}`);
  }
}
const skip = (name, why) => console.log(`SKIP  ${name} (${why})`);

async function get(path, init = {}) {
  const res = await fetch(base + path, { redirect: "manual", ...init });
  const body = init.method === "HEAD" ? "" : await res.text();
  return { status: res.status, headers: res.headers, body };
}

/** The nonce in a Content-Security-Policy header value, or null. */
const cspNonce = (csp) => /'nonce-([A-Za-z0-9+/=_-]+)'/.exec(csp ?? "")?.[1] ?? null;
const header = (r, name) => r.headers.get(name) ?? "";
const LEAKS = [/postgres(ql)?:\/\//i, /rediss?:\/\//i, /ECONNREFUSED/, /\n\s+at\s+\S+\s+\(.*:\d+:\d+\)/, /node_modules[\\/]/];
function noLeaks(name, body) {
  const hit = LEAKS.find((re) => re.test(body));
  check(`${name}: no stack trace or connection string in the body`, !hit, hit ? String(hit) : "");
}

/** One sample URL per route class. `status` is the exact expectation unless it is a list. */
const SAMPLES = [
  { path: "/", status: [200], robots: null, tag: "landing" },
  { path: "/terms", status: [200], robots: null },
  { path: "/register", status: [200], robots: null },
  { path: "/login", status: [200], robots: "noindex" },
  { path: "/reset-password?token=x", status: [200], robots: "noindex", noReferrer: true },
  { path: "/demo", status: NO_DB ? [503] : [200, 404], db: true },
  { path: "/demo/book", status: NO_DB ? [503] : [200, 404], db: true },
  { path: "/no-such-slug-xyz", status: NO_DB ? [503] : [404], db: true, robots: "noindex" },
  { path: "/pay/bad", status: [200], robots: "noindex, nofollow" },
  { path: "/manage/bad", status: [200], robots: "noindex", noReferrer: true },
  { path: "/a/b/c", status: [404], robots: "noindex" },
  { path: "/admin/login", status: [200], robots: "noindex, nofollow" },
];

function checkSecurityHeaders(name, r, { noReferrer = false } = {}) {
  check(`${name}: x-content-type-options nosniff`, header(r, "x-content-type-options") === "nosniff");
  check(`${name}: x-frame-options DENY`, header(r, "x-frame-options") === "DENY");
  check(`${name}: permissions-policy present`, header(r, "permissions-policy") !== "");
  check(
    `${name}: referrer-policy ${noReferrer ? "no-referrer" : "set"}`,
    noReferrer ? header(r, "referrer-policy") === "no-referrer" : header(r, "referrer-policy") !== "",
    header(r, "referrer-policy"),
  );
}

async function shellSample(s) {
  const r = await get(s.path);
  const name = s.path;
  check(`${name}: status ${s.status.join(" or ")}`, s.status.includes(r.status), String(r.status));
  check(`${name}: content-type text/html`, header(r, "content-type").startsWith("text/html"), header(r, "content-type"));
  if (OLD) {
    check(`${name}: the OLD Next page is served (no SPA shell)`, !r.body.includes('<div id="root">'));
  } else {
    check(`${name}: SPA shell (<div id="root">)`, r.body.includes('<div id="root">'));
    const csp = header(r, "content-security-policy");
    const headerNonce = cspNonce(csp);
    check(`${name}: CSP header carries a nonce`, Boolean(headerNonce));
    const bodyNonces = [...r.body.matchAll(/\bnonce="([^"]*)"/g)].map((m) => m[1]);
    check(`${name}: at least three nonce'd tags in the HTML`, bodyNonces.length >= 3, String(bodyNonces.length));
    check(`${name}: every nonce in the HTML equals the CSP header's`, bodyNonces.length > 0 && bodyNonces.every((n) => n === headerNonce));
    check(`${name}: no placeholder left in the HTML`, !r.body.includes("__CSP_NONCE__") && !r.body.includes("<!--spa-head-->") && !r.body.includes("<!--spa-support-->"));
    check(`${name}: cache-control no-store`, /no-store/.test(header(r, "cache-control")), header(r, "cache-control"));
    check(`${name}: spa-groups meta present`, /<meta name="spa-groups" content="[a-z,]+">/.test(r.body));
    const meta = /<meta name="robots" content="([^"]*)">/.exec(r.body)?.[1] ?? null;
    if (s.robots) {
      check(`${name}: robots meta ${s.robots}`, meta === s.robots, String(meta));
      check(`${name}: x-robots-tag ${s.robots}`, header(r, "x-robots-tag") === s.robots, header(r, "x-robots-tag"));
    } else if (r.status === 200) {
      check(`${name}: indexable (no robots meta, no x-robots-tag)`, meta === null && header(r, "x-robots-tag") === "");
    }
    if (s.tag === "landing") {
      check(`/: canonical link`, /<link rel="canonical" href="[^"]+\/">/.test(r.body));
      check(`/: Open Graph title, description and image`, ["og:title", "og:description", "og:image"].every((p) => r.body.includes(`property="${p}"`)));
      check(`/: Twitter card`, r.body.includes('name="twitter:card" content="summary_large_image"'));
      check(`/: Organization JSON-LD`, /<script type="application\/ld\+json"[^>]*>\{"@context":"https:\/\/schema\.org","@type":"Organization"/.test(r.body));
    }
    if (s.path === "/no-such-slug-xyz" && r.status === 404) check(`${name}: a real 404 status, not a soft 404`, r.status === 404);
  }
  checkSecurityHeaders(name, r, { noReferrer: s.noReferrer && !OLD });
  noLeaks(name, r.body);
  return r;
}

async function main() {
  console.log(`Smoke test of ${base}${NO_DB ? " (no database)" : ""}${OLD ? " (SPA_GROUPS empty: old pages expected)" : ""}`);

  // --- pages
  let shellBody = "";
  for (const s of SAMPLES) {
    if (OLD && s.path.startsWith("/admin/login")) {
      // the old admin login page is a Next page too; same generic checks
    }
    const r = await shellSample(s);
    if (s.path === "/") shellBody = r.body;
  }

  // --- the guards that stay on the server
  for (const [path, login] of [["/dashboard", "/login?next=%2Fdashboard"], ["/admin", "/admin/login?next=%2Fadmin"]]) {
    const r = await get(path);
    check(`${path} without cookies redirects to the login page`, r.status === 307 && header(r, "location").endsWith(login), `${r.status} ${header(r, "location")}`);
  }

  // --- the internal shell route is not a public URL
  for (const path of ["/spa-shell/x", "/spa-shell"]) {
    const r = await get(path);
    check(`${path} answers 404 and is not the shell`, r.status === 404 && !r.body.includes('<div id="root">'), String(r.status));
  }
  const forged = await get("/spa-shell/terms", { headers: { "x-nonce": "AAAAAAAAAAAAAAAAAAAAAAAA" } });
  check("/spa-shell/terms with a forged x-nonce header is still 404", forged.status === 404 && !forged.body.includes('<div id="root">'), String(forged.status));

  // --- built assets
  if (!OLD) {
    const asset = /(?:src|href)="(\/assets\/[^"]+\.js)"/.exec(shellBody)?.[1];
    check("the shell references a hashed script under /assets", Boolean(asset));
    if (asset) {
      const r = await get(asset);
      check(`${asset}: 200`, r.status === 200, String(r.status));
      check(`${asset}: cache-control immutable`, /immutable/.test(header(r, "cache-control")), header(r, "cache-control"));
      check(`${asset}: a JavaScript content type`, /javascript/.test(header(r, "content-type")), header(r, "content-type"));
    }
    const missing = await get("/assets/does-not-exist-0123.js");
    check("a missing /assets file is a 404, never the shell", missing.status === 404 && !missing.body.includes('<div id="root">'), String(missing.status));
  }

  // --- API
  for (const [path, name] of [["/api/auth/session", "influencer"], ["/api/admin/session", "admin"]]) {
    const r = await get(path);
    let body = null;
    try {
      body = JSON.parse(r.body);
    } catch {
      /* reported below */
    }
    check(`GET ${path}: ${name} session check answers { authenticated: false }`, r.status === 200 && body !== null && body.authenticated === false && Object.keys(body).length === 1, `${r.status} ${r.body.slice(0, 80)}`);
    check(`GET ${path}: private, no-store and no CORS header`, /private/.test(header(r, "cache-control")) && /no-store/.test(header(r, "cache-control")) && header(r, "access-control-allow-origin") === "", header(r, "cache-control"));
  }
  const csrf = await get("/api/auth/logout", { method: "POST", headers: { Origin: "https://evil.example" } });
  check("POST /api/auth/logout from a foreign Origin is refused (403)", csrf.status === 403, String(csrf.status));
  const health = await get("/api/health");
  check("GET /api/health is ok", health.status === 200 && /"ok":true/.test(health.body), String(health.status));
  const robots = await get("/robots.txt");
  check("robots.txt allows /api/public/ (profile content is loaded from there) and does not block /assets", robots.status === 200 && /Allow: \/api\/public\//.test(robots.body) && !/Disallow: \/assets/.test(robots.body));

  if (NO_DB) skip("GET /api/public/profiles/demo", "--no-db");
  else {
    const r = await get("/api/public/profiles/demo");
    if ((header(r, "content-type") || "").includes("json")) {
      const body = JSON.parse(r.body);
      if (r.status === 200) {
        check("GET /api/public/profiles/demo: profile shape", typeof body.slug === "string" && typeof body.name === "string" && Array.isArray(body.services));
        check("GET /api/public/profiles/demo: no secret-looking keys", !/"[A-Za-z]*(hash|secret|password|token)[A-Za-z]*"\s*:/i.test(r.body));
      } else {
        check("GET /api/public/profiles/demo: a JSON error object", r.status === 404 && typeof body.error === "string", String(r.status));
      }
    } else {
      skip("GET /api/public/profiles/demo", "endpoint not built yet (booking branch)");
    }
  }

  console.log(`\n${passes} passed, ${failures} failed`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(`FAIL  smoke test could not run: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
