// Integration test: needs a migrated Postgres at DATABASE_URL (skipped otherwise).
// POST /api/checkout needs the booking's poll token (not just its id), and resuming an open order does not move the hold.
import "dotenv/config";
import assert from "node:assert/strict";
import { after, before, mock, test } from "node:test";
import { prisma } from "../lib/db";
import { createHold, PAYMENT_WINDOW_MINUTES } from "../lib/holds";
import { signBookingPollToken, buildSelfServiceUrl } from "../lib/self-service";

const skip = process.env.DATABASE_URL ? false : "DATABASE_URL not set";
const run = Date.now();
const MIN = 60_000;
let influencerId: string;
let serviceId: string;
let n = 0;
let orders = 0;
let checkout: (req: Request) => Promise<Response>;

const post = (body: unknown) =>
  new Request("http://localhost/api/checkout", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

async function held() {
  n += 1;
  const start = new Date(Date.now() + (5 + n) * 86_400_000);
  start.setUTCMinutes(0, 0, 0);
  return createHold({
    serviceId,
    startTime: start,
    endTime: new Date(start.getTime() + 30 * MIN),
    capacity: 1,
    customerName: "Checkout Tester",
    customerEmail: `checkout${run}_${n}@example.com`,
    whatsappE164: "+919876543210",
    whatsappOptIn: true,
  });
}

before(async () => {
  process.env.APP_URL ??= "http://localhost:3000";
  process.env.APP_SECRET ??= "test-only-app-secret-0123456789";
  // Razorpay is never called: this stand-in makes the orders.
  const realPayments = await import("../lib/payments");
  mock.module("@/lib/payments", {
    namedExports: {
      ...realPayments,
      razorpayKeyId: () => "rzp_test_checkout",
      createOrder: async (input: { amountMinor: number; currency: string }) => {
        orders += 1;
        return { id: `order_chk_${run}_${orders}`, amount: input.amountMinor, currency: input.currency, status: "created" };
      },
    },
  });
  checkout = (await import("../app/api/checkout/route")).POST;
  if (skip) return;
  influencerId = (await prisma.influencer.create({ data: { slug: `checkout-${run}`, name: "Checkout Test", email: `checkout${run}@example.com` } })).id;
  serviceId = (await prisma.service.create({ data: { influencerId, title: "1:1", durationMin: 30, priceMinor: 49900 } })).id;
});

after(async () => {
  mock.reset();
  if (!skip && influencerId) await prisma.influencer.delete({ where: { id: influencerId } });
  await prisma.$disconnect();
});

test("without the booking's poll token there is no checkout, and no customer data in the answer", { skip }, async () => {
  const booking = await held();
  const other = await held();
  const selfService = new URL(buildSelfServiceUrl(booking.id)).pathname.split("/").pop()!;
  const before = orders;
  const missing = await checkout(post({ bookingId: booking.id }));
  assert.equal(missing.status, 400, "the token is required");
  for (const [label, token] of [
    ["another booking's poll token", signBookingPollToken(other.id)],
    ["a manage-link token for this booking (another purpose)", decodeURIComponent(selfService)],
    ["garbage", "not-a-token"],
    ["an expired poll token", signBookingPollToken(booking.id, -1)],
  ] as const) {
    const res = await checkout(post({ bookingId: booking.id, token }));
    assert.equal(res.status, 403, label);
    const text = await res.text();
    assert.doesNotMatch(text, new RegExp(booking.customerEmail.replace(/[.]/g, "\\.")), `${label}: no e-mail in the answer`);
  }
  assert.equal(orders, before, "no Razorpay order was created");
  const unchanged = await prisma.booking.findUniqueOrThrow({ where: { id: booking.id } });
  assert.equal(unchanged.status, "HELD");
  assert.equal(unchanged.holdExpiresAt?.getTime(), booking.holdExpiresAt?.getTime(), "the hold did not move");

  const ok = await checkout(post({ bookingId: booking.id, token: signBookingPollToken(booking.id) }));
  assert.equal(ok.status, 200);
  const body = (await ok.json()) as { orderId: string; customer: { email: string } };
  assert.equal(body.customer.email, booking.customerEmail);
  assert.equal(orders, before + 1);
});

test("the payment window starts with the order: calling checkout again resumes the order without extending the hold", { skip }, async () => {
  const booking = await held();
  const token = signBookingPollToken(booking.id);
  const first = (await (await checkout(post({ bookingId: booking.id, token }))).json()) as { orderId: string; holdExpiresAt: string };
  const extended = new Date(first.holdExpiresAt).getTime();
  assert.ok(extended >= Date.now() + (PAYMENT_WINDOW_MINUTES - 1) * MIN, "the first call opens the payment window");

  // Pretend the window is almost over, then call again: the order is reused and the hold is NOT pushed out again.
  const almostOver = new Date(Date.now() + 2 * MIN);
  await prisma.booking.update({ where: { id: booking.id }, data: { holdExpiresAt: almostOver } });
  const second = (await (await checkout(post({ bookingId: booking.id, token }))).json()) as { orderId: string; holdExpiresAt: string };
  assert.equal(second.orderId, first.orderId, "same order");
  assert.equal(new Date(second.holdExpiresAt).getTime(), almostOver.getTime(), "the answer reports the unchanged hold");
  assert.equal((await prisma.booking.findUniqueOrThrow({ where: { id: booking.id } })).holdExpiresAt?.getTime(), almostOver.getTime());

  // Once the hold has ended, checkout refuses: the seat is no longer reserved.
  await prisma.booking.update({ where: { id: booking.id }, data: { holdExpiresAt: new Date(Date.now() - 1000) } });
  assert.equal((await checkout(post({ bookingId: booking.id, token }))).status, 409);
});
