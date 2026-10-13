// Pure tests of the SPA route table (lib/spa/routes.ts): which URL is which page, and what the title is. The proxy, the
// shell head and the web router all read this table, so these tests are the contract.
import assert from "node:assert/strict";
import { test } from "node:test";
import { RESERVED_SLUGS, slugProblem } from "../lib/auth/slug";
import {
  SPA_NOT_FOUND_ROUTES,
  SPA_ROUTES,
  decodeSpaParam,
  formatTitle,
  matchPageRequest,
  matchSpaRoute,
} from "../lib/spa/routes";

const idOf = (path: string) => matchSpaRoute(path)?.route.id;
const sample = (pattern: string) => pattern.replace(":slug", "demo").replace(":token", "tok_123").replace(":id", "abc123");

test("every route in the table matches its own path, with the right id and status", () => {
  const ids = new Set<string>();
  const paths = new Set<string>();
  for (const route of SPA_ROUTES) {
    assert.ok(!ids.has(route.id), `duplicate id ${route.id}`);
    assert.ok(!paths.has(route.path), `duplicate path ${route.path}`);
    ids.add(route.id);
    paths.add(route.path);
    const m = matchSpaRoute(sample(route.path));
    assert.equal(m?.route.id, route.id, `${route.path}`);
    assert.equal(m?.status, 200);
    if (route.head === "static") assert.ok(route.title, `${route.id}: a static head needs a title`);
  }
  assert.equal(SPA_ROUTES.length, 39, "36 screens of the migration plan + customer-bookings, customer-portal and admin-reports (doc/13); update this number deliberately");
});

test("path parameters are returned raw", () => {
  assert.deepEqual(matchSpaRoute("/pay/abc%20def")?.params, { token: "abc%20def" });
  assert.deepEqual(matchSpaRoute("/manage/tok.en")?.params, { token: "tok.en" });
  assert.deepEqual(matchSpaRoute("/demo")?.params, { slug: "demo" });
  assert.deepEqual(matchSpaRoute("/demo/book")?.params, { slug: "demo" });
  assert.deepEqual(matchSpaRoute("/admin/influencers/clx1")?.params, { id: "clx1" });
  assert.equal(decodeSpaParam("abc%20def"), "abc def");
  assert.equal(decodeSpaParam("%E0%A4%A"), "%E0%A4%A", "a malformed escape is returned unchanged");
});

test("paths that are never SPA pages: the API, hashed assets, Next internals, the shell route, metadata files", () => {
  for (const p of [
    "/api", "/api/health", "/api/auth/session", "/assets", "/assets/index-abc.js", "/_next/static/chunks/x.js", "/_next",
    "/spa-shell", "/spa-shell/terms", "/sitemap.xml", "/robots.txt", "/icon.svg", "/favicon.ico", "/opengraph-image",
    "/opengraph-image-abc123.png", "/__nextjs_original-stack-frames", "/__next_dev_overlay",
  ]) {
    assert.equal(matchSpaRoute(p), null, p);
  }
  assert.equal(matchSpaRoute("terms"), null, "not an absolute path");
  // Look-alikes are ordinary profile slugs, as they are for Next.
  assert.equal(idOf("/assets-foo"), "profile");
  assert.equal(idOf("/apiary"), "profile");
});

test("a static first segment beats the /:slug catch-all, as in Next's own routing", () => {
  assert.equal(idOf("/login"), "login");
  assert.equal(idOf("/register"), "register");
  assert.equal(idOf("/pay/book"), "pay");
  assert.equal(idOf("/manage/book"), "manage");
  assert.equal(idOf("/bookings"), "customer-bookings");
  assert.equal(idOf("/bookings/abc"), "customer-portal");
  assert.deepEqual(matchSpaRoute("/bookings/abc%20def")?.params, { token: "abc%20def" });
  assert.equal(idOf("/bookings/"), "customer-bookings", "a trailing slash is ignored");
  assert.equal(idOf("/bookings-coach"), "profile", "only the exact word is reserved: a profile may start with it");
  assert.equal(idOf("/bookings-coach/book"), "book");
  assert.equal(idOf("/bookings/a/b"), "not-found");
  assert.equal(idOf("/admin/reports"), "admin-reports");
  assert.equal(idOf("/admin/reports/x"), "admin-not-found");
  assert.equal(idOf("/demo/book"), "book");
  assert.equal(idOf("/demo"), "profile");
  assert.equal(idOf("/terms/"), "terms", "a trailing slash is ignored");
  assert.equal(idOf("/"), "landing");
  assert.equal(idOf("/admin"), "admin");
  assert.equal(idOf("/admin/login"), "admin-login");
  assert.equal(idOf("/dashboard"), "dashboard");
  assert.equal(idOf("/onboarding"), "onboarding");
});

test("not-found families: the status is 404, and the id says which frame (site, dashboard, admin) shows the screen", () => {
  const cases: [string, string, 200 | 404][] = [
    ["/a/b/c", "not-found", 404],
    ["/demo/other", "not-found", 404],
    ["/pay/a/b", "not-found", 404],
    ["/profile.name", "not-found", 404],
    ["/%E0%A4%A", "not-found", 404],
    ["//double", "not-found", 404],
    ["/admin/nope", "admin-not-found", 404],
    ["/admin/influencers/a/b", "admin-not-found", 404],
    ["/dashboard/nope", "dashboard-not-found", 404],
    ["/dashboard/sessions/x", "dashboard-not-found", 404],
    ["/onboarding/x", "dashboard-not-found", 404],
    // A bare /pay is a profile lookup (slug "pay"): the token route needs a second segment.
    ["/pay", "profile", 200],
    // A trailing slash is ignored, so this is the influencers list.
    ["/admin/influencers/", "admin-influencers", 200],
  ];
  for (const [path, id, status] of cases) {
    const m = matchSpaRoute(path);
    assert.equal(m?.route.id, id, path);
    assert.equal(m?.status, status, path);
  }
  for (const r of SPA_NOT_FOUND_ROUTES) {
    assert.equal(r.title, "Not found");
    assert.notEqual(r.robots, "index");
  }
});

test("matchPageRequest: only GET and HEAD are page views, and every page of every kind is one", () => {
  for (const [path, id] of [["/", "landing"], ["/terms", "terms"], ["/login", "login"], ["/demo", "profile"], ["/dashboard", "dashboard"], ["/admin/login", "admin-login"], ["/admin/nope", "admin-not-found"], ["/unknown/path/here", "not-found"]]) {
    assert.equal(matchPageRequest("GET", path)?.route.id, id, path);
    assert.equal(matchPageRequest("HEAD", path)?.route.id, id, `HEAD ${path}`);
  }
  for (const method of ["POST", "PUT", "PATCH", "DELETE", "OPTIONS"]) assert.equal(matchPageRequest(method, "/terms"), null, method);
  assert.equal(matchPageRequest("GET", "/api/auth/session"), null);
  assert.equal(matchPageRequest("GET", "/assets/index-abc.js"), null);
});

test("formatTitle follows the old Next title templates", () => {
  assert.equal(formatTitle("Terms of Service", "brand", "Acme"), "Terms of Service · Acme");
  assert.equal(formatTitle("Sessions", "dashboard", "Acme"), "Sessions · Dashboard");
  assert.equal(formatTitle("Payments", "admin", "Acme"), "Payments · Admin");
  assert.equal(formatTitle("{brand}: get paid", "absolute", "Acme"), "Acme: get paid");
  assert.equal(formatTitle("{brand} and {brand}", "absolute", "A"), "A and A");
  const landing = SPA_ROUTES.find((r) => r.id === "landing")!;
  assert.equal(formatTitle(landing.title, landing.template, "Acme"), "Acme: get paid for your time, send the Meet link automatically");
  const sessions = SPA_ROUTES.find((r) => r.id === "dashboard-sessions")!;
  assert.equal(formatTitle(sessions.title, sessions.template, "Acme"), "Sessions · Dashboard");
  const adminLogin = SPA_ROUTES.find((r) => r.id === "admin-login")!;
  assert.equal(formatTitle(adminLogin.title, adminLogin.template, "Acme"), "Admin sign in · Acme", "the login sits outside the console layout");
  const onboarding = SPA_ROUTES.find((r) => r.id === "onboarding")!;
  assert.equal(formatTitle(onboarding.title, onboarding.template, "Acme"), "Set up your booking page · Acme");
});

test("privacy flags: private screens are noindex, token screens send no Referer, public pages are indexable", () => {
  const by = (id: string) => SPA_ROUTES.find((r) => r.id === id)!;
  for (const id of ["landing", "terms", "privacy", "refund-policy", "contact", "register"]) assert.equal(by(id).robots, "index", id);
  const signedIn = (x: { path: string }) => x.path === "/onboarding" || x.path.startsWith("/dashboard") || x.path.startsWith("/admin");
  for (const r of SPA_ROUTES.filter((x) => signedIn(x) || ["login", "forgot-password", "reset-password", "verify-email", "pay", "manage", "design", "customer-bookings", "customer-portal"].includes(x.id))) {
    assert.notEqual(r.robots, "index", r.id);
  }
  for (const r of SPA_ROUTES.filter((x) => x.path.startsWith("/admin") || x.id === "pay" || x.id === "customer-portal")) assert.equal(r.robots, "noindex,nofollow", r.id);
  assert.equal(by("customer-bookings").robots, "noindex");
  for (const id of ["manage", "verify-email", "reset-password", "customer-portal"]) assert.equal((by(id) as { noReferrer?: boolean }).noReferrer, true, id);
  assert.equal((by("pay") as { noReferrer?: boolean }).noReferrer, undefined);
  assert.equal((by("customer-bookings") as { noReferrer?: boolean }).noReferrer, undefined, "the e-mail form carries no token");
});

test("slugs the SPA answers for itself are reserved, so no profile can shadow them", () => {
  assert.ok(RESERVED_SLUGS.has("assets"));
  assert.ok(RESERVED_SLUGS.has("spa-shell"));
  assert.match(slugProblem("assets") ?? "", /reserved/);
  assert.match(slugProblem("spa-shell") ?? "", /reserved/);
  // Every route whose first segment is a literal word reserves it: static pages and the token prefixes (/pay/:token, /manage/:token,
  // /bookings/:token) alike, since `/<slug>/book` under such a prefix would be answered by the token route instead.
  const firstSegments = SPA_ROUTES.map((r) => r.path.split("/")[1]).filter((s) => s && !s.startsWith(":") && s !== "*");
  const missing = firstSegments.filter((s) => !RESERVED_SLUGS.has(s));
  assert.deepEqual(missing, [], "a route's first segment must not be shadowable by a profile slug");
  assert.match(slugProblem("pay") ?? "", /reserved/);
  assert.match(slugProblem("opengraph-image") ?? "", /reserved/);
});
