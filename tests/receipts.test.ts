// WP-D, the pure parts (no database): the receipt builder, the portal's status wording and the two portal e-mails.
import assert from "node:assert/strict";
import { test } from "node:test";
import { BRAND_NAME } from "../lib/brand";
import { portalErasedMessage, portalLinkMessage } from "../lib/email/customer-portal";
import { buildReceipt, refundedMinorOf, type ReceiptBooking, type ReceiptPayment } from "../lib/receipts";

const booking: ReceiptBooking = {
  id: "bk_1",
  customerName: "Asha Rao",
  session: { startTime: new Date("2026-10-20T10:00:00.000Z"), service: { title: "Career call", influencer: { name: "Demo Creator" } } },
};
const payment = (over: Partial<ReceiptPayment> = {}): ReceiptPayment => ({
  status: "CAPTURED",
  amountMinor: 49900,
  currency: "INR",
  createdAt: new Date("2026-10-11T08:30:00.000Z"),
  providerPaymentId: "pay_abc123",
  refundAmountMinor: null,
  ...over,
});

test("buildReceipt: a paid booking", () => {
  assert.deepEqual(buildReceipt(booking, [payment()]), {
    reference: "bk_1",
    issuedTo: "Asha Rao",
    seller: BRAND_NAME,
    hostName: "Demo Creator",
    serviceTitle: "Career call",
    sessionStart: "2026-10-20T10:00:00.000Z",
    paidAt: "2026-10-11T08:30:00.000Z",
    amountMinor: 49900,
    currency: "INR",
    paymentReference: "pay_abc123",
    refundedMinor: 0,
    statusText: "Paid",
  });
});

test("buildReceipt: partly refunded, refunded (by amount and by status), and a payment without a reference", () => {
  assert.equal(buildReceipt(booking, [payment({ refundAmountMinor: 10000 })])!.statusText, "Partly refunded");
  assert.equal(buildReceipt(booking, [payment({ refundAmountMinor: 10000 })])!.refundedMinor, 10000);
  assert.equal(buildReceipt(booking, [payment({ refundAmountMinor: 49900 })])!.statusText, "Refunded");
  const byStatus = buildReceipt(booking, [payment({ status: "REFUNDED" })])!;
  assert.equal(byStatus.statusText, "Refunded");
  assert.equal(byStatus.refundedMinor, 49900);
  assert.equal(buildReceipt(booking, [payment({ providerPaymentId: null })])!.paymentReference, null);
  // A refund total can never exceed the payment or go below zero.
  assert.equal(refundedMinorOf({ status: "CAPTURED", amountMinor: 100, refundAmountMinor: 500 }), 100);
  assert.equal(refundedMinorOf({ status: "CAPTURED", amountMinor: 100, refundAmountMinor: -5 }), 0);
});

test("buildReceipt: no receipt without a captured payment; with several payments the first one is the receipt", () => {
  assert.equal(buildReceipt(booking, []), null);
  assert.equal(buildReceipt(booking, [payment({ status: "CREATED" }), payment({ status: "FAILED" })]), null);
  const first = payment({ providerPaymentId: "pay_first", createdAt: new Date("2026-10-11T08:00:00.000Z") });
  const second = payment({ providerPaymentId: "pay_second", createdAt: new Date("2026-10-11T09:00:00.000Z") });
  assert.equal(buildReceipt(booking, [second, first])!.paymentReference, "pay_first");
  assert.equal(buildReceipt(booking, [payment({ status: "CREATED" }), first])!.paymentReference, "pay_first", "an open order is not a receipt");
});

test("portalStatusText: every branch", async () => {
  const { portalStatusText } = await import("../lib/customer-portal");
  const paid = (over: Partial<{ amountMinor: number; refundedMinor: number; needsRefund: boolean; refundInFlight: boolean }> = {}) => ({
    amountMinor: 100,
    refundedMinor: 0,
    needsRefund: false,
    refundInFlight: false,
    ...over,
  });
  const text = (status: string, upcoming: boolean, p: ReturnType<typeof paid> | null) => portalStatusText({ status, upcoming, paid: p });
  assert.equal(text("SCHEDULED", true, paid()), "Upcoming");
  assert.equal(text("PAID", true, paid()), "Upcoming");
  assert.equal(text("SCHEDULED", false, paid()), "Completed");
  assert.equal(text("PAID", false, paid()), "Completed");
  assert.equal(text("COMPLETED", false, paid()), "Completed");
  assert.equal(text("CANCELLED", true, null), "Cancelled");
  assert.equal(text("CANCELLED", true, paid({ refundedMinor: 100 })), "Cancelled and refunded");
  assert.equal(text("CANCELLED", true, paid({ refundedMinor: 100, refundInFlight: true })), "Cancelled, refund on its way");
  assert.equal(text("CANCELLED", true, paid({ refundedMinor: 40 })), "Cancelled, partly refunded");
  assert.equal(text("CANCELLED", true, paid({ needsRefund: true })), "Cancelled, refund due");
  assert.equal(text("CANCELLED", true, paid()), "Cancelled, no refund due");
  assert.equal(text("FAILED", false, paid()), "Paid, session not confirmed. Contact the host");
  assert.equal(text("EXPIRED", false, paid({ refundedMinor: 100 })), "Not completed");
});

test("portal e-mails: the link is in both bodies, the wording is the same for every address, and plurals are right", () => {
  const url = "http://localhost:3000/bookings/abcDEF_-123";
  const link = portalLinkMessage(url);
  assert.ok(link.html.includes(`href="${url}"`) && link.text.includes(url));
  assert.ok(link.subject.includes(BRAND_NAME));
  assert.ok(/60 minutes/.test(link.text) && /ignore this e-mail/i.test(link.text));
  // Only http(s) links are rendered as links by the layout.
  assert.ok(!portalLinkMessage("javascript:alert(1)").html.includes('href="javascript:'));

  const one = portalErasedMessage({ erased: 1, blocked: 1 });
  assert.match(one.text, /from 1 booking\./);
  assert.match(one.text, /1 upcoming booking was kept so the session can still happen\. Cancel it from your manage link/);
  const many = portalErasedMessage({ erased: 5, blocked: 2 });
  assert.match(many.text, /from 5 bookings\./);
  assert.match(many.text, /2 upcoming bookings were kept so the sessions can still happen\. Cancel them from your manage links/);
  assert.match(portalErasedMessage({ erased: 3, blocked: 0 }).text, /No upcoming bookings were kept\./);
  for (const m of [one, many, link]) assert.ok(!/undefined|NaN|\[object/.test(m.text + m.html));
});
