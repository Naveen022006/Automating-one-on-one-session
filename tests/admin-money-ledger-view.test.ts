// The Money page, rendered on the server from fixtures (no database, no network): the table of movements with its caption and column
// headers, what each kind of row shows, the masked references, the links, the cards, the influencer summary, the payouts not sent yet, the
// empty and the error states (the form stays), the live status line and aria-busy, the tabs and pages that keep the filter, the export
// link, and that hostile text is escaped. The navigation hooks are replaced by tests/helpers/fake-navigate.ts before the views are imported.
// It also pins the wiring of the page module and the route table row (no database needed for those either).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { before, mock, test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { jsonify, type Jsonify } from "../lib/jsonify";
import { clientHeadFor, formatTitle, spaRouteById } from "../lib/spa/routes";
import type { AdminMoneyView } from "../lib/views/admin-money";
import { assertNoSecretKeys } from "./helpers/assert-no-secret-keys";
import { fakeNavigate } from "./helpers/fake-navigate";

type Mod = {
  MoneyView: typeof import("../web/src/components/views/admin/MoneyView").MoneyView;
  MoneyProblem: typeof import("../web/src/components/views/admin/MoneyView").MoneyProblem;
  moneyHref: typeof import("../web/src/components/views/admin/MoneyView").moneyHref;
  MONEY_DEFINITIONS: typeof import("../web/src/components/views/admin/MoneyView").MONEY_DEFINITIONS;
  exportUrl: typeof import("../web/src/components/admin/ExportControls").exportUrl;
};
let m: Mod;

before(async () => {
  mock.module("@web/lib/navigate", { namedExports: fakeNavigate("/admin/money") });
  const view = await import("../web/src/components/views/admin/MoneyView");
  const controls = await import("../web/src/components/admin/ExportControls");
  m = { MoneyView: view.MoneyView, MoneyProblem: view.MoneyProblem, moneyHref: view.moneyHref, MONEY_DEFINITIONS: view.MONEY_DEFINITIONS, exportUrl: controls.exportUrl };
});

const root = path.resolve(__dirname, "..");
const read = (rel: string) => readFileSync(path.join(root, rel), "utf8");
const count = (haystack: string, needle: string) => haystack.split(needle).length - 1;
const unHtml = (s: string) => s.replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
const statusLine = (html: string) => unHtml(/<p role="status" class="sr-only">([^<]*)<\/p>/.exec(html)![1]);
const busyAttr = (html: string) => html.includes('aria-busy="true"');

type Row = AdminMoneyView["rows"][number];
const payment = (over: Partial<Row> = {}): Row => ({
  key: "payment:p1", kind: "payment", direction: "in", at: new Date("2026-10-25T13:00:00Z"), amountMinor: 105_000, feeMinor: null, currency: "INR", status: "paid",
  influencer: { id: "inf1", name: "Ina Fluencer" }, serviceTitle: "Strategy call", customerName: "Cust One", bookingId: "bk1", referenceTail: "****1234", destination: null,
  approvedBy: null, paidBy: null, payoutId: null, ...over,
});
const refund = (over: Partial<Row> = {}): Row => payment({ key: "refund:r1", kind: "refund", direction: "out", status: "processed", amountMinor: 30_000, referenceTail: "****1234", ...over });
const payout = (over: Partial<Row> = {}): Row =>
  payment({
    key: "payout:po1", kind: "payout", direction: "out", status: "paid", amountMinor: 89_550, feeMinor: 10_500, referenceTail: "****5678", destination: "UPI ****9999", approvedBy: "ann@example.com",
    paidBy: "bob@example.com", payoutId: "po1", serviceTitle: null, customerName: null, bookingId: null, ...over,
  });

const base = (over: Partial<AdminMoneyView> = {}): AdminMoneyView => ({
  from: "2026-10-01", to: "2026-10-31", type: "all", influencer: null, influencerUnknown: false, generatedAt: new Date("2026-10-31T10:00:00Z"),
  page: 1, pageSize: 50, pageCount: 1, total: 3, counts: { payments: 1, refunds: 1, payouts: 1 },
  totals: [{ currency: "INR", moneyInMinor: 105_000, paymentCount: 1, refundsOutMinor: 30_000, refundCount: 1, payoutsOutMinor: 89_550, payoutCount: 1, feesKeptMinor: 10_500, stillHeldMinor: 16_000 }],
  summary: null,
  rows: [payout(), refund(), payment()],
  scheduled: { shown: true, total: 0, sums: [], rows: [] },
  influencers: { options: [{ id: "inf1", name: "Ina Fluencer" }, { id: "inf2", name: "Bo Beta" }], truncated: false },
  ...over,
});
const render = (over: Partial<AdminMoneyView> = {}, busy?: boolean) => renderToStaticMarkup(createElement(m.MoneyView, { data: jsonify(base(over)) as Jsonify<AdminMoneyView>, busy }));

test("the table: a caption, six column headers, a data-label on every cell, and each kind of row shows its own facts", () => {
  const html = render();
  assert.equal(count(html, "<table"), 1);
  assert.ok(html.includes('<caption class="sr-only">Money movements, newest first. Times are Indian Standard Time.</caption>'));
  const header = /<thead>.*?<\/thead>/s.exec(html)![0];
  assert.deepEqual([...header.matchAll(/<th scope="col"[^>]*>(.*?)<\/th>/g)].map((x) => x[1]), ["When (IST)", "Movement", "Who and what", "Status", "Amount", "Reference"]);
  const body = /<tbody>.*?<\/tbody>/s.exec(html)![0];
  assert.equal(count(body, "<tr"), 3);
  assert.equal(count(body, 'data-label="Amount"'), 3);
  assert.equal(count(body, 'data-label="Reference"'), 3);
  // Times are IST through lib/india.
  assert.ok(html.includes("25 Oct 2026, 6:30 PM IST"), "13:00 UTC is 6:30 PM IST");
  // The three movements.
  assert.ok(html.includes("Customer payment") && html.includes("Refund to customer") && html.includes("Payout to influencer"));
  assert.ok(html.includes("+₹1,050.00"), "a payment is money in");
  assert.ok(html.includes("−₹300.00") && html.includes("−₹895.50"), "a refund and a payout are money out");
  assert.ok(html.includes("Fee kept ₹105.00") && html.includes("after the fee"), "a payout shows the fee kept");
  assert.ok(html.includes("To UPI ****9999") && html.includes("Approved by ann@example.com") && html.includes("Marked sent by bob@example.com"));
  assert.ok(html.includes("Strategy call") && html.includes("Cust One"));
  // Masked references only.
  assert.ok(html.includes("Razorpay ****1234") && html.includes("UTR ****5678"));
  // Links: the influencer, the booking search by id, the payout on the Payouts page.
  assert.ok(html.includes('href="/admin/influencers/inf1"'));
  assert.ok(html.includes('href="/admin/bookings?q=bk1"'));
  assert.ok(html.includes('href="/admin/payouts?status=PAID#payout-po1"'));
  // Statuses.
  assert.ok(html.includes(">Sent<") && html.includes(">Processed<") && html.includes(">Paid<"));
});

test("statuses: flagged for a refund, refunded, a pending refund and a failed one that is not counted", () => {
  const html = render({
    rows: [payment({ key: "payment:a", status: "flagged" }), payment({ key: "payment:b", status: "refunded" }), refund({ key: "refund:c", status: "pending" }), refund({ key: "refund:d", status: "failed" })],
    total: 4,
  });
  assert.ok(html.includes(">Flagged for refund<") && html.includes(">Refunded<") && html.includes(">Pending<") && html.includes(">Failed, not counted<"));
});

test("the cards: money in, refunds out, payouts out, platform fees kept and still held, per currency, with counts", () => {
  const html = render();
  for (const label of ["Money in", "Refunds out", "Payouts out", "Platform fees kept", "Still held"]) assert.ok(html.includes(`>${label}<`), label);
  assert.ok(html.includes("₹1,050.00") && html.includes("₹300.00") && html.includes("₹895.50") && html.includes("₹105.00") && html.includes("₹160.00"));
  assert.ok(html.includes("1 payment") && html.includes("1 refund") && html.includes("1 payout, after the fee"));
  assert.ok(html.includes("Totals, 2026-10-01 to 2026-10-31"));
  assert.ok(html.includes('href="/admin/reports?from=2026-10-01&amp;to=2026-10-31"'), "a link to the Reports page for the same dates");
  // Two currencies are two cards, never one total.
  const two = render({ totals: [...base().totals, { ...base().totals[0], currency: "USD" }] });
  assert.equal(count(two, '<h3 class="card__title">'), 2);
  assert.ok(two.includes(">INR<") && two.includes(">USD<"));
  // Nothing in the range: a sentence instead of cards.
  assert.ok(render({ totals: [] }).includes("No payments, refunds or payouts in this range, and nothing held."));
});

test("the live status line says what is shown; while the next filter loads it says Loading and the content is aria-busy", () => {
  const html = render();
  assert.equal(statusLine(html), "All, 2026-10-01 to 2026-10-31: 3 movements, page 1 of 1. INR in ₹1,050.00, refunds ₹300.00, payouts ₹895.50.");
  assert.ok(!busyAttr(html));
  const loading = render({}, true);
  assert.equal(statusLine(loading), "Loading…");
  assert.ok(busyAttr(loading));
  assert.equal(statusLine(render({ total: 1, type: "refunds" })), "Refunds, 2026-10-01 to 2026-10-31: 1 movement, page 1 of 1. INR in ₹1,050.00, refunds ₹300.00, payouts ₹895.50.");
  assert.equal(statusLine(render({ influencer: { id: "inf1", name: "Ina Fluencer" } })).slice(0, 36), "All, Ina Fluencer, 2026-10-01 to 202");
  assert.equal(statusLine(render({ rows: [], total: 0, totals: [] })), "All, 2026-10-01 to 2026-10-31: no money movements, page 1 of 1.");
  assert.equal(count(html, '<p role="status" class="sr-only">'), 1, "one live region");
});

test("empty: a sentence, not a bare table; the form and the tabs stay", () => {
  const html = render({ rows: [], total: 0, totals: [], counts: { payments: 0, refunds: 0, payouts: 0 } });
  assert.ok(html.includes("No money moved"));
  assert.ok(html.includes("There are no payments, refunds or payouts in this range."));
  assert.equal(count(html, "<table"), 0);
  assert.ok(html.includes('name="from"') && html.includes('name="to"') && html.includes('role="status"'));
  const refundsTab = render({ rows: [], total: 0, type: "refunds", influencer: { id: "inf1", name: "Ina Fluencer" } });
  assert.ok(refundsTab.includes("There are no refunds in this range for this influencer."));
});

test("the filter form: a GET form with the dates, the influencer list and the type kept as a hidden field", () => {
  const html = render({ type: "out", influencer: { id: "inf2", name: "Bo Beta" } });
  assert.match(html, /<form [^>]*action="\/admin\/money"[^>]*method="get"/);
  assert.ok(/<input [^>]*name="from"[^>]*type="date"[^>]*>/.test(html) || /<input [^>]*type="date"[^>]*name="from"[^>]*>/.test(html), "from");
  assert.ok(html.includes('value="2026-10-01"') && html.includes('value="2026-10-31"'));
  assert.ok(html.includes('for="from"') && html.includes('for="to"') && html.includes('for="influencerId"'), "every field has a label");
  assert.ok(/<input type="hidden" name="type" value="out"\/>/.test(html));
  const select = /<select [^>]*name="influencerId"[^>]*>.*?<\/select>/s.exec(html)![0];
  assert.ok(select.includes('<option value="">All influencers</option>'));
  assert.ok(select.includes('<option value="inf1">Ina Fluencer</option>'), "an influencer that is not chosen");
  assert.ok(/<option value="inf2"[^>]*selected[^>]*>Bo Beta<\/option>/.test(select), "the chosen influencer is selected");
  assert.ok(!html.includes("The list shows the first"), "no note while the list is complete");
  const cut = render({ influencers: { options: [{ id: "inf1", name: "Ina" }], truncated: true } });
  assert.ok(cut.includes("The list shows the first 1 influencers by name."));
});

test("tabs and pages keep the dates, the type and the influencer; the current tab is marked", () => {
  const html = render({ type: "out", influencer: { id: "inf2", name: "Bo Beta" }, page: 2, pageCount: 3 });
  assert.ok(html.includes('aria-current="page"'));
  const tabs = /<nav class="tabs"[^>]*>.*?<\/nav>/s.exec(html)![0];
  assert.equal(count(tabs, "<a "), 5);
  assert.deepEqual([...tabs.matchAll(/<a [^>]*>(.*?)<\/a>/g)].map((x) => x[1]), ["All", "Money in", "Money out", "Refunds", "Payouts"]);
  assert.ok(tabs.includes('href="/admin/money?from=2026-10-01&amp;to=2026-10-31&amp;type=in&amp;influencerId=inf2"'));
  assert.ok(/aria-current="page"[^>]*>Money out<|href="[^"]*type=out[^"]*"[^>]*aria-current="page"/.test(tabs), "Money out is the current tab");
  assert.ok(html.includes("Page 2 of 3"));
  assert.ok(html.includes('href="/admin/money?from=2026-10-01&amp;to=2026-10-31&amp;type=out&amp;influencerId=inf2"'), "previous: page 1 leaves out ?page");
  assert.ok(html.includes('href="/admin/money?from=2026-10-01&amp;to=2026-10-31&amp;type=out&amp;influencerId=inf2&amp;page=3"'), "next");
  assert.equal(m.moneyHref({ from: "a", to: "b", type: "in", influencerId: null }), "/admin/money?from=a&to=b&type=in");
  assert.equal(m.moneyHref({ from: "a", to: "b", type: "in", influencerId: null, page: 1 }), "/admin/money?from=a&to=b&type=in", "page 1 is the default");
  assert.equal(count(render(), "Page 1 of"), 0, "a single page has no pagination");
});

test("the export link: the filters of the page, a plain download link, and the CSV file name", () => {
  const html = render({ type: "refunds", influencer: { id: "inf2", name: "Bo Beta" } });
  const link = /<a [^>]*>Export CSV<\/a>/.exec(html)?.[0] ?? "";
  assert.ok(link.includes('href="/api/admin/exports/money?from=2026-10-01&amp;to=2026-10-31&amp;type=refunds&amp;influencerId=inf2"'), link);
  assert.ok(link.includes('download=""'));
  assert.ok(render().includes('href="/api/admin/exports/money?from=2026-10-01&amp;to=2026-10-31&amp;type=all"'), "no influencer: none in the link");
  assert.equal(m.exportUrl("money", "2026-10-01", "2026-10-11", { type: "in", influencerId: "" }), "/api/admin/exports/money?from=2026-10-01&to=2026-10-11&type=in");
  assert.equal(m.exportUrl("audit", "2026-10-01", "2026-10-11"), "/api/admin/exports/audit?from=2026-10-01&to=2026-10-11", "the other kinds are as before");
});

test("one influencer: the summary card with the figures, the last payout and a link to the influencer page, where the next payout is created", () => {
  const html = render({
    influencer: { id: "inf1", name: "Ina Fluencer" },
    summary: {
      feePercentText: "10%",
      currencies: [{ currency: "INR", paidOutMinor: 92_550, payableMinor: 12_000, heldMinor: 8_000, pendingMinor: 5_000 }],
      lastPayout: { paidAt: new Date("2026-10-25T13:00:00Z"), netMinor: 3_000, currency: "INR" },
    },
  });
  assert.ok(html.includes("Ina Fluencer: payouts"));
  for (const label of ["Paid out to date", "Payable now", "Held, not payable yet", "In pending payouts"]) assert.ok(html.includes(`>${label}<`), label);
  assert.ok(html.includes("₹925.50") && html.includes("₹120.00") && html.includes("₹80.00") && html.includes("₹50.00"));
  assert.ok(html.includes("After the 10% platform fee"));
  assert.ok(html.includes("Last payout: ₹30.00 on 25 Oct 2026, 6:30 PM IST."));
  assert.ok(/<a [^>]*href="\/admin\/influencers\/inf1"[^>]*>Open influencer to create a payout<\/a>/.test(html));
  assert.ok(html.includes("Totals, 2026-10-01 to 2026-10-31, Ina Fluencer"));
  const none = render({ influencer: { id: "inf1", name: "Ina Fluencer" }, summary: { feePercentText: "10%", currencies: [], lastPayout: null } });
  assert.ok(none.includes("No payout has been sent to this influencer yet.") && none.includes("no paid-out, payable or held money yet"));
  assert.ok(!render().includes("create a payout"), "no summary for everybody");
});

test("payouts created and not sent: their own table, with the approval, the sum waiting and a link to Payouts; hidden for the types that do not show payouts", () => {
  const scheduled = {
    shown: true,
    total: 52,
    sums: [{ currency: "INR", netMinor: 12_000, count: 52 }],
    rows: [
      { id: "s1", createdAt: new Date("2026-10-30T10:00:00Z"), influencer: { id: "inf1", name: "Ina Fluencer" }, netMinor: 7_000, feeMinor: 700, currency: "INR", destination: "UPI ****1234", approved: true, approvedBy: "ann@example.com" },
      { id: "s2", createdAt: new Date("2026-10-29T10:00:00Z"), influencer: { id: "inf2", name: "Bo Beta" }, netMinor: 5_000, feeMinor: 500, currency: "INR", destination: "UPI ****5555", approved: false, approvedBy: null },
    ],
  };
  const html = render({ scheduled });
  assert.ok(html.includes("Payouts created, not sent yet"));
  assert.equal(count(html, "<table"), 2);
  assert.ok(html.includes('<caption class="sr-only">Payouts created and not sent yet, newest first</caption>'));
  assert.ok(html.includes(">Approved, not sent yet<") && html.includes(">Not sent yet<") && html.includes("Approved by ann@example.com"));
  assert.ok(html.includes("Waiting: ₹120.00 (52 payouts)."));
  assert.ok(html.includes('href="/admin/payouts?status=PENDING#payout-s1"') && html.includes('href="/admin/payouts?status=PENDING#payout-s2"'));
  assert.ok(html.includes("Showing the newest 2 of 52.") && html.includes('href="/admin/payouts?status=PENDING"'));
  assert.ok(render({ scheduled: { shown: true, total: 0, sums: [], rows: [] } }).includes("No payout is waiting to be sent"));
  const hiddenOne = render({ type: "in", scheduled: { shown: false, total: 0, sums: [], rows: [] } });
  assert.ok(!hiddenOne.includes("Payouts created, not sent yet"));
});

test("an unknown influencer: a warning and an empty page, the form still there", () => {
  const html = render({ influencerUnknown: true, rows: [], total: 0, totals: [], counts: { payments: 0, refunds: 0, payouts: 0 } });
  assert.ok(html.includes("No influencer has that id"));
  assert.equal(statusLine(html), "No influencer has that id.");
  assert.ok(html.includes('name="from"'));
});

test("the error state keeps the form: the dates and the type stay, a valid influencer id is kept, a malformed one is dropped, Try again only when it may help", () => {
  const html = renderToStaticMarkup(createElement(m.MoneyProblem, { from: "2026-10-12", to: "2026-10-11", type: "out", influencerId: "inf9", title: "That filter cannot be shown", message: "The start date is after the end date." }));
  assert.ok(html.includes("That filter cannot be shown") && html.includes("The start date is after the end date."));
  assert.ok(html.includes('value="2026-10-12"') && html.includes('value="2026-10-11"') && html.includes('name="from"') && html.includes('name="to"'));
  assert.ok(/<input type="hidden" name="type" value="out"\/>/.test(html));
  assert.ok(/<input type="hidden" name="influencerId" value="inf9"\/>/.test(html));
  assert.ok(html.includes('role="alert"'));
  assert.ok(!html.includes("Try again"));
  const hostile = renderToStaticMarkup(createElement(m.MoneyProblem, { from: "", to: "", type: "all", influencerId: '"><script>alert(1)</script>', title: "Something went wrong", message: "We could not load the money ledger.", onRetry: () => {} }));
  assert.ok(!hostile.includes("<script>alert") && !hostile.includes('name="influencerId"'), "a malformed id is not sent back");
  assert.ok(hostile.includes("Try again"));
  assert.ok(hostile.includes('name="from"'), "the form stays");
});

test("hostile names and titles are escaped in every cell", () => {
  const evil = '"><script>alert(1)</script>';
  const html = render({
    rows: [payment({ influencer: { id: "inf1", name: evil }, serviceTitle: evil, customerName: evil }), payout({ destination: evil, approvedBy: evil })],
    influencers: { options: [{ id: "inf1", name: evil }], truncated: false },
    scheduled: { shown: true, total: 1, sums: [], rows: [{ id: "s1", createdAt: new Date(), influencer: { id: "inf1", name: evil }, netMinor: 1, feeMinor: 0, currency: "INR", destination: evil, approved: true, approvedBy: evil }] },
    total: 2,
  });
  assert.ok(!html.includes("<script>alert"), "nothing is written as markup");
  assert.ok(html.includes("&lt;script&gt;alert(1)&lt;/script&gt;"));
});

test("the definitions explain every date and amount, and nothing on the page promises more than the rules give", () => {
  const html = render();
  assert.ok(html.includes("What the dates and amounts mean"));
  assert.equal(m.MONEY_DEFINITIONS.length, 6);
  for (const d of m.MONEY_DEFINITIONS) assert.ok(html.includes(`<dt>${d.term}</dt>`), d.term);
  const text = m.MONEY_DEFINITIONS.map((d) => d.text).join(" ");
  assert.match(text, /created_at|day checkout began/i);
  assert.match(text, /failed refund is listed/i);
  assert.match(text, /Indian Standard Time \(IST\)/);
  assert.match(text, /same figures, worked out by the same code, as the Reports page/);
});

test("the DTO type the page reads passes the secret-key check (the shape of the fixtures is the shape of the endpoint)", () => {
  assertNoSecretKeys(jsonify(base({ influencer: { id: "inf1", name: "Ina" }, summary: { feePercentText: "10%", currencies: [], lastPayout: null } })));
});

/* ---------- wiring (sources) ---------- */

test("the route table row: a static admin page titled Money, noindex,nofollow, in the admin title template", () => {
  const route = spaRouteById("admin-money") as { id: string; path: string; robots: string; template: string; title: string; head: string };
  assert.deepEqual([route.id, route.path, route.robots, route.template, route.title, route.head], ["admin-money", "/admin/money", "noindex,nofollow", "admin", "Money", "static"]);
  assert.equal(formatTitle(route.title, route.template as "admin", "Brand"), "Money · Admin");
  assert.deepEqual(clientHeadFor("/admin/money", "https://example.com", "Brand").robots, "noindex,nofollow");
  assert.equal(clientHeadFor("/admin/money", "https://example.com", "Brand").canonical, undefined, "an admin page has no canonical URL");
});

test("the page module: one PageTitle equal to the route table, the endpoint, the previous data kept while the next filter loads, the form kept on a failure", () => {
  const src = read("web/src/pages/admin/Money.tsx");
  assert.equal(count(src, "<PageTitle "), 1);
  assert.ok(src.includes('<PageTitle title="Money" template="admin" />'));
  assert.ok(src.includes("`/api/admin/money?${params}`"));
  assert.ok(src.includes("placeholderData: keepPreviousData"));
  assert.ok(src.includes("<MoneyProblem") && src.includes("<QueryGate query={query} embedded>"));
  for (const name of ["from", "to", "type", "influencerId", "page"]) assert.ok(src.includes(`search.get("${name}")`), name);
  // The page imports no server module: only types from lib, never a value.
  for (const spec of [...src.matchAll(/^import (?!type )[^"']*from\s+["']([^"']+)["']/gm)].map((x) => x[1])) assert.ok(!/^@\/lib\//.test(spec), `a value import from lib: ${spec}`);
});
