// WP-B views, rendered on the server from fixtures (no database, no network): the Refund button only on rows the server allows, the
// Cancel button only on rows the server allows, the search form of the Bookings page, and the export controls with the download URL on
// the four pages that have them. The navigation hooks are replaced by tests/helpers/fake-navigate.ts before the views are imported.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { before, mock, test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { jsonify } from "../lib/jsonify";
import { fakeNavigate } from "./helpers/fake-navigate";

type Mod = {
  PaymentsView: typeof import("../web/src/components/views/admin/PaymentsView").PaymentsView;
  PayoutsView: typeof import("../web/src/components/views/admin/PayoutsView").PayoutsView;
  BookingsView: typeof import("../web/src/components/views/admin/BookingsView").BookingsView;
  AuditView: typeof import("../web/src/components/views/admin/AuditView").AuditView;
  exportUrl: typeof import("../web/src/components/admin/ExportControls").exportUrl;
  exportRangeProblem: typeof import("../web/src/components/admin/ExportControls").exportRangeProblem;
};
let m: Mod;

before(async () => {
  mock.module("@web/lib/navigate", { namedExports: fakeNavigate("/admin") });
  const controls = await import("../web/src/components/admin/ExportControls");
  m = {
    PaymentsView: (await import("../web/src/components/views/admin/PaymentsView")).PaymentsView,
    PayoutsView: (await import("../web/src/components/views/admin/PayoutsView")).PayoutsView,
    BookingsView: (await import("../web/src/components/views/admin/BookingsView")).BookingsView,
    AuditView: (await import("../web/src/components/views/admin/AuditView")).AuditView,
    exportUrl: controls.exportUrl,
    exportRangeProblem: controls.exportRangeProblem,
  };
});

const count = (haystack: string, needle: string) => haystack.split(needle).length - 1;
const unHtml = (s: string) => s.replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
const statusLine = (html: string) => unHtml(/<p role="status" class="sr-only">([^<]*)<\/p>/.exec(html)![1]);

const allowedRefund = { allowed: true, reason: null, remainingMinor: 250000 };
const payment = (over: Record<string, unknown> = {}) => ({
  id: "p1",
  createdAt: "2026-10-01T08:30:00.000Z",
  status: "CAPTURED",
  needsRefund: false,
  refundStatus: null,
  refundAmountMinor: null,
  amountMinor: 250000,
  currency: "INR",
  reconciled: false,
  inPayout: false,
  razorpayId: "pay_ABC",
  mismatch: false,
  refund: allowedRefund,
  booking: { status: "COMPLETED", customerName: "Cust One" },
  service: { title: "Strategy call" },
  influencer: { id: "inf1", name: "Ina Fluencer" },
  ...over,
});
const counts = { all: 9, unreconciled: 4, captured: 6, needsRefund: 1, mismatch: 2, unpaid: 3 };
const paymentsHtml = (rows: unknown[]) =>
  renderToStaticMarkup(createElement(m.PaymentsView, { data: jsonify({ view: "all" as const, page: 1, pageCount: 1, total: rows.length, counts, rows }) as never }));

test("PaymentsView: a Refund button on the rows the server allows, and only on those; a flagged row that is refused says why", () => {
  const html = paymentsHtml([
    payment({ id: "allowed" }),
    payment({ id: "partial", refundAmountMinor: 50000, refund: { allowed: true, reason: null, remainingMinor: 200000 } }),
    payment({ id: "live", booking: { status: "SCHEDULED", customerName: "Cust Two" }, refund: { allowed: false, reason: "Cancel the booking first (Bookings > Cancel).", remainingMinor: 250000 } }),
    payment({ id: "flagged-blocked", needsRefund: true, refund: { allowed: false, reason: "This payment is in a pending payout. Cancel that payout first.", remainingMinor: 250000 }, inPayout: true }),
    payment({ id: "refunded", status: "REFUNDED", refund: { allowed: false, reason: "This payment was already refunded in full.", remainingMinor: 0 } }),
    payment({ id: "unpaid", status: "CREATED", refund: { allowed: false, reason: "Only captured payments can be refunded.", remainingMinor: 250000 } }),
  ]);
  assert.equal(count(html, "data-refund="), 2);
  assert.ok(html.includes('data-refund="allowed"') && html.includes('data-refund="partial"'));
  for (const id of ["live", "flagged-blocked", "refunded", "unpaid"]) assert.ok(!html.includes(`data-refund="${id}"`), id);
  assert.ok(html.includes("Refund…"));
  assert.ok(html.includes("This payment is in a pending payout. Cancel that payout first."), "a payment flagged for a refund that cannot be refunded says why");
  assert.ok(!html.includes("Cancel the booking first"), "an ordinary refused row stays quiet");
  assert.ok(!html.includes("Only captured payments can be refunded"));
  // The dialog is closed: nothing of it (the amount, the reason box) is in the page until the button is pressed.
  assert.ok(!html.includes("<textarea") && !html.includes("Refund ₹"));
  assert.equal(count(html, 'data-export="payments"'), 1, "one set of export controls");
});

test("PaymentsView: with no allowed row there is no Refund button at all", () => {
  const html = paymentsHtml([payment({ id: "x", refund: { allowed: false, reason: "Only captured payments can be refunded.", remainingMinor: 1 } })]);
  assert.ok(!html.includes("data-refund=") && !html.includes("Refund…"));
});

const booking = (over: Record<string, unknown> = {}) => ({
  id: "b1",
  serviceTitle: "Call",
  startTime: "2026-10-12T10:00:00.000Z",
  influencer: { id: "inf1", name: "Ina" },
  customerName: "Cust",
  status: "SCHEDULED",
  lastError: null,
  paidMinor: 150000,
  currency: "INR",
  cancel: { allowed: true, reason: null },
  ...over,
});
const bookingsHtml = (over: Record<string, unknown> = {}, rows: unknown[] = [booking()]) =>
  renderToStaticMarkup(createElement(m.BookingsView, { data: jsonify({ q: "", status: "all" as const, page: 1, pageCount: 1, total: rows.length, rows, ...over }) as never }));

test("BookingsView: a Cancel button only on rows the server allows", () => {
  const html = bookingsHtml({}, [
    booking({ id: "future" }),
    booking({ id: "past", status: "COMPLETED", cancel: { allowed: false, reason: "This session has already taken place; refund the payment instead." } }),
    booking({ id: "cancelled", status: "CANCELLED", cancel: { allowed: false, reason: "This booking is already cancelled." } }),
    booking({ id: "failed", status: "FAILED" }),
  ]);
  assert.equal(count(html, "data-cancel="), 2);
  assert.ok(html.includes('data-cancel="future"') && html.includes('data-cancel="failed"'));
  assert.ok(!html.includes('data-cancel="past"') && !html.includes('data-cancel="cancelled"'));
  assert.ok(html.includes("Cancel…"));
  assert.ok(!html.includes("<textarea"), "the dialog is closed");
});

test("BookingsView: the search form (GET, name q, the loaded status kept), the search text in the box, tabs and pages that keep it, and the empty message", () => {
  const plain = bookingsHtml();
  assert.match(plain, /<form [^>]*action="\/admin\/bookings"[^>]*method="get"/);
  assert.ok(/<input type="hidden" name="status" value="all"\/>/.test(plain));
  const box = /<input [^>]*name="q"[^>]*>/.exec(plain)?.[0] ?? "";
  assert.ok(box.includes('placeholder="Search customer e-mail, name or booking reference"') && /maxLength="120"/i.test(box), "the search box");
  assert.ok(plain.includes('href="/admin/bookings?status=PAID"'), "no search text: tabs as before");
  assert.equal(statusLine(plain), "All: 1 booking, page 1 of 1.");

  const searched = bookingsHtml({ q: 'asha"><script>x</script>', status: "PAID" as const, page: 1, pageCount: 3 });
  assert.ok(!searched.includes("<script>x"), "the search text is escaped");
  assert.ok(searched.includes('href="/admin/bookings?status=SCHEDULED&amp;q=asha%22%3E%3Cscript%3Ex%3C%2Fscript%3E"'), "a tab keeps the search text");
  assert.ok(searched.includes("page=2&amp;q=asha%22%3E%3Cscript%3Ex%3C%2Fscript%3E"), "a page link keeps the search text");
  assert.ok(statusLine(searched).startsWith('Paid, no link matching "asha"><script>x</script>": '));

  const empty = bookingsHtml({ q: "nobody@example.com" }, []);
  assert.ok(empty.includes("Nothing matches this search."));
  assert.ok(bookingsHtml({}, []).includes("Nothing matches this filter."));
});

test("export controls: Payments, Bookings, Payouts and Audit each have one, a plain download link to the right kind with this month's range", () => {
  const month = new Date().toISOString().slice(0, 7);
  const today = new Date().toISOString().slice(0, 10);
  const payouts = renderToStaticMarkup(createElement(m.PayoutsView, { data: jsonify({ status: "PENDING" as const, page: 1, pageCount: 1, counts: { PENDING: 0, PAID: 0, CANCELLED: 0, all: 0 }, onlyOneAdmin: false, rows: [] }) as never }));
  const audit = renderToStaticMarkup(createElement(m.AuditView, { data: jsonify({ page: 1, pageCount: 1, rows: [] }) as never }));
  const pages: [string, string][] = [["payments", paymentsHtml([])], ["bookings", bookingsHtml()], ["payouts", payouts], ["audit", audit]];
  for (const [kind, html] of pages) {
    assert.equal(count(html, "data-export="), 1, kind);
    assert.ok(html.includes(`data-export="${kind}"`), kind);
    assert.ok(html.includes(`href="/api/admin/exports/${kind}?from=${month}-01&amp;to=${today}"`), `${kind}: the link`);
    assert.match(html, /<a [^>]*download=""[^>]*>Download CSV<\/a>|<a [^>]*>Download CSV<\/a>/);
    assert.ok(html.includes(`value="${month}-01"`) && html.includes(`value="${today}"`), `${kind}: the dates`);
    assert.ok(html.includes('type="date"'));
  }
  assert.equal(m.exportUrl("audit", "2026-10-01", "2026-10-11"), "/api/admin/exports/audit?from=2026-10-01&to=2026-10-11");
});

test("export controls: the same range rules as the server", () => {
  assert.equal(m.exportRangeProblem("2026-10-01", "2026-10-11"), null);
  assert.equal(m.exportRangeProblem("2026-10-11", "2026-10-11"), null);
  assert.equal(m.exportRangeProblem("2025-10-11", "2026-10-11"), null, "366 days");
  assert.match(m.exportRangeProblem("2025-10-10", "2026-10-11")!, /366/);
  assert.match(m.exportRangeProblem("2026-10-12", "2026-10-11")!, /after/);
  for (const [a, b] of [["", "2026-10-11"], ["2026-10-01", ""], ["abc", "2026-10-11"], ["2026-13-01", "2026-10-11"]]) assert.match(m.exportRangeProblem(a, b)!, /Choose a start and an end date/);
});

test("the action components import nothing server-side (only the pure lib/format and lib/india; the Vite guard allowlist is otherwise not extended) and only POST/GET same-origin API paths", () => {
  const root = path.resolve(__dirname, "..");
  for (const file of ["ExportControls", "RefundAction", "CancelBookingAction"]) {
    const src = readFileSync(path.join(root, `web/src/components/admin/${file}.tsx`), "utf8");
    for (const spec of [...src.matchAll(/^import (?!type )[^"']*from\s+["']([^"']+)["']/gm)].map((x) => x[1])) {
      assert.ok(/^(react|@web\/|@\/lib\/(format|india)$)/.test(spec), `${file}: ${spec}`);
    }
    assert.ok(!/@\/lib\/(admin|views|db|payouts|queue|manage|refunds)/.test(src.replace(/import type[^\n]*\n/g, "")), file);
    for (const url of [...src.matchAll(/fetch\(\s*[`"']([^`"']+)/g)].map((x) => x[1])) assert.ok(url.startsWith("/api/admin/"), `${file}: ${url}`);
  }
});
