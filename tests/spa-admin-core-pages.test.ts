// Branch spa/40-admin-core: the SPA PAGE components (web/src/pages/admin/{Login,Overview,Influencers,InfluencerDetail,Security,
// Settings}.tsx) rendered the way the browser renders them: a memory router (the URL and its query string) and a QueryClient that
// holds the endpoint's answer under the page's query key. A wrong query key, a lost `?next=`, a `q` that is not cut to 80
// characters, an id that is not encoded or a view that gets the wrong prop FAILS here (a key mismatch shows the loading skeleton
// instead of the view). The URL a page asks for is read back by running the query function against a stubbed `fetch`.
// tests/spa-admin-core.test.ts and tests/spa-admin-security.test.ts cover the endpoints; no database, browser or network here.
//
// The client components with hooks that need Next's router or a provider (forms, the payout and two-factor panels) are replaced
// by fakes that print their props. `mock.module` only affects modules imported afterwards, so the pages are imported inside
// `before`. Everything from web/ and the two libraries is loaded with a dynamic import and `React` is a global while pages render,
// for the reasons given at the top of tests/spa-public-auth-pages.test.ts.
import assert from "node:assert/strict";
import { before, mock, test } from "node:test";
import * as React from "react";
import { createElement, type ComponentType } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { QueryClient } from "@tanstack/react-query";
import { formatMoney } from "../lib/format";
import type { Jsonify } from "../lib/jsonify";
import type { AdminInfluencerView, AdminInfluencersView } from "../lib/views/admin-influencer";
import type { AdminOverviewView } from "../lib/views/admin-overview";
import type { AdminSecurityView } from "../lib/views/admin-security";
import type { AdminSessionView } from "../lib/views/session";

type ReactRouter = typeof import("react-router");
type ReactQuery = typeof import("@tanstack/react-query");
type WebApi = typeof import("../web/src/lib/api");
type WebQuery = typeof import("../web/src/lib/query");

const unescape = (s: string) => s.replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
/** A stand-in that prints its name and props (JSON), so the test can read back what a page or view handed to it. */
const fake = (name: string) => (props: Record<string, unknown>) => createElement("div", { "data-fake": name, "data-props": JSON.stringify(props) });
/** The props of the first fake of this name in the markup, or null when it is not there. */
function propsOf(html: string, name: string): Record<string, unknown> | null {
  const m = new RegExp(`data-fake="${name}" data-props="([^"]*)"`).exec(html);
  return m ? (JSON.parse(unescape(m[1])) as Record<string, unknown>) : null;
}
const count = (html: string, needle: string) => html.split(needle).length - 1;

let rr: ReactRouter;
let rq: ReactQuery;
let api: WebApi;
let keys: WebQuery["queryKeys"];
type Pages = Record<"login" | "overview" | "influencers" | "influencer" | "security" | "settings", ComponentType>;
let pages: Pages;

before(async () => {
  (globalThis as { React?: unknown }).React = React;
  rr = await import("react-router");
  rq = await import("@tanstack/react-query");
  api = await import("../web/src/lib/api");
  keys = (await import("../web/src/lib/query")).queryKeys;
  mock.module("@web/components/admin/AdminForms", { namedExports: { AdminLoginForm: fake("AdminLoginForm"), AdminPasswordForm: fake("AdminPasswordForm") } });
  mock.module("@web/components/admin/TwoFactorPanel", { namedExports: { TwoFactorPanel: fake("TwoFactorPanel") } });
  mock.module("@web/components/admin/PayoutPanel", { namedExports: { PayoutPanel: fake("PayoutPanel") } });
  mock.module("@web/components/admin/InfluencerStatusPanel", { namedExports: { InfluencerStatusPanel: fake("InfluencerStatusPanel") } });
  mock.module("@web/components/admin/InfluencerWhatsAppWebPanel", { namedExports: { InfluencerWhatsAppWebPanel: fake("InfluencerWhatsAppWebPanel") } });
  mock.module("@web/components/admin/PayoutActions", {
    namedExports: {
      CreatePayoutButton: fake("CreatePayoutButton"),
      FeeForm: fake("FeeForm"),
      PayoutRowActions: fake("PayoutRowActions"),
      PayoutStatusBadges: fake("PayoutStatusBadges"),
    },
  });
  mock.module("@web/components/views/admin/InfluencerSearchForm", { namedExports: { InfluencerSearchForm: fake("InfluencerSearchForm") } });
  const load = async (file: string) => (await import(`../web/src/pages/admin/${file}`)).Component as ComponentType;
  pages = {
    login: await load("Login"),
    overview: await load("Overview"),
    influencers: await load("Influencers"),
    influencer: await load("InfluencerDetail"),
    security: await load("Security"),
    settings: await load("Settings"),
  };
});

/** What a query holds: data, nothing yet (the request is on its way), or a failure with this HTTP status. */
type Held = { data: unknown } | "pending" | { status: number };

async function renderPage(Component: ComponentType, route: string, url: string, held?: { key: readonly unknown[]; value: Held }): Promise<{ html: string; client: QueryClient }> {
  const client = new rq.QueryClient({ defaultOptions: { queries: { retry: false, retryOnMount: false } } });
  if (held && held.value !== "pending") {
    if ("data" in held.value) client.setQueryData(held.key, held.value.data);
    else await client.fetchQuery({ queryKey: held.key, queryFn: () => Promise.reject(new api.ApiError((held.value as { status: number }).status, null, "/api/admin/x")), retry: false }).catch(() => undefined);
  }
  const router = rr.createMemoryRouter([{ path: route, Component }], { initialEntries: [url] });
  const html = renderToStaticMarkup(createElement(rq.QueryClientProvider, { client }, createElement(rr.RouterProvider, { router })));
  return { html, client };
}

/** The API URLs the page's queries ask for: runs each query's function against a stubbed fetch. */
async function requestedUrls(client: QueryClient): Promise<string[]> {
  const seen: string[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: unknown) => {
    seen.push(String(input));
    return new Response("{}", { headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  try {
    for (const q of client.getQueryCache().getAll()) await q.fetch().catch(() => undefined);
  } finally {
    globalThis.fetch = real;
  }
  return seen;
}

const overview = (over: Partial<Jsonify<AdminOverviewView>> = {}): Jsonify<AdminOverviewView> => ({
  overview: {
    influencers: { total: 5, onboarded: 3 },
    bookingsByStatus: { SCHEDULED: 2, PAID: 1, COMPLETED: 4, FAILED: 1 },
    captured: [{ currency: "INR", amountMinor: 250_000 }],
    refunded: [],
    attention: { needsRefund: 0, mismatched: 0, googleReconnect: 0, failedMessages7d: 0 },
  },
  recentAudit: [],
  health: { available: true, unhealthy: [] },
  ...over,
});

const influencers = (rows: Jsonify<AdminInfluencersView>["rows"], over: Partial<Jsonify<AdminInfluencersView>> = {}): Jsonify<AdminInfluencersView> => ({
  rows,
  total: rows.length,
  page: 1,
  pageCount: 1,
  status: "all",
  counts: { suspended: 0, awaitingApproval: 0 },
  ...over,
});

const row: Jsonify<AdminInfluencersView>["rows"][number] = {
  id: "inf_1",
  name: "Asha Rao",
  email: "asha@example.com",
  live: false,
  blockers: ["Connect Google Calendar"],
  accountStatus: "active",
  emailVerified: false,
  google: "reconnect",
  whatsapp: { text: "Templates in review", tone: "warning" },
  payout: "pending",
  services: 2,
  bookings: 3,
  grossMinor: 150_000,
};

const approval = { required: true, approved: false, approvedByEmail: null, canApprove: true, createdByViewer: false, canMarkPaid: false };
const detail = (over: Partial<Jsonify<AdminInfluencerView>> = {}): Jsonify<AdminInfluencerView> => ({
  influencer: { id: "inf_1", name: "Asha Rao", email: "asha@example.com", slug: "asha", onboardedAt: "2026-09-01T00:00:00.000Z", createdAt: "2026-08-01T00:00:00.000Z", emailVerified: true },
  readinessItems: [
    { key: "email", label: "Confirm your email", state: "done", required: true },
    { key: "google", label: "Connect Google Calendar", state: "attention", required: true },
    { key: "whatsapp", label: "Connect your WhatsApp number", state: "todo", required: false },
  ],
  connections: { google: { state: "active", email: "asha@gmail.example" }, whatsapp: { text: "Not connected" }, gmailSend: false },
  payoutAccount: { method: "BANK", accountHolderName: "Asha Rao", bankName: "HDFC Bank", ifsc: "HDFC0001234", accountNumber: "XXXXXXXX9012", upiId: null, status: "VERIFIED", rejectionReason: null },
  fee: { overrideBps: 1000, defaultBps: 0, feeBps: 1000, feePercentText: "10%" },
  verified: true,
  onlyOneAdmin: false,
  currencies: [{ currency: "INR", readyMinor: 45_000, readyGrossMinor: 50_000, readyFeeMinor: 5_000, readyCount: 1, waitingMinor: 30_000, waitingCount: 1, waitingText: "1 waiting for reconciliation" }],
  payouts: [{ id: "po_1", createdAt: "2026-10-01T00:00:00.000Z", destination: "HDFC Bank XXXXXXXX9012", netMinor: 45_000, currency: "INR", status: "PENDING", reference: null, owedMinor: 0, approval }],
  services: [{ id: "s1", title: "Career chat", type: "ONE_TO_ONE", capacity: 1, durationMin: 30, priceMinor: 50_000, currency: "INR", active: true }],
  bookings: [{ id: "b1", serviceTitle: "Career chat", startTime: "2026-09-20T10:00:00.000Z", customerName: "Ravi", status: "COMPLETED", paidMinor: 50_000, currency: "INR" }],
  ...over,
});

const security = (over: Partial<Jsonify<AdminSecurityView>> = {}): Jsonify<AdminSecurityView> => ({
  email: "boss@example.com",
  mfa: { enabled: true, recoveryCodesLeft: 8 },
  required: true,
  fourEyes: true,
  fourEyesMinMinor: 0,
  admins: [
    { email: "boss@example.com", name: "Boss", totpEnabled: true, lastLoginAt: "2026-10-10T08:00:00.000Z", disabled: false, isSelf: true },
    { email: "deputy@example.com", name: "Deputy", totpEnabled: false, lastLoginAt: null, disabled: false, isSelf: false },
  ],
  ...over,
});

test("every page sets the route table's title and the right landmarks (the frame provides main#main for console pages)", async () => {
  const login = await renderPage(pages.login, "/admin/login", "/admin/login");
  assert.ok(login.html.includes("<title>Admin sign in · Session Automation</title>"), login.html.slice(0, 200));
  assert.equal(count(login.html, '<main id="main"'), 1, "the login screen is its own frame");
  assert.equal(count(login.html, "<h1"), 1);

  const cases: [string, ComponentType, string, string, readonly unknown[], unknown][] = [
    ["Overview · Admin", pages.overview, "/admin", "/admin", keys.admin("overview"), overview()],
    ["Influencers · Admin", pages.influencers, "/admin/influencers", "/admin/influencers", keys.admin("influencers", { page: "", q: "", status: "" }), influencers([row])],
    ["Influencer · Admin", pages.influencer, "/admin/influencers/:id", "/admin/influencers/inf_1", keys.admin("influencer", { id: "inf_1" }), detail()],
    ["Security · Admin", pages.security, "/admin/security", "/admin/security", keys.admin("security"), security()],
  ];
  for (const [title, Component, route, url, key, data] of cases) {
    const { html } = await renderPage(Component, route, url, { key, value: { data } });
    assert.ok(html.includes(`<title>${title}</title>`), `${url}: ${title}`);
    assert.equal(count(html, "<main"), 0, `${url}: no second main inside the console frame`);
    assert.equal(count(html, "<h1"), 1, `${url}: one h1`);
    // While the data is on its way: the title is already there and the skeleton is shown, not the view.
    const loading = await renderPage(Component, route, url, { key, value: "pending" });
    assert.ok(loading.html.includes(`<title>${title}</title>`), `${url}: title while loading`);
    assert.ok(loading.html.includes('aria-busy="true"') && count(loading.html, "<h1") === 0, `${url}: skeleton while loading`);
  }
  const settings = await renderPage(pages.settings, "/admin/settings", "/admin/settings", { key: keys.adminSession(), value: { data: { authenticated: true, admin: { name: "Boss", email: "boss@example.com" }, gate: "ok" } satisfies AdminSessionView } });
  assert.ok(settings.html.includes("<title>Settings · Admin</title>") && count(settings.html, "<h1") === 1);
});

test("login page: ?next reaches the form exactly as written (the API validates it), and is absent without one", async () => {
  const withNext = await renderPage(pages.login, "/admin/login", "/admin/login?next=%2Fadmin%2Finfluencers%3Fq%3Da");
  assert.deepEqual(propsOf(withNext.html, "AdminLoginForm"), { next: "/admin/influencers?q=a" });
  assert.deepEqual(propsOf((await renderPage(pages.login, "/admin/login", "/admin/login")).html, "AdminLoginForm"), {});
  assert.ok(withNext.html.includes("Authorised administrators only. Activity is logged."));
});

test("influencers page: page and q reach the API, q is cut to 80 characters, the view gets q for the search box and the page links", async () => {
  const key = keys.admin("influencers", { page: "2", q: "asha", status: "" });
  const data = influencers([row], { total: 60, page: 2, pageCount: 3 });
  const { html, client } = await renderPage(pages.influencers, "/admin/influencers", "/admin/influencers?page=2&q=asha", { key, value: { data } });
  assert.deepEqual(await requestedUrls(client), ["/api/admin/influencers?page=2&q=asha"]);
  assert.deepEqual(propsOf(html, "InfluencerSearchForm"), { q: "asha" });
  assert.ok(html.includes("60 accounts") && html.includes("Asha Rao") && html.includes("asha@example.com"));
  assert.ok(html.includes("Waiting for: Connect Google Calendar") && html.includes("Templates in review"));
  assert.ok(html.includes('href="/admin/influencers/inf_1"'));
  assert.ok(html.includes("/admin/influencers?page=1&amp;q=asha") && html.includes("/admin/influencers?page=3&amp;q=asha"), "pagination keeps q");

  const bare = await renderPage(pages.influencers, "/admin/influencers", "/admin/influencers", { key: keys.admin("influencers", { page: "", q: "", status: "" }), value: { data: influencers([row]) } });
  assert.deepEqual(await requestedUrls(bare.client), ["/api/admin/influencers"], "no page, no q: no query string");
  assert.deepEqual(propsOf(bare.html, "InfluencerSearchForm"), {});

  // The status tab is part of the request (and of the cache key), next to page and q; an unknown value is left for the server to read as "all".
  const tab = await renderPage(pages.influencers, "/admin/influencers", "/admin/influencers?status=suspended&q=asha", {
    key: keys.admin("influencers", { page: "", q: "asha", status: "suspended" }),
    value: { data: influencers([row], { status: "suspended", counts: { suspended: 1, awaitingApproval: 0 } }) },
  });
  assert.deepEqual(await requestedUrls(tab.client), ["/api/admin/influencers?q=asha&status=suspended"], "?status= reaches the API");
  assert.deepEqual(propsOf(tab.html, "InfluencerSearchForm"), { q: "asha", status: "suspended" }, "a search keeps the open tab");
  const statusOnly = await renderPage(pages.influencers, "/admin/influencers", "/admin/influencers?status=awaiting-approval", {
    key: keys.admin("influencers", { page: "", q: "", status: "awaiting-approval" }),
    value: { data: influencers([], { status: "awaiting-approval", counts: { suspended: 0, awaitingApproval: 0 } }) },
  });
  assert.deepEqual(await requestedUrls(statusOnly.client), ["/api/admin/influencers?status=awaiting-approval"]);

  const long = "x".repeat(120);
  const cut = "x".repeat(80);
  const trimmed = await renderPage(pages.influencers, "/admin/influencers", `/admin/influencers?q=${long}`, { key: keys.admin("influencers", { page: "", q: cut, status: "" }), value: { data: influencers([]) } });
  assert.deepEqual(await requestedUrls(trimmed.client), [`/api/admin/influencers?q=${cut}`]);
  assert.ok(trimmed.html.includes("No influencers found") && trimmed.html.includes("Try a different search."));
  const empty = await renderPage(pages.influencers, "/admin/influencers", "/admin/influencers", { key: keys.admin("influencers", { page: "", q: "", status: "" }), value: { data: influencers([]) } });
  assert.ok(empty.html.includes("Accounts appear here as people register."));
});

test("influencer page: the id is the route parameter, the payout panel gets the masked account only, payout buttons follow `verified`", async () => {
  const key = keys.admin("influencer", { id: "inf_1" });
  const { html, client } = await renderPage(pages.influencer, "/admin/influencers/:id", "/admin/influencers/inf_1", { key, value: { data: detail() } });
  assert.deepEqual(await requestedUrls(client), ["/api/admin/influencers/inf_1"]);
  assert.deepEqual(propsOf(html, "PayoutPanel"), {
    influencerId: "inf_1",
    account: { method: "BANK", accountHolderName: "Asha Rao", bankName: "HDFC Bank", ifsc: "HDFC0001234", accountNumber: "XXXXXXXX9012", upiId: null, status: "VERIFIED", rejectionReason: null },
  });
  assert.deepEqual(propsOf(html, "InfluencerStatusPanel"), { influencerId: "inf_1" }, "the moderation panel loads its own data");
  assert.deepEqual(propsOf(html, "InfluencerWhatsAppWebPanel"), { influencerId: "inf_1" }, "the QR-code WhatsApp card loads its own data (and draws nothing when the platform flag is off)");
  assert.deepEqual(propsOf(html, "FeeForm"), { influencerId: "inf_1", feeBps: 1000, defaultBps: 0 });
  assert.deepEqual(propsOf(html, "CreatePayoutButton"), { influencerId: "inf_1", currency: "INR", label: "Create INR payout" });
  assert.deepEqual(propsOf(html, "PayoutRowActions"), { payoutId: "po_1", status: "PENDING", approval });
  assert.deepEqual(propsOf(html, "PayoutStatusBadges"), { status: "PENDING", approval });
  assert.ok(html.includes("Current fee: 10%."));
  assert.ok(html.includes("not payable yet: 1 waiting for reconciliation."));
  assert.ok(html.includes("Career chat") && html.includes("Ravi") && html.includes("asha@gmail.example"));
  assert.ok(!html.includes("Payouts can be created once"), "verified");

  // Not verified: no create button, the warning instead; one administrator only: the four-eyes warning; nothing payable: the empty text.
  const unverified = await renderPage(pages.influencer, "/admin/influencers/:id", "/admin/influencers/inf_1", {
    key,
    value: { data: detail({ verified: false, onlyOneAdmin: true, currencies: [], payouts: [], payoutAccount: null }) },
  });
  assert.equal(propsOf(unverified.html, "CreatePayoutButton"), null);
  assert.equal(propsOf(unverified.html, "PayoutRowActions"), null);
  assert.deepEqual(propsOf(unverified.html, "PayoutPanel"), { influencerId: "inf_1", account: null });
  assert.ok(unverified.html.includes("Payouts can be created once this influencer"));
  assert.ok(unverified.html.includes("Payouts need a second administrator"));
  assert.ok(unverified.html.includes("No paid sessions waiting to be paid out."));

  // An unknown id is the usual 404 screen inside the frame (no second main).
  const missing = await renderPage(pages.influencer, "/admin/influencers/:id", "/admin/influencers/nope", { key: keys.admin("influencer", { id: "nope" }), value: { status: 404 } });
  assert.ok(missing.html.includes("This page does not exist") && count(missing.html, "<main") === 0);
});

test("security page: the two-factor panel gets the admin's own state; no list is shown for a session that may not see it", async () => {
  const key = keys.admin("security");
  const full = await renderPage(pages.security, "/admin/security", "/admin/security", { key, value: { data: security() } });
  assert.deepEqual(propsOf(full.html, "TwoFactorPanel"), { enabled: true, recoveryCodesLeft: 8, required: true });
  assert.ok(full.html.includes("Administrators (2)") && full.html.includes("deputy@example.com") && full.html.includes("(you)"));
  assert.equal(count(full.html, "(you)"), 1);
  assert.ok(full.html.includes("A second administrator has to approve each payout"));

  const hidden = await renderPage(pages.security, "/admin/security", "/admin/security", {
    key,
    value: { data: security({ admins: null, mfa: { enabled: false, recoveryCodesLeft: 0 }, fourEyes: false }) },
  });
  assert.deepEqual(propsOf(hidden.html, "TwoFactorPanel"), { enabled: false, recoveryCodesLeft: 0, required: true });
  assert.ok(hidden.html.includes("shown after you have set up two-factor authentication"));
  assert.ok(!hidden.html.includes("deputy@example.com") && !hidden.html.includes("Administrators ("));
  assert.ok(hidden.html.includes("Payout approval by a second administrator is off"));
});

test("overview page: alerts follow the data; settings page shows the signed-in administrator's email", async () => {
  const quiet = await renderPage(pages.overview, "/admin", "/admin", { key: keys.admin("overview"), value: { data: overview() } });
  assert.ok(quiet.html.includes("Nothing needs attention right now."));
  assert.ok(quiet.html.includes("No activity yet."));

  const loud = overview({
    overview: { ...overview().overview, attention: { needsRefund: 2, mismatched: 1, googleReconnect: 3, failedMessages7d: 4 } },
    health: { available: true, unhealthy: [{ label: "Worker is not running", status: "critical" }] },
    recentAudit: Array.from({ length: 8 }, (_, i) => ({ id: `a${i}`, createdAt: "2026-10-10T08:00:00.000Z", adminEmail: `admin${i}@example.com`, action: "payout.created", targetType: "payout" })),
  });
  const html = (await renderPage(pages.overview, "/admin", "/admin", { key: keys.admin("overview"), value: { data: loud } })).html;
  assert.ok(!html.includes("Nothing needs attention right now."));
  for (const text of ["1 system health issue", "Worker is not running", "1 captured payment(s) with no paid booking", "2 payment(s) flagged for refund", "3 influencer(s) must reconnect Google", "4 message(s) failed in the last 7 days"]) {
    assert.ok(html.includes(text), text);
  }
  assert.ok(html.includes("admin7@example.com") && html.includes("payout.created · payout"));
  assert.ok(html.includes('href="/admin/payments?view=mismatch"') && html.includes('href="/admin/health"'));
  assert.ok(html.includes(formatMoney(250_000, "INR")), "gross collected is formatted by the shared money formatter");

  const settings = await renderPage(pages.settings, "/admin/settings", "/admin/settings", {
    key: keys.adminSession(),
    value: { data: { authenticated: true, admin: { name: "Boss", email: "boss@example.com" }, gate: "ok" } satisfies AdminSessionView },
  });
  assert.ok(settings.html.includes("Signed in as boss@example.com"));
  assert.deepEqual(propsOf(settings.html, "AdminPasswordForm"), {});
  const waiting = await renderPage(pages.settings, "/admin/settings", "/admin/settings", { key: keys.adminSession(), value: "pending" });
  assert.ok(waiting.html.includes('aria-busy="true"') && !waiting.html.includes("Signed in as"));
});
