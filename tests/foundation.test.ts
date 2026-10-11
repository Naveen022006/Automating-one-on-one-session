// The marketplace foundation branch (doc/13-product-build-plan.md, WP-0): the pre-registered placeholders and stubs that the six
// feature branches fill in. No database, no browser. When a work package replaces its placeholder, it updates (or deletes) the
// matching case below deliberately; the wiring checks (route ids, nav, footer, stub mounts) must stay green.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { sweepOldActivity } from "../lib/activity-retention";
import { sweepExpiredCustomerAccess } from "../lib/customer-access-sweep";
import { SPA_ROUTES } from "../lib/spa/routes";

const root = join(__dirname, "..");
const read = (file: string) => readFileSync(join(root, file), "utf8");
const route = (id: string) => SPA_ROUTES.find((r) => r.id === id)! as { id: string; title?: string };

test("the three new routes have a lazy page module in the router, in the right guard group", () => {
  const router = read("web/src/router.tsx");
  for (const [id, module] of [
    ["customer-bookings", "./pages/booking/FindBookings"],
    ["customer-portal", "./pages/booking/CustomerPortal"],
    ["admin-reports", "./pages/admin/Reports"],
  ]) {
    assert.ok(router.includes(`"${id}": () => import("${module}")`), `${id} has a lazy page`);
    assert.ok(router.includes(`leaf("${id}")`), `${id} is a leaf`);
  }
  const at = (needle: string) => router.indexOf(needle);
  // Customer pages are public: before `book` / `profile` (a static first segment wins) and outside every guard element.
  assert.ok(at('leaf("customer-bookings")') < at('leaf("book")') && at('leaf("customer-portal")') < at('leaf("profile")'));
  assert.ok(at('leaf("customer-portal")') < at("<RequireSession />"), "no session guard on the customer pages");
  // The report is inside RequireAdmin.
  assert.ok(at("<RequireAdmin />") < at('leaf("admin-reports")') && at('leaf("admin-reports")') < at('path: "/admin/*"'));
});

test("no placeholder page remains; the token page keeps the no-referrer policy", () => {
  // All three foundation placeholders are real pages now (WP-D customer pages, WP-F report); no 'Coming soon' page may remain.
  // The token page keeps the no-referrer policy of the other token pages (see pages/booking/Manage.tsx).
  assert.ok(read("web/src/pages/booking/CustomerPortal.tsx").includes('<meta name="referrer" content="no-referrer" />'));
  for (const [id, file] of [
    ["customer-bookings", "web/src/pages/booking/FindBookings.tsx"],
    ["customer-portal", "web/src/pages/booking/CustomerPortal.tsx"],
  ] as const) {
    const src = read(file);
    assert.equal(src.match(/<PageTitle /g)?.length, 1, `${file}: exactly one PageTitle`);
    assert.ok(src.includes(`<PageTitle title="${route(id).title}" />`), `${file}: title equals the route table`);
    assert.ok(!src.includes("Coming soon"), file);
  }
  // The admin report is a real page too (the placeholder is gone and the title still equals the route table).
  const reports = read("web/src/pages/admin/Reports.tsx");
  assert.ok(!reports.includes("Coming soon"), "web/src/pages/admin/Reports.tsx");
  assert.equal(reports.match(/<PageTitle /g)?.length, 1, "Reports: exactly one PageTitle");
  assert.ok(reports.includes(`<PageTitle title="${route("admin-reports").title}" template="admin" />`), "Reports: title equals the route table");
});

test("navigation: the admin sidebar has Reports after Payouts, the site footers link to /bookings", () => {
  const shell = read("web/src/components/admin/AdminShell.tsx");
  assert.ok(shell.includes('{ href: "/admin/reports", label: "Reports", icon: IconBarChart }'));
  assert.ok(shell.indexOf('href: "/admin/payouts"') < shell.indexOf('href: "/admin/reports"'));
  const mobilePrimary = /const MOBILE_PRIMARY = \[([^\]]*)\]/.exec(shell)?.[1] ?? "";
  assert.ok(!mobilePrimary.includes("/admin/reports"), "Reports lands in More");
  const chrome = read("web/src/components/site/SiteChrome.tsx");
  assert.ok(chrome.includes('<AppLink href="/bookings">Find your booking</AppLink>'));
  assert.ok(chrome.includes('<AppLink href="/bookings">Your bookings</AppLink>'));
  assert.ok(read("web/src/lib/query.ts").includes('customerPortal: (token: string) => ["customer", "portal", token] as const'));
});

test("the influencer detail page mounts each stub panel once: status under the header, activity as the last card", () => {
  const view = read("web/src/components/views/admin/InfluencerDetailView.tsx");
  assert.equal(view.match(/<InfluencerStatusPanel influencerId=\{i\.id\} \/>/g)?.length, 1);
  assert.equal(view.match(/<InfluencerActivityPanel influencerId=\{i\.id\} \/>/g)?.length, 1);
  assert.ok(view.indexOf("<PageHead") < view.indexOf("<InfluencerStatusPanel") && view.indexOf("<InfluencerStatusPanel") < view.indexOf("<Card title=\"Account\">"));
  assert.ok(view.indexOf('<Card title="Recent bookings">') < view.indexOf("<InfluencerActivityPanel"));
});

test("the retention sweeps are wired into sweepExpiredAuthRows and return a count", async () => {
  // Both sweeps are real now and delete rows: tests/activity-log.test.ts and tests/customer-portal.test.ts cover them with their own rows.
  assert.equal(typeof sweepOldActivity, "function");
  assert.equal(typeof sweepExpiredCustomerAccess, "function");
  const sweep = read("lib/auth/sweep.ts");
  assert.ok(sweep.includes("await sweepOldActivity(now)") && sweep.includes("await sweepExpiredCustomerAccess(now)"));
  assert.ok(/return a\.count \+ b\.count \+ c\.count \+ activity \+ customerAccess;/.test(sweep));
});

test("next.config.ts marks /api/customer private, and the schema carries the foundation models", () => {
  assert.ok(read("next.config.ts").includes('{ source: "/api/customer/:path*", headers: privateApiHeaders }'));
  const schema = read("prisma/schema.prisma");
  for (const needle of ["suspendedAt", "suspendedReason", "suspendedByEmail", "approvedAt", "approvedByEmail", "model InfluencerActivity", "model CustomerAccessToken"]) {
    assert.ok(schema.includes(needle), needle);
  }
  const moderation = read("prisma/migrations/20261106000000_influencer_moderation/migration.sql");
  assert.ok(/UPDATE "influencers" SET "approved_at" = "onboarded_at", "approved_by_email" = 'system:grandfathered' WHERE "onboarded_at" IS NOT NULL;/.test(moderation));
});
