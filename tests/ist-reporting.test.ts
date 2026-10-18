// Day and month boundaries are Indian Standard Time (doc/14-india-localisation.md): midnight IST is 18:30 UTC the evening before. This file
// puts payments, refunds and payouts on both sides of that instant (18:29:59.999Z and 18:30:00.000Z) at a day boundary and at a month
// boundary and checks the admin report (lib/admin/reports.ts), the influencer's earnings page and "this month" (lib/views/dashboard-earnings.ts,
// lib/dashboard-data.ts) and the admin export range (lib/admin/exports.ts). Money maths is not touched here: every figure is a plain sum.
//
// The database part builds ONE influencer whose money is in a test-only currency of this run (the report adds up the whole shared database).
import "dotenv/config";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { monthlyFigures, rangeFigures } from "../lib/admin/reports";
import { parseExportRange } from "../lib/admin/exports";
import { getOverview } from "../lib/dashboard-data";
import { prisma } from "../lib/db";
import { parseReportsRange } from "../lib/views/admin-reports";
import { loadEarningsView } from "../lib/views/dashboard-earnings";

const skip = process.env.DATABASE_URL ? false : "DATABASE_URL not set";
const run = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
const at = (iso: string) => new Date(iso);

const code = (n: number) => [Math.floor(n / 676) % 26, Math.floor(n / 26) % 26, n % 26].map((d) => String.fromCharCode(65 + d)).join("");
const CUR = code(Math.floor(Date.now() / 1000) + 6000);

/* ---------- ranges without a database ---------- */

test("'today' flips at 18:30 UTC: the default report range and the export range follow the Indian date", () => {
  const before = at("2026-09-30T18:29:59.999Z"); // 23:59:59.999 IST on 30 September
  const after = at("2026-09-30T18:30:00.000Z"); // 00:00 IST on 1 October
  assert.deepEqual(parseReportsRange({}, before), { ok: true, from: "2026-09-01", to: "2026-09-30" });
  assert.deepEqual(parseReportsRange({}, after), { ok: true, from: "2026-10-01", to: "2026-10-01" });

  const a = parseExportRange(new URLSearchParams(), before);
  assert.ok(a.ok);
  if (a.ok) assert.deepEqual([a.range.from, a.range.to], ["2026-09-01", "2026-09-30"]);
  const b = parseExportRange(new URLSearchParams(), after);
  assert.ok(b.ok);
  if (b.ok) {
    assert.deepEqual([b.range.from, b.range.to], ["2026-10-01", "2026-10-01"]);
    // The export's bounds on createdAt are the IST day: [00:00 IST, next 00:00 IST).
    assert.equal(b.range.start.toISOString(), "2026-09-30T18:30:00.000Z");
    assert.equal(b.range.end.toISOString(), "2026-10-01T18:30:00.000Z");
  }
});

/* ---------- the database ---------- */

let influencerId = "";
let serviceId = "";
const bookingIds: string[] = [];

async function pay(key: string, amount: number, createdAt: string) {
  const booking = await prisma.booking.create({
    data: {
      sessionId: sessionId,
      status: "COMPLETED",
      customerName: `Ist ${key} ${run}`,
      customerEmail: `ist-${key}-${run}@example.com`,
      whatsappE164: "+919876543210",
    },
  });
  bookingIds.push(booking.id);
  return prisma.payment.create({
    data: { bookingId: booking.id, providerOrderId: `order_ist_${run}_${key}`, providerPaymentId: `pay_ist_${run}_${key}`, amountMinor: amount, currency: CUR, status: "CAPTURED", createdAt: at(createdAt) },
  });
}
let sessionId = "";

before(async () => {
  if (skip) return;
  influencerId = (await prisma.influencer.create({ data: { slug: `ist-${run}`, name: `Ist ${run}`, email: `ist-${run}@example.com`, onboardedAt: new Date() } })).id;
  serviceId = (await prisma.service.create({ data: { influencerId, title: "Ist", durationMin: 30, priceMinor: 1000, currency: CUR, capacity: 50, type: "GROUP" } })).id;
  const start = new Date(Date.UTC(2023, 0, 1));
  sessionId = (await prisma.session.create({ data: { serviceId, startTime: start, endTime: new Date(start.getTime() + 30 * 60_000) } })).id;

  // Both sides of a day boundary (30 September | 1 October) and of a month boundary (31 October | 1 November), in IST.
  const pA = await pay("a", 1000, "2026-09-30T18:29:59.999Z"); // 30 Sep 23:59:59.999 IST
  const pB = await pay("b", 2000, "2026-09-30T18:30:00.000Z"); //  1 Oct 00:00:00.000 IST
  await pay("c", 4000, "2026-10-31T18:29:59.999Z"); //            31 Oct 23:59:59.999 IST
  await pay("d", 8000, "2026-10-31T18:30:00.000Z"); //             1 Nov 00:00:00.000 IST
  // The same instants for refunds.
  await prisma.refund.create({ data: { paymentId: pA.id, providerRefundId: `rfnd_ist_${run}_a`, amountMinor: 100, status: "processed", createdAt: at("2026-09-30T18:29:59.999Z") } });
  await prisma.refund.create({ data: { paymentId: pB.id, providerRefundId: `rfnd_ist_${run}_b`, amountMinor: 200, status: "processed", createdAt: at("2026-09-30T18:30:00.000Z") } });
  // And for payouts marked as paid (the fee kept is dated by paid_at).
  const payout = (suffix: string, paidAt: string, fee: number) =>
    prisma.payout.create({
      data: { influencerId, status: "PAID", currency: CUR, grossMinor: 1000, refundsMinor: 0, feeBps: 1000, feeMinor: fee, netMinor: 1000 - fee, paymentCount: 1, destination: "XXXX0001", reference: `UTR${run}${suffix}`, createdByEmail: "ist@example.com", paidByEmail: "ist@example.com", paidAt: at(paidAt) },
    });
  await payout("a", "2026-09-30T18:29:59.999Z", 10);
  await payout("b", "2026-09-30T18:30:00.000Z", 20);
});

after(async () => {
  if (!skip && influencerId) {
    await prisma.payout.deleteMany({ where: { influencerId } });
    await prisma.influencer.delete({ where: { id: influencerId } }); // services, sessions, bookings, payments and refunds cascade
  }
  await prisma.$disconnect();
});

const mine = <T extends { currency: string }>(rows: T[]) => rows.find((r) => r.currency === CUR);

test("report ranges: a payment at 18:29:59.999Z is on the Indian day that is ending, one at 18:30:00.000Z on the next", { skip }, async () => {
  const sep30 = mine(await rangeFigures("2026-09-30", "2026-09-30"));
  assert.ok(sep30);
  assert.deepEqual([sep30.grossMinor, sep30.paymentCount, sep30.refundsMinor, sep30.refundCount, sep30.payoutsPaidCount, sep30.feesEarnedMinor], [1000, 1, 100, 1, 1, 10], "30 September: the payment, the refund and the payout made before 18:30Z");
  const oct1 = mine(await rangeFigures("2026-10-01", "2026-10-01"));
  assert.ok(oct1);
  assert.deepEqual([oct1.grossMinor, oct1.paymentCount, oct1.refundsMinor, oct1.refundCount, oct1.payoutsPaidCount, oct1.feesEarnedMinor], [2000, 1, 200, 1, 1, 20], "1 October: the ones from 18:30Z on");
  // In UTC all of these are on 30 September: the old report put both payments on that one day.
  const nov1 = mine(await rangeFigures("2026-11-01", "2026-11-01"));
  assert.deepEqual([nov1?.grossMinor, nov1?.paymentCount], [8000, 1]);
  assert.equal(mine(await rangeFigures("2026-10-02", "2026-10-30")), undefined, "nothing between the boundaries");
});

test("report ranges partition time: summing single days gives the whole range, nothing lost and nothing counted twice", { skip }, async () => {
  const whole = mine(await rangeFigures("2026-09-29", "2026-10-02"));
  assert.ok(whole);
  assert.deepEqual([whole.grossMinor, whole.paymentCount, whole.refundsMinor, whole.feesEarnedMinor, whole.payoutsPaidNetMinor], [3000, 2, 300, 30, 1970]);
  let gross = 0;
  let count = 0;
  let day = "2026-09-29";
  for (let i = 0; i < 4; i++) {
    const r = mine(await rangeFigures(day, day));
    gross += r?.grossMinor ?? 0;
    count += r?.paymentCount ?? 0;
    day = new Date(Date.parse(`${day}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
  }
  assert.equal(day, "2026-10-03");
  assert.deepEqual([gross, count], [whole.grossMinor, whole.paymentCount]);
});

test("the monthly table buckets by the IST month: 18:30Z on the last day belongs to the next month", { skip }, async () => {
  const rows = (await monthlyFigures("2026-11")).filter((m) => m.currency === CUR);
  assert.deepEqual(
    rows.map((m) => [m.month, m.grossMinor, m.paymentCount, m.refundsMinor, m.feesEarnedMinor]),
    [
      ["2026-11", 8000, 1, 0, 0],
      ["2026-10", 6000, 2, 200, 20], // b (18:30Z on 30 Sep) + c (18:29Z on 31 Oct); the refund and the payout of 18:30Z on 30 Sep
      ["2026-09", 1000, 1, 100, 10], // a (18:29:59.999Z on 30 Sep)
    ],
  );
  // The months add up to the same total as one range over the same days.
  const whole = mine(await rangeFigures("2026-09-01", "2026-11-30"));
  assert.equal(
    rows.reduce((n, m) => n + m.grossMinor, 0),
    whole?.grossMinor,
  );
});

test("the earnings page: from/to are Indian days, and the default range is this IST month up to today", { skip }, async () => {
  const totals = async (params: { from?: string; to?: string }, now = at("2026-12-15T00:00:00Z")) => {
    const v = await loadEarningsView(influencerId, params, now);
    return { from: v.from, to: v.to, gross: v.summary.totalsByCurrency.find((t) => t.currency === CUR)?.amountMinor ?? 0, count: v.paymentCount };
  };
  assert.deepEqual(await totals({ from: "2026-09-30", to: "2026-09-30" }), { from: "2026-09-30", to: "2026-09-30", gross: 1000, count: 1 });
  assert.deepEqual(await totals({ from: "2026-10-01", to: "2026-10-01" }), { from: "2026-10-01", to: "2026-10-01", gross: 2000, count: 1 });
  assert.deepEqual(await totals({ from: "2026-10-01", to: "2026-10-31" }), { from: "2026-10-01", to: "2026-10-31", gross: 6000, count: 2 });
  assert.deepEqual(await totals({ from: "2026-11-01", to: "2026-11-01" }), { from: "2026-11-01", to: "2026-11-01", gross: 8000, count: 1 });
  // The default range: 29 September to the last millisecond of 30 September IST is September; one millisecond later it is October.
  assert.deepEqual(await totals({}, at("2026-09-30T18:29:59.999Z")), { from: "2026-09-01", to: "2026-09-30", gross: 1000, count: 1 });
  assert.deepEqual(await totals({}, at("2026-09-30T18:30:00.000Z")), { from: "2026-10-01", to: "2026-10-01", gross: 2000, count: 1 });
});

test("'this month' on the overview starts at 00:00 IST on the 1st (18:30Z the evening before)", { skip }, async () => {
  const month = async (now: string) => {
    const o = await getOverview(influencerId, true, at(now));
    return o.monthEarnings.totalsByCurrency.find((t) => t.currency === CUR)?.amountMinor ?? 0;
  };
  // 15 October IST: the month began at 18:30Z on 30 September, so b, c and d count (a does not).
  assert.equal(await month("2026-10-15T00:00:00Z"), 14000);
  // One millisecond before the October month began, it is still September: a (and everything after it) counts.
  assert.equal(await month("2026-09-30T18:29:59.999Z"), 15000);
  assert.equal(await month("2026-09-30T18:30:00.000Z"), 14000);
});
