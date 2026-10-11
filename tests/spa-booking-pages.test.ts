// Branch spa/20-booking: the SPA PAGE components (web/src/pages/booking/*) rendered the way the browser renders them, with a memory
// router (route pattern, URL, query string) and a QueryClient holding what the endpoint answered (or the error it failed with), so a
// wrong prop, a lost `?service=`, a missing title or a 403 that should be a screen FAILS here. tests/spa-booking.test.ts covers the
// endpoints (database), this file needs no database, no browser and no network.
//
// The three client components that are imported in place (BookingFlow, PayNow, ManageBooking) are replaced by fakes that print their
// props: what a page hands to them is not visible in their real markup. `mock.module` only affects modules imported afterwards, so the
// pages are imported inside `before`. Harness details (CommonJS tests vs the ES module web/ package, the global `React`) are the same
// as in tests/spa-public-auth-pages.test.ts, which explains them.
import assert from "node:assert/strict";
import { before, mock, test } from "node:test";
import * as React from "react";
import { createElement, type ComponentType } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { QueryClient, QueryKey } from "@tanstack/react-query";
import type { PublicProfile } from "../lib/public-profile";
import type { ManageView } from "../lib/views/booking-manage";
import type { PayView } from "../lib/views/booking-pay";

type ReactRouter = typeof import("react-router");
type ReactQuery = typeof import("@tanstack/react-query");
type WebApi = typeof import("../web/src/lib/api");
type WebQuery = typeof import("../web/src/lib/query");

const fake = (name: string) => (props: Record<string, unknown>) => createElement("div", { "data-fake": name, "data-props": JSON.stringify(props) });
const unescape = (s: string) => s.replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
/** The props a fake component received, or null when it is not on the page. */
function propsOf(html: string, name: string): Record<string, unknown> | null {
  const m = new RegExp(`data-fake="${name}" data-props="([^"]*)"`).exec(html);
  return m ? (JSON.parse(unescape(m[1])) as Record<string, unknown>) : null;
}
const count = (html: string, needle: string) => html.split(needle).length - 1;

let rr: ReactRouter;
let rq: ReactQuery;
let api: WebApi;
let keys: WebQuery["queryKeys"];
type Pages = Record<"profile" | "book" | "pay" | "manage", ComponentType>;
let pages: Pages;

before(async () => {
  (globalThis as { React?: unknown }).React = React;
  rr = await import("react-router");
  rq = await import("@tanstack/react-query");
  api = await import("../web/src/lib/api");
  keys = (await import("../web/src/lib/query")).queryKeys;
  mock.module("@/app/[influencer]/book/BookingFlow", { namedExports: { BookingFlow: fake("BookingFlow") } });
  mock.module("@/app/pay/[token]/PayNow", { namedExports: { PayNow: fake("PayNow") } });
  mock.module("@/app/manage/[token]/ManageBooking", { namedExports: { ManageBooking: fake("ManageBooking") } });
  const load = async (file: string) => (await import(`../web/src/pages/booking/${file}`)).Component as ComponentType;
  pages = { profile: await load("Profile"), book: await load("Book"), pay: await load("Pay"), manage: await load("Manage") };
});

/** What the page's query holds: the endpoint's answer, nothing yet (the request is on its way), or the failure. */
type Held = { data: unknown } | { error: { status: number; body?: unknown } } | "pending";

async function clientWith(key: QueryKey, held: Held): Promise<QueryClient> {
  // retryOnMount: false, because a query that already failed would otherwise show as "pending" again on the first render.
  const client = new rq.QueryClient({ defaultOptions: { queries: { retry: false, retryOnMount: false } } });
  if (held === "pending") return client;
  if ("data" in held) {
    client.setQueryData(key, held.data);
  } else {
    const error = new api.ApiError(held.error.status, held.error.body ?? null, "/api/x");
    await client.fetchQuery({ queryKey: key, queryFn: () => Promise.reject(error), retry: false }).catch(() => undefined);
  }
  return client;
}

/** Renders `Component` at `url` under the route `pattern` (so `useParams` sees `:slug` and `:token`). */
async function render(Component: ComponentType, pattern: string, url: string, key: QueryKey, held: Held): Promise<string> {
  const router = rr.createMemoryRouter([{ path: pattern, Component }], { initialEntries: [url] });
  const client = await clientWith(key, held);
  return renderToStaticMarkup(createElement(rq.QueryClientProvider, { client }, createElement(rr.RouterProvider, { router })));
}

const service = (over: Partial<PublicProfile["services"][number]> = {}): PublicProfile["services"][number] => ({
  id: "svc_1",
  title: "1:1 Career Call",
  description: "Thirty minutes, just you and me.",
  durationMin: 30,
  priceMinor: 49900,
  currency: "INR",
  type: "ONE_TO_ONE",
  capacity: 1,
  refundPolicy: "FULL",
  refundText: "Cancel any time before the session for a full refund.",
  intakeQuestions: [],
  prepNotes: null,
  requiresApproval: false,
  minNoticeHours: 0,
  maxAdvanceDays: 60,
  ...over,
});
const profile = (over: Partial<PublicProfile> = {}): PublicProfile => ({
  slug: "demo",
  name: "Demo Creator",
  bio: "Line one\nLine two",
  photoUrl: null,
  timezone: "Asia/Kolkata",
  preview: false,
  blockers: [],
  services: [service(), service({ id: "svc_2", title: "Small Group Workshop", type: "GROUP", capacity: 5, priceMinor: 19900 })],
  ...over,
});

test("profile page: title, one main and one h1, every service with a Book link that carries its id", async () => {
  const html = await render(pages.profile, "/:slug", "/demo", keys.publicProfile("demo"), { data: profile() });
  assert.ok(html.includes("<title>Book a session with Demo Creator · Session Automation</title>"));
  assert.equal(count(html, '<main id="main"'), 1);
  assert.equal(count(html, "<h1"), 1);
  assert.ok(html.includes("Demo Creator</h1>") && html.includes("Line one\nLine two"), "the bio keeps its line break");
  assert.ok(html.includes("1:1 Career Call") && html.includes("Small Group Workshop") && html.includes("Group, up to 5"));
  assert.ok(html.includes('href="/demo/book?service=svc_1"') && html.includes('href="/demo/book?service=svc_2"'));
  assert.ok(html.includes("Payments by Razorpay.") && html.includes('href="/refund-policy"'));
  assert.ok(!html.includes("Only you can see this page"), "no preview banner on a live page");

  const odd = await render(pages.profile, "/:slug", "/demo", keys.publicProfile("demo"), { data: profile({ services: [service({ id: "a b/c" })] }) });
  assert.ok(odd.includes('href="/demo/book?service=a%20b%2Fc"'), "the id is encoded in the link");

  const empty = await render(pages.profile, "/:slug", "/demo", keys.publicProfile("demo"), { data: profile({ services: [], bio: null }) });
  assert.ok(empty.includes("No sessions to book right now") && empty.includes("Check back soon."));
});

test("profile page: the owner's preview shows the banner and what is still missing", async () => {
  const html = await render(pages.profile, "/:slug", "/demo", keys.publicProfile("demo"), {
    data: profile({ preview: true, blockers: ["Connect Google Calendar", "Verify your email"] }),
  });
  assert.ok(html.includes("Only you can see this page until it is ready for customers."));
  assert.ok(html.includes("Still to do: Connect Google Calendar, Verify your email."));
  const none = await render(pages.profile, "/:slug", "/demo", keys.publicProfile("demo"), { data: profile({ preview: true, blockers: [] }) });
  assert.ok(none.includes("Only you can see this page") && !none.includes("Still to do"));
});

test("profile page: loading keeps the server's title, 404 is the not-found screen, other failures offer a retry", async () => {
  const key = keys.publicProfile("demo");
  const pending = await render(pages.profile, "/:slug", "/demo", key, "pending");
  assert.ok(!pending.includes("<title>"), "no title of its own until the host's name is known");
  assert.ok(pending.includes('aria-busy="true"'));
  // QA-1: the loading state sits in the public frame (brand header, one `main#main` for the skip link and the focus move),
  // not bare in the corner of the window.
  assert.ok(pending.includes('class="site-header"') && count(pending, '<main id="main"') === 1 && pending.includes("container--narrow"));
  // M1: that frame's `main` is a PLACEHOLDER: FocusOnNavigate skips it (web/src/lib/focus-main.ts), because the real page replaces it and
  // a focused placeholder would drop the focus to <body>. The real page and the 404 screen are not placeholders.
  assert.match(pending, /<main id="main"[^>]*data-placeholder=""/);
  const loaded = await render(pages.profile, "/:slug", "/demo", key, { data: profile() });
  assert.ok(!loaded.includes("data-placeholder"), "the real page's main can be focused");

  const notFound = await render(pages.profile, "/:slug", "/demo", key, { error: { status: 404, body: { error: "Not found" } } });
  assert.ok(notFound.includes("<title>Not found · Session Automation</title>"));
  assert.ok(notFound.includes("This page does not exist") && count(notFound, '<main id="main"') === 1);
  assert.ok(!notFound.includes("data-placeholder"), "the 404 screen is a real page: it takes the focus");

  const failed = await render(pages.profile, "/:slug", "/demo", key, { error: { status: 500 } });
  assert.ok(failed.includes("Something went wrong") && failed.includes("Try again"));
  // QA-1: the failure keeps the page in its frame, and does not leave the previous page's title in the tab.
  assert.ok(failed.includes("<title>Something went wrong · Session Automation</title>"));
  assert.ok(failed.includes('class="site-header"') && count(failed, '<main id="main"') === 1);
  const limited = await render(pages.profile, "/:slug", "/demo", key, { error: { status: 429, body: { error: "Too many requests. Slow down." } } });
  assert.ok(limited.includes("Too many requests. Slow down.") && !limited.includes("Try again"));
});

test("book page: `?service=` reaches the booking flow, the host and the services come from the profile, preview is passed on", async () => {
  const key = keys.publicProfile("demo");
  const html = await render(pages.book, "/:slug/book", "/demo/book?service=svc_2", key, { data: profile() });
  assert.ok(html.includes("<title>Book Demo Creator · Session Automation</title>"));
  assert.equal(count(html, '<main id="main"'), 1);
  assert.ok(html.includes('href="/demo"') && html.includes("Demo Creator’s page"));
  const flow = propsOf(html, "BookingFlow");
  assert.ok(flow);
  assert.equal(flow.initialServiceId, "svc_2");
  assert.equal(flow.preview, false);
  assert.deepEqual(flow.host, { name: "Demo Creator", photoUrl: null, slug: "demo", timezone: "Asia/Kolkata" });
  assert.deepEqual((flow.services as Array<{ id: string }>).map((s) => s.id), ["svc_1", "svc_2"]);
  assert.ok(!html.includes("Holding a slot is disabled"));

  assert.equal(propsOf(await render(pages.book, "/:slug/book", "/demo/book", key, { data: profile() }), "BookingFlow")?.initialServiceId, null, "no ?service= is null");
  assert.equal(propsOf(await render(pages.book, "/:slug/book", "/demo/book?service=", key, { data: profile() }), "BookingFlow")?.initialServiceId, "", "an empty one stays empty, as in the old page");

  const preview = await render(pages.book, "/:slug/book", "/demo/book", key, { data: profile({ preview: true, blockers: ["Connect Google Calendar"] }) });
  assert.equal(propsOf(preview, "BookingFlow")?.preview, true);
  assert.ok(preview.includes("Holding a slot is disabled until your page is live.") && preview.includes("Still to do: Connect Google Calendar."));
});

test("book page: loading, not found and failures behave like the profile page", async () => {
  const key = keys.publicProfile("demo");
  const pending = await render(pages.book, "/:slug/book", "/demo/book", key, "pending");
  assert.ok(!pending.includes("<title>") && propsOf(pending, "BookingFlow") === null);
  const notFound = await render(pages.book, "/:slug/book", "/demo/book", key, { error: { status: 404 } });
  assert.ok(notFound.includes("<title>Not found · Session Automation</title>") && notFound.includes("This page does not exist"));
  assert.ok((await render(pages.book, "/:slug/book", "/demo/book", key, { error: { status: 503 } })).includes("Try again"));
});

const PAY_TITLE = "<title>Complete your booking · Session Automation</title>";
const payPage = (token: string, held: Held) => render(pages.pay, "/pay/:token", `/pay/${encodeURIComponent(token)}`, keys.pay(token), held);

test("pay page: every state of the booking is a screen with the old page's words, links and one h1", async () => {
  const states: Array<[PayView, string, string[]]> = [
    [{ state: "invalid" }, "This link has expired", ["The payment link is invalid or has expired."]],
    [{ state: "not-found" }, "Booking not found", ["We could not find this booking."]],
    [
      { state: "booked", serviceTitle: "Career Call", hostName: "Demo Creator", whenText: "Mon, 12 Oct 2026, 10:00 am IST", manageUrl: "https://app.example/manage/tok" },
      "You&#x27;re already booked",
      ["Career Call with Demo Creator, Mon, 12 Oct 2026, 10:00 am IST.", 'href="https://app.example/manage/tok"', "Manage your booking"],
    ],
    [{ state: "requested", hostName: "Demo Creator", serviceTitle: "Career Call" }, "Still waiting for approval", ["Demo Creator has not answered your request for Career Call yet."]],
    [{ state: "declined", hostName: "Demo Creator", hostSlug: "demo" }, "This request was not accepted", ["Demo Creator could not accept this request.", 'href="/demo/book"', "Choose another time"]],
    // QA-6 / M2: money behind the booking: never "You have not been charged", never "request the session again", never a pay button
    [{ state: "cancelled", hostName: "Demo Creator", hostSlug: "demo", refund: "on-its-way" }, "This booking was cancelled", ["A refund is on its way to your original payment method.", 'href="/demo/book"', "Book another time"]],
    [{ state: "cancelled", hostName: "Demo Creator", hostSlug: "demo", refund: "issued" }, "This booking was cancelled", ["your payment has been refunded to your original payment method"]],
    [{ state: "cancelled", hostName: "Demo Creator", hostSlug: "demo", refund: "none" }, "This booking was cancelled", ["Under its cancellation policy no refund is due"]],
    [{ state: "not-completed" }, "Payment received, but your booking could not be completed", ["you will be refunded. Please do not pay again."]],
    [{ state: "expired", hostSlug: "demo" }, "The time to pay has passed", ["The held time was released.", 'href="/demo/book"', "Request the session again"]],
  ];
  for (const [data, heading, texts] of states) {
    const html = await payPage("tok", { data });
    assert.ok(html.includes(PAY_TITLE), data.state);
    assert.equal(count(html, '<main id="main"'), 1, data.state);
    assert.ok(!html.includes("data-placeholder"), `${data.state}: a real state takes the focus`);
    assert.equal(count(html, "<h1"), 1, data.state);
    assert.ok(html.includes(`${heading}</h1>`), `${data.state}: ${heading}`);
    for (const t of texts) assert.ok(html.includes(t), `${data.state}: ${t}`);
    assert.equal(propsOf(html, "PayNow"), null, `${data.state}: no payment button`);
    if (data.state === "cancelled" || data.state === "not-completed") {
      for (const wrong of ["not been charged", "Request the session again", "time to pay has passed", "not accepted"]) assert.ok(!html.includes(wrong), `${data.state}: must not say "${wrong}"`);
    }
  }
  const noLink = await payPage("tok", { data: { state: "booked", serviceTitle: "Career Call", hostName: "Demo Creator", whenText: "Mon", manageUrl: null } });
  assert.ok(noLink.includes("Career Call with Demo Creator, Mon.") && !noLink.includes("Manage your booking"), "no link when none could be built");
});

test("pay page: a payable booking shows the summary and hands exactly the fields PayNow needs to it", async () => {
  const payable: PayView = {
    state: "payable",
    bookingId: "bk_1",
    pollToken: "poll.tok",
    hostName: "Demo Creator",
    serviceTitle: "Career Call",
    whenText: "Mon, 12 Oct 2026, 10:00 am IST",
    amountText: "₹499.00",
    payByText: "Tue, 13 Oct 2026, 10:00 am IST",
    prepNotes: "Bring your CV",
  };
  const html = await payPage("tok", { data: payable });
  assert.ok(html.includes(PAY_TITLE) && html.includes("Complete your booking</h1>") && count(html, "<h1") === 1);
  assert.ok(html.includes("Demo Creator approved your request. Pay to confirm Career Call."));
  assert.ok(html.includes("<dt>When</dt><dd>Mon, 12 Oct 2026, 10:00 am IST</dd>") && html.includes('<dd class="money">₹499.00</dd>'));
  assert.ok(html.includes("Before your session") && html.includes("Bring your CV"));
  assert.deepEqual(propsOf(html, "PayNow"), {
    bookingId: "bk_1",
    pollToken: "poll.tok",
    hostName: "Demo Creator",
    serviceTitle: "Career Call",
    amountText: "₹499.00",
    payByText: "Tue, 13 Oct 2026, 10:00 am IST",
  });
  const plain = await payPage("tok", { data: { ...payable, prepNotes: null } });
  assert.ok(!plain.includes("Before your session"), "no notes, no box");
});

test("pay page: loading and failures keep the page title; a token with special characters is read from the path decoded", async () => {
  const pending = await payPage("tok", "pending");
  assert.ok(pending.includes(PAY_TITLE) && pending.includes('aria-busy="true"'));
  const failed = await payPage("tok", { error: { status: 500 } });
  assert.ok(failed.includes(PAY_TITLE) && failed.includes("Something went wrong") && failed.includes("Try again"));
  // QA-1: both states are drawn inside the public frame (header and one `main#main`), not bare in the corner of the window.
  for (const html of [pending, failed]) assert.ok(html.includes('class="site-header"') && count(html, '<main id="main"') === 1 && html.includes("data-placeholder"));
  // `%2E` in the URL is `.` for the page: the query key (and so the request) is built from the decoded token.
  const token = "abc.def-ghi_jkl";
  const router = rr.createMemoryRouter([{ path: "/pay/:token", Component: pages.pay }], { initialEntries: ["/pay/abc%2Edef-ghi_jkl"] });
  const client = await clientWith(keys.pay(token), { data: { state: "invalid" } });
  const html = renderToStaticMarkup(createElement(rq.QueryClientProvider, { client }, createElement(rr.RouterProvider, { router })));
  assert.ok(html.includes("This link has expired</h1>"), "found the cached answer of the DECODED token");
});

const MANAGE_TITLE = "<title>Manage your booking · Session Automation</title>";
const managePage = (held: Held) => render(pages.manage, "/manage/:token", "/manage/tok", keys.manage("tok"), held);

test("manage page: an ok answer renders the booking component with the whole booking, the notices come from 403 and 404", async () => {
  const booking = {
    token: "tok",
    bookingId: "bk_1",
    serviceId: "svc_1",
    serviceTitle: "Career Call",
    serviceType: "ONE_TO_ONE" as const,
    durationMin: 30,
    influencerName: "Demo Creator",
    customerName: "Asha Rao",
    status: "PAID",
    startTime: "2026-10-12T04:30:00.000Z",
    meetLink: null,
    canManage: true,
    canReschedule: true,
    refundPolicyText: "Cancel any time before the session for a full refund.",
    cancelRefundText: "If you cancel now, you will be refunded in full to your original payment method.",
  };
  const ok: ManageView = { state: "ok", booking };
  const html = await managePage({ data: ok });
  assert.ok(html.includes(MANAGE_TITLE));
  assert.deepEqual(propsOf(html, "ManageBooking"), { data: booking });

  const expired = await managePage({ error: { status: 403, body: { state: "expired" } } });
  assert.ok(expired.includes(MANAGE_TITLE) && expired.includes("Manage your booking</h1>") && count(expired, "<h1") === 1 && count(expired, '<main id="main"') === 1);
  assert.ok(expired.includes("This link has expired") && expired.includes("For your security, management links expire."));
  assert.equal(propsOf(expired, "ManageBooking"), null);

  const gone = await managePage({ error: { status: 404, body: { state: "not-found" } } });
  assert.ok(gone.includes("We could not find this booking") && gone.includes("It may have been removed."));
  assert.ok(!gone.includes("This page does not exist"), "a missing booking is not the 404 screen");
});

test("manage page: a 403 that is not the endpoint's own answer, and every other failure, is an error with a retry", async () => {
  for (const held of [{ error: { status: 403 } }, { error: { status: 403, body: { state: "something-else" } } }, { error: { status: 500 } }] as Held[]) {
    const html = await managePage(held);
    assert.ok(html.includes(MANAGE_TITLE) && html.includes("Something went wrong"), JSON.stringify(held));
    assert.ok(!html.includes("This link has expired") && !html.includes("We could not find this booking"), JSON.stringify(held));
  }
  // A 404 without the endpoint's `state` did not come from the endpoint (a proxy, a missing route): the generic not-found screen.
  const stray = await managePage({ error: { status: 404, body: { error: "Not found" } } });
  assert.ok(stray.includes(MANAGE_TITLE) && stray.includes("This page does not exist"));
  const pending = await managePage("pending");
  assert.ok(pending.includes(MANAGE_TITLE) && pending.includes('aria-busy="true"'));
  // QA-1: loading and failure are drawn inside the public frame, with exactly one `main#main`.
  const failed = await managePage({ error: { status: 500 } });
  for (const html of [pending, failed]) assert.ok(html.includes('class="site-header"') && count(html, '<main id="main"') === 1);
});

test("manage page: sets the no-referrer policy itself in every state, so a soft navigation from the pay page cannot leak the token", async () => {
  // The Referrer-Policy header the shell sends only exists after a full page load; the pay page's "Manage your booking" link is a
  // client-side navigation, so the page puts the policy into the head (React hoists the <meta> and removes it when the page goes).
  const meta = '<meta name="referrer" content="no-referrer"/>';
  const okView: ManageView = {
    state: "ok",
    booking: {
      token: "tok",
      bookingId: "bk_1",
      serviceId: "svc_1",
      serviceTitle: "Career Call",
      serviceType: "ONE_TO_ONE",
      durationMin: 30,
      influencerName: "Demo Creator",
      customerName: "Asha Rao",
      status: "PAID",
      startTime: "2026-10-12T04:30:00.000Z",
      meetLink: null,
      canManage: true,
      canReschedule: true,
      refundPolicyText: "Cancel any time before the session for a full refund.",
      cancelRefundText: null,
    },
  };
  const states: Array<[string, Held]> = [
    ["ok", { data: okView }],
    ["expired", { error: { status: 403, body: { state: "expired" } } }],
    ["not-found", { error: { status: 404, body: { state: "not-found" } } }],
    ["loading", "pending"],
    ["failed", { error: { status: 500 } }],
  ];
  for (const [label, held] of states) {
    const html = await managePage(held);
    assert.equal(count(html, meta), 1, `${label}: exactly one referrer policy meta`);
  }
});
