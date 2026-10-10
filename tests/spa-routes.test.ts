// Pure tests of the SPA route table (lib/spa/routes.ts): which URL is which page, which group switches it, and what
// the title is. The proxy, the shell head and the web router all read this table, so these tests are the contract.
import assert from "node:assert/strict";
import { test } from "node:test";
import { RESERVED_SLUGS, slugProblem } from "../lib/auth/slug";
import {
  SPA_GROUPS,
  SPA_NOT_FOUND_ROUTES,
  SPA_ROUTES,
  decodeSpaParam,
  formatTitle,
  matchEnabledSpaRoute,
  matchSpaRoute,
  parseSpaGroups,
  unknownSpaGroups,
  type SpaGroup,
} from "../lib/spa/routes";

const idOf = (path: string) => matchSpaRoute(path)?.route.id;
const sample = (pattern: string) => pattern.replace(":slug", "demo").replace(":token", "tok_123").replace(":id", "abc123");

test("every route in the table matches its own path, with the right id, group and status", () => {
  const ids = new Set<string>();
  const paths = new Set<string>();
  for (const route of SPA_ROUTES) {
    assert.ok(!ids.has(route.id), `duplicate id ${route.id}`);
    assert.ok(!paths.has(route.path), `duplicate path ${route.path}`);
    ids.add(route.id);
    paths.add(route.path);
    assert.ok((SPA_GROUPS as readonly string[]).includes(route.group), `${route.id}: unknown group`);
    const m = matchSpaRoute(sample(route.path));
    assert.equal(m?.route.id, route.id, `${route.path}`);
    assert.equal(m?.route.group, route.group);
    assert.equal(m?.status, 200);
    if (route.head === "static") assert.ok(route.title, `${route.id}: a static head needs a title`);
  }
  assert.equal(SPA_ROUTES.length, 36, "the plan lists 36 screens (section 4); update this number deliberately");
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
  assert.equal(idOf("/demo/book"), "book");
  assert.equal(idOf("/demo"), "profile");
  assert.equal(idOf("/terms/"), "terms", "a trailing slash is ignored");
  assert.equal(idOf("/"), "landing");
  assert.equal(idOf("/admin"), "admin");
  assert.equal(idOf("/admin/login"), "admin-login");
  assert.equal(idOf("/dashboard"), "dashboard");
  assert.equal(idOf("/onboarding"), "onboarding");
});

test("not-found families: the status is 404 and the group says which switch controls them", () => {
  const cases: [string, string, SpaGroup, 200 | 404][] = [
    ["/a/b/c", "not-found", "public", 404],
    ["/demo/other", "not-found", "public", 404],
    ["/pay/a/b", "not-found", "public", 404],
    ["/profile.name", "not-found", "public", 404],
    ["/%E0%A4%A", "not-found", "public", 404],
    ["//double", "not-found", "public", 404],
    ["/admin/nope", "admin-not-found", "admin", 404],
    ["/admin/influencers/a/b", "admin-not-found", "admin", 404],
    ["/dashboard/nope", "dashboard-not-found", "dashboard", 404],
    ["/dashboard/sessions/x", "dashboard-not-found", "dashboard", 404],
    ["/onboarding/x", "dashboard-not-found", "dashboard", 404],
    // Next resolves a bare /pay to the profile route (slug "pay"), so it is a profile lookup here too.
    ["/pay", "profile", "booking", 200],
    // A trailing slash is ignored, so this is the influencers list.
    ["/admin/influencers/", "admin-influencers", "admin", 200],
  ];
  for (const [path, id, group, status] of cases) {
    const m = matchSpaRoute(path);
    assert.equal(m?.route.id, id, path);
    assert.equal(m?.route.group, group, path);
    assert.equal(m?.status, status, path);
  }
  for (const r of SPA_NOT_FOUND_ROUTES) {
    assert.equal(r.title, "Not found");
    assert.notEqual(r.robots, "index");
  }
});

test("parseSpaGroups: empty means none, 'all' means every group, unknown names are ignored", () => {
  assert.equal(parseSpaGroups(undefined).size, 0);
  assert.equal(parseSpaGroups(null).size, 0);
  assert.equal(parseSpaGroups("").size, 0);
  assert.equal(parseSpaGroups("  ").size, 0);
  assert.deepEqual([...parseSpaGroups("all")].sort(), [...SPA_GROUPS].sort());
  assert.deepEqual([...parseSpaGroups(" ALL ")].sort(), [...SPA_GROUPS].sort());
  assert.deepEqual([...parseSpaGroups("public, Auth")].sort(), ["auth", "public"]);
  assert.deepEqual([...parseSpaGroups("public,bogus")], ["public"]);
  assert.deepEqual([...parseSpaGroups("all,bogus")].sort(), [...SPA_GROUPS].sort());
  assert.deepEqual([...parseSpaGroups("dashboard,dashboard")], ["dashboard"]);
  assert.deepEqual(unknownSpaGroups("public, bogus,x,all,"), ["bogus", "x"]);
  assert.deepEqual(unknownSpaGroups("all"), []);
  assert.deepEqual(unknownSpaGroups(undefined), []);
});

test("matchEnabledSpaRoute: only GET/HEAD, only enabled groups; with no groups nothing is SPA", () => {
  const none = parseSpaGroups("");
  const publicOnly = parseSpaGroups("public");
  const all = parseSpaGroups("all");
  assert.equal(matchEnabledSpaRoute("GET", "/", none), null, "SPA_GROUPS empty: the old pages everywhere");
  assert.equal(matchEnabledSpaRoute("GET", "/dashboard", none), null);
  assert.equal(matchEnabledSpaRoute("GET", "/terms", publicOnly)?.route.id, "terms");
  assert.equal(matchEnabledSpaRoute("HEAD", "/terms", publicOnly)?.route.id, "terms");
  assert.equal(matchEnabledSpaRoute("GET", "/login", publicOnly), null, "auth is not enabled");
  assert.equal(matchEnabledSpaRoute("GET", "/demo", publicOnly), null, "booking is not enabled");
  assert.equal(matchEnabledSpaRoute("GET", "/unknown/path/here", publicOnly)?.route.id, "not-found", "public owns the generic 404");
  assert.equal(matchEnabledSpaRoute("GET", "/admin/nope", publicOnly), null, "the admin 404 belongs to admin");
  for (const method of ["POST", "PUT", "PATCH", "DELETE", "OPTIONS"]) assert.equal(matchEnabledSpaRoute(method, "/terms", all), null, method);
  assert.equal(matchEnabledSpaRoute("GET", "/api/auth/session", all), null);
  assert.equal(matchEnabledSpaRoute("GET", "/admin/login", parseSpaGroups("admin"))?.route.id, "admin-login");
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
  for (const r of SPA_ROUTES.filter((x) => x.group === "dashboard" || x.group === "admin" || ["login", "forgot-password", "reset-password", "verify-email", "pay", "manage", "design"].includes(x.id))) {
    assert.notEqual(r.robots, "index", r.id);
  }
  for (const r of SPA_ROUTES.filter((x) => x.group === "admin" || x.id === "pay")) assert.equal(r.robots, "noindex,nofollow", r.id);
  for (const id of ["manage", "verify-email", "reset-password"]) assert.equal((by(id) as { noReferrer?: boolean }).noReferrer, true, id);
  assert.equal((by("pay") as { noReferrer?: boolean }).noReferrer, undefined);
});

test("slugs the SPA answers for itself are reserved, so no profile can shadow them", () => {
  assert.ok(RESERVED_SLUGS.has("assets"));
  assert.ok(RESERVED_SLUGS.has("spa-shell"));
  assert.match(slugProblem("assets") ?? "", /reserved/);
  assert.match(slugProblem("spa-shell") ?? "", /reserved/);
  // Every static page's first segment is a reserved slug. (The token prefixes /pay and /manage are dynamic routes and not covered
  // here: `manage` is reserved, `pay` is not; see doc/10-react-migration-deviations.md.)
  const missing = SPA_ROUTES.filter((r) => !r.path.includes(":")).map((r) => r.path.split("/")[1]).filter((s) => s && !RESERVED_SLUGS.has(s));
  assert.deepEqual(missing, [], "a static SPA page must not be shadowable by a profile slug");
});
