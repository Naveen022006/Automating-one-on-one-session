// proxy.ts, the SPA switch (doc/10-react-migration-plan.md, section 1.7): which pages are rewritten to the internal shell route,
// that the CSP/nonce and the server-side guards are untouched, that the shell route cannot be requested directly, and that
// GET /api/* keeps the rolling session cookie alive. No database: the rate limiter uses its in-memory store.
// SPA_GROUPS is read when proxy.ts is first loaded, so this file fixes it to "public,booking"; the empty setting is
// tests/spa-proxy-empty.test.ts (a separate file, because node:test gives every file its own process).
import assert from "node:assert/strict";
import { before, test } from "node:test";
import { NextRequest } from "next/server";

let proxy: (req: NextRequest) => Promise<Response>;
const SESSION = "A".repeat(43);

before(async () => {
  process.env.RATE_LIMIT_STORE = "memory";
  process.env.SPA_GROUPS = "public,booking";
  proxy = (await import("../proxy")).proxy;
});

const req = (path: string, init: { method?: string; headers?: Record<string, string> } = {}) =>
  new NextRequest(`http://localhost:3000${path}`, { method: init.method ?? "GET", headers: init.headers });

const isRewriteTo = (res: Response, path: string) => (res.headers.get("x-middleware-rewrite") ?? "").endsWith(path);
const isPassThrough = (res: Response) => res.headers.get("x-middleware-next") === "1" && !res.headers.get("x-middleware-rewrite");
const nonceOf = (csp: string | null) => /'nonce-([^']+)'/.exec(csp ?? "")?.[1];

test("an enabled group is rewritten to the internal shell route, with the request's own nonce in the CSP and the request headers", async () => {
  for (const [path, target] of [["/terms", "/spa-shell/terms"], ["/", "/spa-shell"], ["/demo", "/spa-shell/demo"], ["/demo/book", "/spa-shell/demo/book"], ["/pay/abc", "/spa-shell/pay/abc"], ["/no/such/page", "/spa-shell/no/such/page"]]) {
    const res = await proxy(req(path));
    assert.ok(isRewriteTo(res, target), `${path} -> ${res.headers.get("x-middleware-rewrite")}`);
    const csp = res.headers.get("content-security-policy");
    const nonce = nonceOf(csp);
    assert.ok(nonce && nonce.length >= 24, "a nonce in the CSP");
    assert.match(csp ?? "", /script-src 'self' 'nonce-[^']+' 'strict-dynamic'/);
    // The shell route receives the SAME nonce through the (overridden) request headers.
    assert.equal(res.headers.get("x-middleware-request-x-nonce"), nonce, path);
    assert.equal(res.headers.get("x-middleware-request-content-security-policy"), csp);
  }
  // Two requests never share a nonce.
  const a = nonceOf((await proxy(req("/terms"))).headers.get("content-security-policy"));
  const b = nonceOf((await proxy(req("/terms"))).headers.get("content-security-policy"));
  assert.notEqual(a, b);
});

test("a client cannot choose the nonce or the pathname: both request headers are overwritten", async () => {
  const res = await proxy(req("/terms", { headers: { "x-nonce": "attacker-nonce", "x-pathname": "/admin", "content-security-policy": "default-src *" } }));
  const nonce = nonceOf(res.headers.get("content-security-policy"));
  assert.notEqual(res.headers.get("x-middleware-request-x-nonce"), "attacker-nonce");
  assert.equal(res.headers.get("x-middleware-request-x-nonce"), nonce);
  assert.equal(res.headers.get("x-middleware-request-x-pathname"), "/terms");
  assert.equal(res.headers.get("x-middleware-request-content-security-policy"), res.headers.get("content-security-policy"));
});

test("groups that are not enabled stay on the old Next pages", async () => {
  for (const path of ["/login", "/register", "/forgot-password", "/dashboard/sessions", "/admin/login", "/onboarding"]) {
    const res = await proxy(req(path, { headers: { cookie: `sa_session=${SESSION}; sa_admin=${SESSION}` } }));
    assert.ok(isPassThrough(res), `${path}: ${res.headers.get("x-middleware-rewrite") ?? res.status}`);
    assert.ok(res.headers.get("content-security-policy"), `${path}: still gets the per-request CSP`);
    assert.ok(res.headers.get("x-middleware-request-x-nonce"), `${path}: and the nonce header the Next layout reads`);
  }
  assert.ok(isPassThrough(await proxy(req("/admin/nope", { headers: { cookie: `sa_admin=${SESSION}` } }))), "the admin 404 belongs to the admin group");
});

test("only GET and HEAD are rewritten: a POST to a page URL is not a page view", async () => {
  assert.ok(isRewriteTo(await proxy(req("/terms", { method: "HEAD" })), "/spa-shell/terms"));
  for (const method of ["POST", "PUT", "PATCH", "DELETE"]) assert.ok(isPassThrough(await proxy(req("/terms", { method }))), method);
});

test("the shell route is not a public URL: /spa-shell... answers 404 before anything else, whatever headers come with it", async () => {
  for (const path of ["/spa-shell", "/spa-shell/terms", "/spa-shell/a/b"]) {
    const res = await proxy(req(path, { headers: { "x-nonce": "forged", cookie: `sa_session=${SESSION}` } }));
    assert.equal(res.status, 404, path);
    assert.equal(res.headers.get("x-middleware-rewrite"), null);
  }
});

test("the redirects that stay on the server still run first, whichever groups are enabled", async () => {
  const dash = await proxy(req("/dashboard/sessions?view=past"));
  assert.equal(dash.status, 307);
  assert.equal(new URL(dash.headers.get("location")!).pathname + new URL(dash.headers.get("location")!).search, "/login?next=%2Fdashboard%2Fsessions%3Fview%3Dpast");
  const onboarding = await proxy(req("/onboarding"));
  assert.equal(onboarding.status, 307);
  const admin = await proxy(req("/admin/payments?view=mismatch"));
  assert.equal(admin.status, 307);
  assert.equal(new URL(admin.headers.get("location")!).pathname, "/admin/login");
  assert.equal(new URL(admin.headers.get("location")!).search, "?next=%2Fadmin%2Fpayments%3Fview%3Dmismatch");
  // With the cookie present the proxy lets the request through (the page validates the session against the database).
  assert.ok(isPassThrough(await proxy(req("/dashboard", { headers: { cookie: `sa_session=${SESSION}` } }))));
});

test("token pages get Referrer-Policy: no-referrer from the proxy; other shell pages do not", async () => {
  assert.equal((await proxy(req("/manage/tok"))).headers.get("referrer-policy"), "no-referrer");
  assert.equal((await proxy(req("/terms"))).headers.get("referrer-policy"), null);
  assert.equal((await proxy(req("/pay/tok"))).headers.get("referrer-policy"), null, "pay carries no secret in a way that needs it (plan 3)");
});

test("the rolling session cookie is refreshed on a page visit AND on GET /api/*, but not on writes or webhooks", async () => {
  const refreshed = async (path: string, method = "GET", cookie = `sa_session=${SESSION}`, extra: Record<string, string> = {}) => {
    const res = await proxy(req(path, { method, headers: { cookie, origin: "http://localhost:3000", ...extra } }));
    return res.headers.getSetCookie().find((c) => c.startsWith("sa_session="));
  };
  const page = await refreshed("/terms");
  assert.ok(page, "a page visit refreshes the cookie (unchanged behaviour)");
  const api = await refreshed("/api/auth/session");
  assert.ok(api, "so does GET /api/auth/session");
  for (const set of [page!, api!]) {
    assert.ok(set.startsWith(`sa_session=${SESSION};`), "the value is unchanged");
    assert.match(set, /Max-Age=2592000/i);
    assert.match(set, /HttpOnly/i);
    assert.match(set, /SameSite=lax/i);
    assert.match(set, /Path=\//i);
  }
  assert.ok(await refreshed("/api/dashboard/shell"), "any API GET a signed-in tab makes");
  assert.equal(await refreshed("/api/auth/session", "GET", ""), undefined, "no cookie, nothing to refresh");
  assert.equal(await refreshed("/api/auth/logout", "POST"), undefined, "writes do not refresh it");
  assert.equal(await refreshed("/api/webhooks/payment", "GET"), undefined, "webhooks are server to server");
  // The secure, host-bound cookie name used in production keeps its flags.
  const secure = (await proxy(req("/api/auth/session", { headers: { cookie: `__Host-sa_session=${SESSION}` } }))).headers.getSetCookie().find((c) => c.startsWith("__Host-sa_session="));
  assert.ok(secure && /Secure/i.test(secure) && /Path=\//i.test(secure) && !/Domain=/i.test(secure));
  // A refused request (429) is not a reason to touch the cookie, and the admin cookie is never refreshed (absolute 12 h).
  const adminOnly = await proxy(req("/api/admin/session", { headers: { cookie: `sa_admin=${SESSION}` } }));
  assert.equal(adminOnly.headers.getSetCookie().length, 0);
});

test("API behaviour is otherwise unchanged: CSRF Origin check, rate-limit headers, and the new rule for the session check", async () => {
  const foreign = await proxy(req("/api/auth/logout", { method: "POST", headers: { origin: "https://evil.example" } }));
  assert.equal(foreign.status, 403);
  const own = await proxy(req("/api/auth/session", { headers: { "x-forwarded-for": "198.51.100.77" } }));
  assert.equal(own.headers.get("ratelimit-limit"), "120", "the auth-session rule (120 per minute), not auth-other");
  assert.ok(own.headers.get("ratelimit-remaining"));
  assert.ok(isPassThrough(own));
});
