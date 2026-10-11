// Branch spa/31-dashboard-setup: the SPA PAGE components (web/src/pages/dashboard/{Services,Availability,Payouts,Settings,
// Onboarding}.tsx) rendered the way the browser renders them: a memory router (the URL and its query string) and a QueryClient
// holding the answer of the page's query (data, still loading, or a failure), so a lost `?step=` or `?google=`, a page that
// shows data it should not, or an onboarding frame that steals the `#main` landmark FAILS here. tests/spa-dashboard-setup.test.ts
// covers the views themselves and the endpoints.
//
// The views are replaced by fakes that print their props (what a page hands to its view is not visible in the real markup).
// `mock.module` only affects modules imported afterwards, which is why this lives in its own file and the pages are imported
// inside `before`. Same two harness details as tests/spa-public-auth-pages.test.ts: react-router and @tanstack/react-query are
// loaded with a dynamic import (a static import from this CommonJS test would be a second copy), and `React` is a global.
// No browser, no database, no network. Effects do not run in a static render, so the refetch on a `?step=` change (an effect)
// is checked by its source here and in a browser by hand.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { before, mock, test } from "node:test";
import * as React from "react";
import { createElement, type ComponentType } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { QueryClient } from "@tanstack/react-query";

type ReactRouter = typeof import("react-router");
type ReactQuery = typeof import("@tanstack/react-query");
type WebApi = typeof import("../web/src/lib/api");
type WebQuery = typeof import("../web/src/lib/query");

let rr: ReactRouter;
let rq: ReactQuery;
let api: WebApi;
let keys: WebQuery["queryKeys"];

type PageName = "services" | "availability" | "payouts" | "settings" | "onboarding";
let pages: Record<PageName, ComponentType>;

/** Fake views print their name and props as JSON; the onboarding one renders the `main#main` the real wizard brings. */
const fakeView = (name: string, tag: "div" | "main") => (props: Record<string, unknown>) =>
  createElement(tag, { ...(tag === "main" ? { id: "main" } : {}), "data-view": name, "data-props": JSON.stringify(props) });
const unescape = (s: string) => s.replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
/** The props the fake view of a page received, or null when that view is not on the page. */
function viewProps(html: string, name: string): Record<string, unknown> | null {
  const m = new RegExp(`data-view="${name}" data-props="([^"]*)"`).exec(html);
  return m ? (JSON.parse(unescape(m[1])) as Record<string, unknown>) : null;
}
const count = (html: string, needle: string) => html.split(needle).length - 1;

const KEY: Record<PageName, string> = { services: "services", availability: "availability", payouts: "payouts", settings: "settings", onboarding: "onboarding" };
const URL_OF: Record<PageName, string> = {
  services: "/dashboard/services",
  availability: "/dashboard/availability",
  payouts: "/dashboard/payouts",
  settings: "/dashboard/settings",
  onboarding: "/onboarding",
};
const TITLE: Record<PageName, string> = {
  services: "Services · Dashboard",
  availability: "Availability · Dashboard",
  payouts: "Payouts · Dashboard",
  settings: "Settings · Dashboard",
  onboarding: "Set up your booking page · Session Automation",
};
const VIEW: Record<PageName, string> = { services: "ServicesView", availability: "AvailabilityView", payouts: "PayoutsView", settings: "SettingsView", onboarding: "OnboardingView" };

before(async () => {
  (globalThis as { React?: unknown }).React = React;
  rr = await import("react-router");
  rq = await import("@tanstack/react-query");
  api = await import("../web/src/lib/api");
  keys = (await import("../web/src/lib/query")).queryKeys;
  for (const page of Object.keys(VIEW) as PageName[]) {
    mock.module(`@/components/views/dashboard/${VIEW[page]}`, { namedExports: { [VIEW[page]]: fakeView(VIEW[page], page === "onboarding" ? "main" : "div") } });
  }
  const load = async (file: string) => (await import(`../web/src/pages/dashboard/${file}`)).Component as ComponentType;
  pages = {
    services: await load("Services"),
    availability: await load("Availability"),
    payouts: await load("Payouts"),
    settings: await load("Settings"),
    onboarding: await load("Onboarding"),
  };
});

/** What the page's query holds: an answer, nothing yet (the request is still on its way), or a failure with this status. */
type Held = { data: Record<string, unknown> } | "pending" | { failed: number; message?: string };

async function clientWith(page: PageName, held: Held): Promise<QueryClient> {
  // retryOnMount: false, so a query that already failed shows its error on the first render instead of loading again.
  const client = new rq.QueryClient({ defaultOptions: { queries: { retry: false, retryOnMount: false } } });
  const key = keys.dashboard(KEY[page]);
  if (held === "pending") return client;
  if ("failed" in held) {
    const body = held.message ? { error: held.message } : null;
    await client.fetchQuery({ queryKey: key, queryFn: () => Promise.reject(new api.ApiError(held.failed, body, `/api/dashboard/${KEY[page]}`, held.message)), retry: false }).catch(() => undefined);
  } else {
    client.setQueryData(key, held.data);
  }
  return client;
}

/** Renders one page at `url` (path and query string) under a memory router and a QueryClient that holds `held` for the page's key. */
async function renderPage(page: PageName, url: string, held: Held): Promise<string> {
  const router = rr.createMemoryRouter([{ path: url.split("?")[0], Component: pages[page] }], { initialEntries: [url] });
  const client = await clientWith(page, held);
  return renderToStaticMarkup(createElement(rq.QueryClientProvider, { client }, createElement(rr.RouterProvider, { router })));
}

const DATA: Record<PageName, Record<string, unknown>> = {
  services: { services: [{ id: "s1", title: "Career chat" }] },
  availability: { timezone: "Asia/Kolkata", rules: [], blocked: [] },
  payouts: { account: null, summary: { currencies: [], history: [] }, feePercentText: "10%" },
  settings: { profile: { name: "Pat", slug: "pat" }, google: { state: "not-connected" }, whatsapp: null, embedded: null, whatsappRequired: false, origin: "example.com", email: "pat@example.com", emailVerified: true },
  onboarding: { profile: { name: "Pat", slug: "pat" }, services: [], rules: [], blocked: [], google: { state: "not-connected" }, whatsapp: null, embedded: null, payout: null, checklist: [], publicUrl: "https://example.com/pat", email: "pat@example.com", emailVerified: false },
};

/* ---------- the four pages inside the dashboard frame ---------- */

test("Services, Availability, Payouts and Settings: the title, and the view gets exactly the data of the page's query", async () => {
  for (const page of ["services", "availability", "payouts", "settings"] as const) {
    const html = await renderPage(page, URL_OF[page], { data: DATA[page] });
    assert.ok(html.includes(`<title>${TITLE[page]}</title>`), `${page}: title in ${html.slice(0, 160)}`);
    assert.equal(count(html, "<title>"), 1, `${page}: exactly one title`);
    const props = viewProps(html, VIEW[page]);
    assert.ok(props, `${page}: the view is rendered`);
    assert.deepEqual(props.data, DATA[page], `${page}: data`);
    // They live inside the dashboard frame, which provides main#main: the page itself must not add a second one.
    assert.equal(count(html, 'id="main"'), 0, `${page}: no own main landmark`);
    assert.ok(!html.includes("aria-busy"), `${page}: no skeleton with data`);
  }
});

test("Settings: ?google=<outcome> reaches the view as written, and only as a banner (the same data either way)", async () => {
  const at = async (url: string) => viewProps(await renderPage("settings", url, { data: DATA.settings }), "SettingsView");
  assert.equal((await at("/dashboard/settings"))?.outcome, null);
  assert.equal((await at("/dashboard/settings?google=denied"))?.outcome, "denied");
  assert.equal((await at("/dashboard/settings?google=connected-no-gmail&x=1"))?.outcome, "connected-no-gmail");
  assert.equal((await at("/dashboard/settings?google="))?.outcome, "", "a bare ?google= is passed on and has no banner text (the panel only knows its nine outcomes)");
  assert.equal((await at("/dashboard/settings?x=1"))?.outcome, null);
  for (const url of ["/dashboard/settings?google=denied", "/dashboard/settings"]) {
    assert.deepEqual((await at(url))?.data, DATA.settings, "the data does not depend on the URL (one query key)");
  }
});

test("the four pages: a skeleton while loading, a retry on a server error, the server's own text on 429, the 404 screen on 404", async () => {
  for (const page of ["services", "availability", "payouts", "settings"] as const) {
    const pending = await renderPage(page, URL_OF[page], "pending");
    assert.ok(pending.includes('aria-busy="true"') && pending.includes("Loading"), `${page}: skeleton`);
    assert.ok(pending.includes(`<title>${TITLE[page]}</title>`), `${page}: the title is there while loading too`);
    assert.equal(viewProps(pending, VIEW[page]), null, `${page}: no view without data`);

    const broken = await renderPage(page, URL_OF[page], { failed: 500 });
    assert.ok(broken.includes("Something went wrong") && broken.includes("We could not load this page") && broken.includes("Try again"), `${page}: error with retry`);
    assert.equal(viewProps(broken, VIEW[page]), null);

    const limited = await renderPage(page, URL_OF[page], { failed: 429, message: "Too many requests. Try again in 40 seconds." });
    assert.ok(limited.includes("Too many requests. Try again in 40 seconds.") && !limited.includes("Try again</button>"), `${page}: 429 shows the server's text and no retry`);

    const missing = await renderPage(page, URL_OF[page], { failed: 404 });
    assert.ok(missing.includes("This page does not exist"), `${page}: 404 screen`);
    assert.equal(count(missing, 'id="main"'), 0, `${page}: the 404 screen is embedded in the frame (no second main)`);
  }
});

/* ---------- onboarding: no dashboard frame ---------- */

test("Onboarding: ?step= and ?google= reach the wizard from the URL, and neither is part of the query key", async () => {
  const at = async (url: string) => viewProps(await renderPage("onboarding", url, { data: DATA.onboarding }), "OnboardingView");
  const none = await at("/onboarding");
  assert.equal(none?.step, 0);
  assert.equal(none?.outcome, null);
  assert.deepEqual(none?.data, DATA.onboarding);
  const three = await at("/onboarding?step=3&google=denied");
  assert.equal(three?.step, 3);
  assert.equal(three?.outcome, "denied");
  assert.deepEqual(three?.data, DATA.onboarding, "the same data under any step and outcome: one query key, no skeleton on a step change");
  assert.equal((await at("/onboarding?step=abc"))?.step, 0, "Number(...) || 0, as the old page did");
  assert.equal((await at("/onboarding?step=6&google=missing-permission"))?.outcome, "missing-permission");
  assert.equal((await at("/onboarding?step=7"))?.step, 7, "an out-of-range step is passed on and clamped by the wizard");
  assert.equal((await at("/onboarding?step="))?.step, 0);
});

test("Onboarding: the loading and error frame has NO main#main (the wizard's own is the one FocusOnNavigate must find), the loaded page has exactly one", async () => {
  const url = "/onboarding?step=2";
  const title = `<title>${TITLE.onboarding}</title>`;

  const pending = await renderPage("onboarding", url, "pending");
  assert.ok(pending.includes(title) && pending.includes('aria-busy="true"'), "title and skeleton while loading");
  assert.ok(pending.includes('class="focused"') && pending.includes("focused__card") && pending.includes('class="wordmark"'), "a framed skeleton with the brand header");
  assert.equal(count(pending, 'id="main"'), 0, "no temporary main landmark: focus would land on it and fall to <body> when it is removed");
  assert.equal(count(pending, "<main"), 0, "no main element at all while loading");

  const broken = await renderPage("onboarding", url, { failed: 500 });
  assert.ok(broken.includes("Something went wrong") && broken.includes("Try again"), "an error alert with a retry");
  assert.ok(broken.includes("focused__card"), "inside the frame");
  assert.equal(count(broken, 'id="main"'), 0);

  const loaded = await renderPage("onboarding", url, { data: DATA.onboarding });
  assert.equal(count(loaded, 'id="main"'), 1, "the wizard's own main landmark, once");
  assert.ok(!loaded.includes("focused__card") && !loaded.includes("aria-busy"), "the loading frame is gone");
  assert.ok(loaded.includes(title));
});

test("Onboarding: a ?step= change after the first render refetches the page's data (what each router.replace did in Next); the first render does not", () => {
  const source = readFileSync(path.resolve(__dirname, "..", "web/src/pages/dashboard/Onboarding.tsx"), "utf8");
  assert.ok(/useRef\(step\)/.test(source), "the step shown first is remembered, so mounting does not trigger a second request");
  assert.ok(/shownStep\.current === step\) return/.test(source), "an unchanged step does nothing");
  assert.ok(/invalidateQueries\(\{ queryKey: queryKeys\.dashboard\("onboarding"\) \}\)/.test(source), "a changed step invalidates the onboarding query only");
  assert.ok(/\}, \[step, queryClient\]\)/.test(source), "the effect depends on the step");
  assert.ok(!/refetchQueries|queryClient\.invalidateQueries\(\)/.test(source), "no refetch of every query");
});

test("Onboarding: when the data arrives after FocusOnNavigate has given up, the wizard's landmark takes the focus, but only after an in-app navigation and only if nothing else has focus", () => {
  const source = readFileSync(path.resolve(__dirname, "..", "web/src/pages/dashboard/Onboarding.tsx"), "utf8");
  assert.ok(/useNavigationType\(\)/.test(source) && /navigationType === "POP"/.test(source), "not on a first load or back/forward");
  assert.ok(/document\.activeElement !== document\.body/.test(source), "never takes the focus from something the user already focused");
  assert.ok(/waitedForData/.test(source) && /main\.focus\(\{ preventScroll: true \}\)/.test(source), "only on the transition from loading to loaded, without scrolling");
});
