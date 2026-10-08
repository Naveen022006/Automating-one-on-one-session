import assert from "node:assert/strict";
import { test } from "node:test";
import { aggregateEarnings, type EarningsPaymentInput } from "../lib/dashboard";

const payments: EarningsPaymentInput[] = [
  { amountMinor: 50000, currency: "INR", serviceId: "s1", serviceTitle: "1:1 Call" },
  { amountMinor: 50000, currency: "INR", serviceId: "s1", serviceTitle: "1:1 Call" },
  { amountMinor: 20000, currency: "INR", serviceId: "s2", serviceTitle: "Group Workshop" },
  { amountMinor: 20000, currency: "INR", serviceId: "s2", serviceTitle: "Group Workshop" },
  { amountMinor: 20000, currency: "INR", serviceId: "s2", serviceTitle: "Group Workshop" },
];

test("sums the total across all captured payments in a single currency", () => {
  const { totalsByCurrency } = aggregateEarnings(payments);
  assert.equal(totalsByCurrency.length, 1);
  assert.deepEqual(totalsByCurrency[0], { currency: "INR", amountMinor: 160000 });
});

test("groups per service with amount and count, ordered by amount desc", () => {
  const { byService } = aggregateEarnings(payments);
  assert.equal(byService.length, 2);
  // Ordered by amount desc: s1 (100000) before s2 (60000).
  assert.deepEqual(byService[0], {
    serviceId: "s1",
    serviceTitle: "1:1 Call",
    currency: "INR",
    amountMinor: 100000,
    count: 2,
  });
  assert.deepEqual(byService[1], {
    serviceId: "s2",
    serviceTitle: "Group Workshop",
    currency: "INR",
    amountMinor: 60000,
    count: 3,
  });
});

test("keeps currencies separate in totals and per-service rows", () => {
  const mixed: EarningsPaymentInput[] = [
    { amountMinor: 10000, currency: "INR", serviceId: "s1", serviceTitle: "Call" },
    { amountMinor: 5000, currency: "USD", serviceId: "s1", serviceTitle: "Call" },
    { amountMinor: 2000, currency: "USD", serviceId: "s1", serviceTitle: "Call" },
  ];
  const { totalsByCurrency, byService } = aggregateEarnings(mixed);
  // Sorted by amount desc: INR total (10000) before USD total (7000).
  assert.deepEqual(totalsByCurrency, [
    { currency: "INR", amountMinor: 10000 },
    { currency: "USD", amountMinor: 7000 },
  ]);
  // Same service appears once per currency.
  assert.equal(byService.length, 2);
  const usd = byService.find((s) => s.currency === "USD");
  const inr = byService.find((s) => s.currency === "INR");
  assert.deepEqual(usd, { serviceId: "s1", serviceTitle: "Call", currency: "USD", amountMinor: 7000, count: 2 });
  assert.deepEqual(inr, { serviceId: "s1", serviceTitle: "Call", currency: "INR", amountMinor: 10000, count: 1 });
});

test("empty input yields empty aggregates", () => {
  const summary = aggregateEarnings([]);
  assert.deepEqual(summary.totalsByCurrency, []);
  assert.deepEqual(summary.byService, []);
});
