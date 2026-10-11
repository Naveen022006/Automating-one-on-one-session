// Branch spa/10-public-auth: the SPA PAGE components (web/src/pages/{public,auth}/*) rendered the way the browser renders them, with
// a memory router (the URL and its query string) and a QueryClient holding the session answer, so a wrong prop, a lost `?next=`
// or a page that waits when it should not FAILS here. tests/spa-public-auth.test.ts covers the views themselves.
//
// The form components (components/auth/AuthForms.tsx) are replaced by fakes that print their props, because what the pages
// hand to a form (the `next` of the login form, the token of the reset form, `loggedIn` of the verify button) is not visible in
// the real markup. `mock.module` only affects modules imported afterwards, which is why this lives in its own file and the pages
// are imported inside `before`. No browser, no database, no network.
//
// Two harness details. (1) tests/ run as CommonJS under tsx, while web/ is an ES module package: a static import of
// react-router or @tanstack/react-query here would load the CommonJS build, the pages load the ES build, and the two
// would not share their React context ("useLocation() may be used only in the context of a <Router>"). So everything from web/
// and those two libraries is loaded with a dynamic import, exactly like the pages do. (2) tsx compiles web/ with the classic JSX
// runtime (the root tsconfig excludes it), so `React` must be a global while the pages render.
import assert from "node:assert/strict";
import { before, mock, test } from "node:test";
import * as React from "react";
import { createElement, type ComponentType } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { QueryClient } from "@tanstack/react-query";
import type { SessionView } from "../lib/views/session";

type ReactRouter = typeof import("react-router");
type ReactQuery = typeof import("@tanstack/react-query");
type WebApi = typeof import("../web/src/lib/api");
type WebQuery = typeof import("../web/src/lib/query");

const ANON: SessionView = { authenticated: false };
const signedIn = (emailVerified: boolean): SessionView => ({
  authenticated: true,
  user: { email: "host@example.com", emailVerified, name: "Host", slug: "host", onboarded: true },
});

/** A form stand-in that prints its name and props (JSON, so the test can read them back). */
const fakeForm = (name: string) => (props: Record<string, unknown>) => createElement("div", { "data-form": name, "data-props": JSON.stringify(props) });
const unescape = (s: string) => s.replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

/** The props a fake form received, or null when that form is not on the page. */
function formProps(html: string, name: string): Record<string, unknown> | null {
  const m = new RegExp(`data-form="${name}" data-props="([^"]*)"`).exec(html);
  return m ? (JSON.parse(unescape(m[1])) as Record<string, unknown>) : null;
}
const count = (html: string, needle: string) => html.split(needle).length - 1;

let rr: ReactRouter;
let rq: ReactQuery;
let api: WebApi;
let keys: WebQuery["queryKeys"];

type Pages = Record<"landing" | "terms" | "privacy" | "refund" | "contact" | "login" | "register" | "forgot" | "reset" | "verify", ComponentType>;
let pages: Pages;

before(async () => {
  (globalThis as { React?: unknown }).React = React;
  rr = await import("react-router");
  rq = await import("@tanstack/react-query");
  api = await import("../web/src/lib/api");
  keys = (await import("../web/src/lib/query")).queryKeys;
  mock.module("@web/components/auth/AuthForms", {
    namedExports: {
      LoginForm: fakeForm("LoginForm"),
      RegisterForm: fakeForm("RegisterForm"),
      ForgotForm: fakeForm("ForgotForm"),
      ResetForm: fakeForm("ResetForm"),
      VerifyEmail: fakeForm("VerifyEmail"),
      ResendVerification: fakeForm("ResendVerification"),
    },
  });
  const load = async (file: string) => (await import(`../web/src/pages/${file}`)).Component as ComponentType;
  pages = {
    landing: await load("public/Landing"),
    terms: await load("public/Terms"),
    privacy: await load("public/Privacy"),
    refund: await load("public/RefundPolicy"),
    contact: await load("public/Contact"),
    login: await load("auth/Login"),
    register: await load("auth/Register"),
    forgot: await load("auth/ForgotPassword"),
    reset: await load("auth/ResetPassword"),
    verify: await load("auth/VerifyEmail"),
  };
});

/** What the session query holds: a normal answer, nothing yet (the request is still on its way), or a failure. */
type Session = SessionView | "pending" | "failed";

async function clientWith(session: Session): Promise<QueryClient> {
  // retryOnMount: false, because a query that already failed would otherwise show as "pending" again on the first render (it is
  // retried on mount); here "failed" has to mean the check ran and the answer was an error.
  const client = new rq.QueryClient({ defaultOptions: { queries: { retry: false, retryOnMount: false } } });
  if (session === "failed") {
    await client.fetchQuery({ queryKey: keys.session(), queryFn: () => Promise.reject(new api.ApiError(500, null, "/api/auth/session")), retry: false }).catch(() => undefined);
  } else if (session !== "pending") {
    client.setQueryData(keys.session(), session);
  }
  return client;
}

/** Renders one page component at `url` (path and query string) under a memory router and the given QueryClient. */
async function renderPage(Component: ComponentType, url: string, session: Session = ANON): Promise<string> {
  const router = rr.createMemoryRouter([{ path: url.split("?")[0], Component }], { initialEntries: [url] });
  const client = await clientWith(session);
  return renderToStaticMarkup(createElement(rq.QueryClientProvider, { client }, createElement(rr.RouterProvider, { router })));
}

test("every page sets its document title and renders one main landmark with one h1", async () => {
  const cases: [keyof Pages, string, string][] = [
    ["landing", "/", "Session Automation: get paid for your time, send the Meet link automatically"],
    ["terms", "/terms", "Terms of Service · Session Automation"],
    ["privacy", "/privacy", "Privacy Policy · Session Automation"],
    ["refund", "/refund-policy", "Refund and Cancellation Policy · Session Automation"],
    ["contact", "/contact", "Contact · Session Automation"],
    ["login", "/login", "Log in · Session Automation"],
    ["register", "/register", "Create your account · Session Automation"],
    ["forgot", "/forgot-password", "Reset your password · Session Automation"],
    ["reset", "/reset-password?token=t", "Choose a new password · Session Automation"],
    ["verify", "/verify-email?token=t", "Confirm your email · Session Automation"],
  ];
  for (const [page, url, title] of cases) {
    const html = await renderPage(pages[page], url);
    assert.ok(html.includes(`<title>${title}</title>`), `${url}: <title>${title}</title> in ${html.slice(0, 200)}`);
    assert.equal(count(html, '<main id="main"'), 1, `${url}: one main#main`);
    assert.equal(count(html, "<h1"), 1, `${url}: one h1`);
  }
});

test("login page: ?next and ?reset reach the view exactly as written; the notice needs a non-empty ?reset", async () => {
  const full = await renderPage(pages.login, "/login?next=/dashboard/sessions&reset=1");
  assert.deepEqual(formProps(full, "LoginForm"), { next: "/dashboard/sessions", notice: "Your password was changed. Please log in." });

  assert.deepEqual(formProps(await renderPage(pages.login, "/login"), "LoginForm"), {}, "no next, no notice");
  assert.deepEqual(formProps(await renderPage(pages.login, "/login?reset="), "LoginForm"), {}, "a bare ?reset= has no notice, as before");
  assert.deepEqual(formProps(await renderPage(pages.login, "/login?reset=anything"), "LoginForm"), { notice: "Your password was changed. Please log in." });
  // The page passes `next` on untouched (the API validates it with safeNextPath); an encoded value arrives decoded, once.
  const encoded = await renderPage(pages.login, "/login?next=%2Fdashboard%2Fsessions%3Fview%3Dpast");
  assert.deepEqual(formProps(encoded, "LoginForm"), { next: "/dashboard/sessions?view=past" });
  assert.ok(full.includes('href="/register"'), "link to register");
});

test("register and forgot-password pages render their form and the link to the other screen", async () => {
  const register = await renderPage(pages.register, "/register");
  assert.deepEqual(formProps(register, "RegisterForm"), {});
  assert.ok(register.includes("Create your booking page") && register.includes('href="/login"'));
  const forgot = await renderPage(pages.forgot, "/forgot-password");
  assert.deepEqual(formProps(forgot, "ForgotForm"), {});
  assert.ok(forgot.includes("Remembered it?") && forgot.includes('href="/login"'));
});

test("reset-password page: the form gets the token from the query string; without one the link is incomplete", async () => {
  const html = await renderPage(pages.reset, "/reset-password?token=abc.DEF-123_x");
  assert.deepEqual(formProps(html, "ResetForm"), { token: "abc.DEF-123_x" });
  assert.ok(!html.includes("This link is incomplete"));
  for (const url of ["/reset-password", "/reset-password?token="]) {
    const bad = await renderPage(pages.reset, url);
    assert.equal(formProps(bad, "ResetForm"), null, url);
    assert.ok(bad.includes("This link is incomplete") && bad.includes('href="/forgot-password"'), url);
  }
});

test("verify-email WITH a token renders the form at once, whatever the session query says; only `loggedIn` follows it", async () => {
  const url = "/verify-email?token=tok_123";
  const cases: [Session, boolean][] = [
    ["pending", false],
    ["failed", false],
    [ANON, false],
    [signedIn(false), true],
    [signedIn(true), true],
  ];
  for (const [session, loggedIn] of cases) {
    const html = await renderPage(pages.verify, url, session);
    const label = typeof session === "string" ? session : session.authenticated ? "signed in" : "anonymous";
    assert.deepEqual(formProps(html, "VerifyEmail"), { token: "tok_123", loggedIn }, label);
    assert.equal(count(html, "<h1"), 1, label);
    assert.ok(html.includes("Confirm your email</h1>"), label);
    assert.ok(!html.includes('role="status"') || !html.includes("Loading"), `${label}: no loading skeleton with a token`);
  }
  // An empty token is no token: the page then needs the session like the plain page does.
  const empty = await renderPage(pages.verify, "/verify-email?token=", "pending");
  assert.equal(formProps(empty, "VerifyEmail"), null);
});

test("verify-email WITHOUT a token waits for the session inside the framed page, heading included, then follows it", async () => {
  const url = "/verify-email";

  const pending = await renderPage(pages.verify, url, "pending");
  assert.ok(pending.includes("Confirm your email</h1>") && count(pending, "<h1") === 1, "heading while loading");
  assert.ok(pending.includes('aria-busy="true"') && pending.includes("Loading"), "loading state");
  assert.equal(count(pending, '<main id="main"'), 1);

  const failed = await renderPage(pages.verify, url, "failed");
  assert.ok(failed.includes("Confirm your email</h1>") && count(failed, "<h1") === 1, "heading on error");
  assert.ok(failed.includes("Something went wrong") && failed.includes("Try again"), "error alert with a retry");
  assert.equal(count(failed, '<main id="main"'), 1);

  const anon = await renderPage(pages.verify, url, ANON);
  assert.ok(anon.includes("Open the link from your email.") && anon.includes('href="/login"'));
  assert.equal(formProps(anon, "ResendVerification"), null);

  const unverified = await renderPage(pages.verify, url, signedIn(false));
  assert.ok(unverified.includes("We sent a link to host@example.com"));
  assert.deepEqual(formProps(unverified, "ResendVerification"), {});

  const verified = await renderPage(pages.verify, url, signedIn(true));
  assert.ok(!verified.includes("We sent a link") && verified.includes("Open the link from your email."));
});

test("landing page: signed-out header until the session says otherwise; a pending or failed check counts as signed out", async () => {
  for (const session of [ANON, "pending", "failed"] as Session[]) {
    const html = await renderPage(pages.landing, "/", session);
    assert.match(html, /<a [^>]*href="\/login"[^>]*>Log in<\/a>/, String(session));
    assert.ok(!html.includes("Open dashboard"), String(session));
  }
  for (const verified of [true, false]) {
    const html = await renderPage(pages.landing, "/", signedIn(verified));
    assert.match(html, /<a [^>]*href="\/dashboard"[^>]*>Open dashboard<\/a>/);
    assert.ok(!html.slice(0, html.indexOf("<main")).includes(">Log in<"));
  }
  const html = await renderPage(pages.landing, "/", ANON);
  assert.ok(!html.includes("application/ld+json"), "the JSON-LD is written by the server into the shell head");
});
