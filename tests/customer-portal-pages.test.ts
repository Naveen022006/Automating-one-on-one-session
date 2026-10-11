// WP-D: the two customer pages (web/src/pages/booking/FindBookings.tsx, CustomerPortal.tsx) and the receipt card, rendered the way the
// browser renders them (memory router + a QueryClient holding what the endpoint answered), in the style of tests/spa-booking-pages.test.ts:
// no database, no browser, no network. Each state of the portal is checked here; the endpoint behind it is tests/customer-portal.test.ts.
import assert from "node:assert/strict";
import { before, test } from "node:test";
import * as React from "react";
import { createElement, type ComponentType } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { QueryClient, QueryKey } from "@tanstack/react-query";
import { SPA_ROUTES } from "../lib/spa/routes";
import type { ReceiptView } from "../lib/receipts";
import type { CustomerPortalView } from "../lib/views/customer-portal";

type ReactRouter = typeof import("react-router");
type ReactQuery = typeof import("@tanstack/react-query");
type WebApi = typeof import("../web/src/lib/api");
type WebQuery = typeof import("../web/src/lib/query");

const count = (html: string, needle: string) => html.split(needle).length - 1;
const routeTitle = (id: string) => (SPA_ROUTES.find((r) => r.id === id) as { title: string }).title;

let rr: ReactRouter;
let rq: ReactQuery;
let api: WebApi;
let keys: WebQuery["queryKeys"];
let find: ComponentType;
let portal: ComponentType;
let ReceiptCard: ComponentType<{ receipt: ReceiptView }>;

before(async () => {
  (globalThis as { React?: unknown }).React = React;
  rr = await import("react-router");
  rq = await import("@tanstack/react-query");
  api = await import("../web/src/lib/api");
  keys = (await import("../web/src/lib/query")).queryKeys;
  find = (await import("../web/src/pages/booking/FindBookings")).Component as ComponentType;
  portal = (await import("../web/src/pages/booking/CustomerPortal")).Component as ComponentType;
  ReceiptCard = (await import("../web/src/components/views/booking/ReceiptCard")).ReceiptCard as ComponentType<{ receipt: ReceiptView }>;
});

type Held = { data: unknown } | { error: { status: number; body?: unknown } } | "pending";

async function clientWith(key: QueryKey, held: Held): Promise<QueryClient> {
  const client = new rq.QueryClient({ defaultOptions: { queries: { retry: false, retryOnMount: false } } });
  if (held === "pending") return client;
  if ("data" in held) client.setQueryData(key, held.data);
  else {
    const error = new api.ApiError(held.error.status, held.error.body ?? null, "/api/x");
    await client.fetchQuery({ queryKey: key, queryFn: () => Promise.reject(error), retry: false }).catch(() => undefined);
  }
  return client;
}

async function render(Component: ComponentType, pattern: string, url: string, key: QueryKey, held: Held): Promise<string> {
  const router = rr.createMemoryRouter([{ path: pattern, Component }], { initialEntries: [url] });
  const client = await clientWith(key, held);
  return renderToStaticMarkup(createElement(rq.QueryClientProvider, { client }, createElement(rr.RouterProvider, { router })));
}

const TOKEN = "tok_ABCDEFGHIJKLMNOPQRSTUVWXYZ_-0123456789";
/** The opening tag of the "Erase my data" button, to see whether it is disabled. */
function eraseButtonTag(html: string): string {
  const before = html.split("Erase my data")[0];
  const open = before.lastIndexOf("<button");
  return before.slice(open, before.indexOf(">", open) + 1);
}
const portalPage = (held: Held) => render(portal, "/bookings/:token", `/bookings/${TOKEN}`, keys.customerPortal(TOKEN), held);

const receipt = (over: Partial<ReceiptView> = {}): ReceiptView => ({
  reference: "bk_1",
  issuedTo: "Asha Rao",
  seller: "Session Automation",
  hostName: "Demo Creator",
  serviceTitle: "Career call",
  sessionStart: "2026-10-20T10:00:00.000Z",
  paidAt: "2026-10-11T08:30:00.000Z",
  amountMinor: 49900,
  currency: "INR",
  paymentReference: "pay_abc123",
  refundedMinor: 0,
  statusText: "Paid",
  ...over,
});

type Ok = Extract<CustomerPortalView, { state: "ok" }>;
const booking = (over: Partial<Ok["bookings"][number]> = {}): Ok["bookings"][number] => ({
  reference: "bk_1",
  influencerName: "Demo Creator",
  serviceTitle: "Career call",
  startTime: "2026-10-20T10:00:00.000Z",
  durationMin: 30,
  status: "SCHEDULED",
  statusText: "Upcoming",
  manageUrl: "http://localhost:3000/manage/abc.def",
  receipt: receipt(),
  ...over,
});
const okView = (over: Partial<Ok> = {}): CustomerPortalView => ({
  state: "ok",
  email: "asha@example.com",
  expiresAt: "2026-10-11T12:00:00.000Z",
  bookings: [booking(), booking({ reference: "bk_2", serviceTitle: "Portfolio review", status: "COMPLETED", statusText: "Completed", manageUrl: null, startTime: "2026-09-01T10:00:00.000Z" })],
  erasable: 1,
  blocked: 1,
  ...over,
});

test("find page: the route's title, one form with an e-mail field, no data, a note on what the link allows", async () => {
  const html = await render(find, "/bookings", "/bookings", keys.session(), "pending");
  assert.ok(html.includes(`<title>${routeTitle("customer-bookings")} · Session Automation</title>`));
  assert.equal(count(html, "<h1"), 1);
  assert.equal(count(html, '<main id="main"'), 1);
  assert.equal(count(html, "<form"), 1);
  assert.ok(/<input[^>]*id="find-email"[^>]*type="email"|<input[^>]*type="email"[^>]*id="find-email"/.test(html));
  assert.ok(html.includes('autoComplete="email"') || html.includes('autocomplete="email"'));
  assert.ok(html.includes("E-mail me a link"));
  assert.ok(html.includes("keep it to yourself") && html.includes('href="/privacy"'));
  assert.ok(!html.includes("Coming soon"));
  assert.ok(!html.includes('name="referrer"'), "no token on this page, so no special policy");
});

test("portal page: the route's title and the no-referrer policy in every state", async () => {
  const meta = '<meta name="referrer" content="no-referrer"/>';
  const states: Array<[string, Held]> = [
    ["ok", { data: okView() }],
    ["expired", { error: { status: 403, body: { state: "expired" } } }],
    ["pending", "pending"],
    ["server error", { error: { status: 500 } }],
    ["rate limited", { error: { status: 429, body: { error: "Too many requests." } } }],
  ];
  for (const [label, held] of states) {
    const html = await portalPage(held);
    assert.ok(html.includes(`<title>${routeTitle("customer-portal")} · Session Automation</title>`), label);
    assert.ok(html.includes(meta), `${label}: no-referrer`);
    assert.equal(count(html, '<main id="main"'), 1, label);
    if (label === "ok" || label === "expired") assert.equal(count(html, "<h1"), 1, label);
  }
});

test("portal page: an expired, unknown or foreign link is a screen with a way back, not an error", async () => {
  const html = await portalPage({ error: { status: 403, body: { state: "expired" } } });
  assert.ok(html.includes("This link has expired") && html.includes("these links work for 60 minutes"));
  assert.ok(html.includes('href="/bookings"') && html.includes("Get a new link"));
  assert.ok(!html.includes("Erase my data") && !html.includes("Download my data"));
  // A 403 that is not the endpoint's own answer, and any other failure, is an error with a retry.
  for (const held of [{ error: { status: 403 } }, { error: { status: 403, body: { state: "other" } } }, { error: { status: 500 } }] as Held[]) {
    const bad = await portalPage(held);
    assert.ok(bad.includes("Something went wrong") && !bad.includes("This link has expired"), JSON.stringify(held));
  }
  const limited = await portalPage({ error: { status: 429, body: { error: "Too many requests. Wait a minute." } } });
  assert.ok(limited.includes("Too many requests. Wait a minute."));
});

test("portal page: the list, the manage link, closed receipts, the data card", async () => {
  const html = await portalPage({ data: okView() });
  assert.ok(html.includes("<strong>asha@example.com</strong>"));
  assert.ok(html.includes("Upcoming") && html.includes("Past and cancelled"));
  assert.equal(count(html, "<li "), 2);
  // The manage link follows the path of the server's URL, only for a manage link, and only on the upcoming booking.
  assert.equal(count(html, 'href="/manage/abc.def"'), 1);
  assert.ok(!html.includes("localhost:3000"));
  // Receipts start closed.
  assert.equal(count(html, ">Receipt<"), 2);
  assert.ok(html.includes('aria-expanded="false"') && !html.includes('class="receipt"') && !html.includes("Print receipt"));
  // The data card: a download link (a plain anchor, with the token only in the path) and an erase button.
  assert.ok(html.includes(`href="/api/customer/portal/${TOKEN}/export" download=""`));
  assert.ok(html.includes("Download my data (JSON)") && html.includes("Erase my data"));
  assert.ok(eraseButtonTag(html).startsWith("<button") && !eraseButtonTag(html).includes("disabled"), "erase is available while something is erasable");
  assert.equal(count(html, "<h1"), 1);
});

test("portal page: a manage URL that is not a /manage/ link is not followed; markup in server text is escaped", async () => {
  const html = await portalPage({
    data: okView({
      bookings: [booking({ manageUrl: "https://evil.example/steal?x=1", serviceTitle: "<img src=x onerror=alert(1)>", influencerName: "<script>alert(1)</script>" })],
    }),
  });
  assert.ok(!html.includes("evil.example") && !html.includes(">Manage<"));
  assert.ok(!html.includes("<img src=x") && !html.includes("<script>alert(1)"));
  assert.ok(html.includes("&lt;img src=x onerror=alert(1)&gt;") && html.includes("&lt;script&gt;alert(1)&lt;/script&gt;"));
  const unparsable = await portalPage({ data: okView({ bookings: [booking({ manageUrl: "not a url" })] }) });
  assert.ok(!unparsable.includes(">Manage<"));
});

test("portal page: no paid bookings, nothing to erase, or nothing left", async () => {
  const empty = await portalPage({ data: okView({ bookings: [], erasable: 2, blocked: 0 }) });
  assert.ok(empty.includes("No paid bookings") && empty.includes("Download my data (JSON)"));
  assert.ok(!empty.includes("Past and cancelled") && !empty.includes("Upcoming"));
  const kept = await portalPage({ data: okView({ bookings: [booking()], erasable: 0, blocked: 1 }) });
  assert.ok(eraseButtonTag(kept).includes("disabled"), "erase is disabled when nothing can be erased");
  assert.ok(kept.includes("Your upcoming bookings keep their details until they are cancelled."));
  const none = await portalPage({ data: okView({ bookings: [], erasable: 0, blocked: 0 }) });
  assert.ok(none.includes("There is nothing left to erase."));
  // The confirmation is closed until asked for, and says what is erased and what is kept.
  assert.ok(!none.includes("Erase your data?"));
});

test("receipt card: every field, the refund row only when something was refunded, the print button, escaped text", () => {
  const html = renderToStaticMarkup(createElement(ReceiptCard, { receipt: receipt() }));
  for (const needle of ["Career call", "Demo Creator", "Asha Rao", "bk_1", "pay_abc123", "Session Automation", "Paid", "Print receipt", "Receipt for", "Payment reference", "Booking reference"]) {
    assert.ok(html.includes(needle), needle);
  }
  assert.ok(html.includes("₹") && html.includes("499"), "the amount in rupees");
  assert.ok(!html.includes("Refunded"), "no refund row without a refund");
  assert.equal(count(html, 'class="receipt"'), 1);
  assert.ok(html.includes("no-print"), "the print button is left out of the printout");

  const refunded = renderToStaticMarkup(createElement(ReceiptCard, { receipt: receipt({ refundedMinor: 10000, statusText: "Partly refunded" }) }));
  assert.ok(refunded.includes("<dt>Refunded</dt>") && refunded.includes("Partly refunded"));
  const noRef = renderToStaticMarkup(createElement(ReceiptCard, { receipt: receipt({ paymentReference: null }) }));
  assert.ok(!noRef.includes("Payment reference"));
  const hostile = renderToStaticMarkup(createElement(ReceiptCard, { receipt: receipt({ issuedTo: "<b>x</b>", hostName: "<i>y</i>", serviceTitle: "\"><script>1</script>" }) }));
  assert.ok(!hostile.includes("<b>x") && !hostile.includes("<i>y") && !hostile.includes("<script>1"));
});
