import "dotenv/config";
import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { Client } from "pg";
import { prisma } from "../lib/db";
import { nextRecoveryState } from "../lib/health-eval";
import { createHold } from "../lib/holds";
import { handleRazorpayEvent, type RazorpayWebhook } from "../lib/payment-webhook";
import {
  RECHECK_TIERS,
  RECOVERY_ACTOR,
  RECOVERY_MAX_AGE_MS,
  RECOVERY_MIN_AGE_MS,
  recheckIntervalMs,
  recoverableWhere,
  runPaymentRecovery,
  type RecoveryDeps,
} from "../lib/payment-recovery";
import { fetchOrderPayments, RazorpayHttpError, type RazorpayPayment } from "../lib/payments";

/**
 * Missed-webhook recovery. Razorpay is replaced by an injected lookup and the job queue by a recorder, so nothing
 * leaves the machine. The database tests need a migrated Postgres at DATABASE_URL (skipped otherwise) and create their
 * own influencer and rows; the recovery job is scoped to that influencer so it never touches anyone else's payments.
 */

const skip = process.env.DATABASE_URL ? false : "DATABASE_URL not set";
const run = Date.now();
let n = 0;
let influencerId: string;
let serviceId: string;
const base = new Date(Date.now() + 20 * 86_400_000);
base.setUTCMinutes(0, 0, 0);

const MIN = 60_000;
const ago = (ms: number) => new Date(Date.now() - ms);

/** Payment ids created by the running test. */
let scope: string[] = [];
beforeEach(() => {
  scope = [];
});

/** createHold runs in a 5 s transaction; on a slow or busy shared database it can time out before doing anything. Retry that. */
async function holdWithRetry(input: Parameters<typeof createHold>[0]) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await createHold(input);
    } catch (e) {
      const transient = /expired transaction|Unable to start a transaction|Transaction API error/.test(e instanceof Error ? e.message : "");
      if (!transient || attempt >= 3) throw e;
    }
  }
}

async function pendingBooking(opts: { bookingStatus?: "PENDING_PAYMENT" | "EXPIRED" | "HELD" | "PAID" | "CANCELLED"; ageMs?: number; amount?: number } = {}) {
  const idx = ++n;
  const start = new Date(base.getTime() + idx * 3_600_000);
  const hold = await holdWithRetry({
    serviceId,
    startTime: start,
    endTime: new Date(start.getTime() + 30 * MIN),
    capacity: 1,
    customerName: "Recovery Tester",
    customerEmail: `rec${run}_${idx}@example.com`,
    whatsappE164: "+919876543210",
    whatsappOptIn: true,
  });
  const orderId = `order_rec_${run}_${idx}`;
  await prisma.booking.update({ where: { id: hold.id }, data: { status: opts.bookingStatus ?? "PENDING_PAYMENT" } });
  const payment = await prisma.payment.create({
    data: {
      bookingId: hold.id,
      providerOrderId: orderId,
      amountMinor: opts.amount ?? 49900,
      currency: "INR",
      createdAt: ago(opts.ageMs ?? 10 * MIN),
    },
  });
  scope.push(payment.id);
  return { bookingId: hold.id, orderId, paymentId: payment.id, start };
}

const razorpay = (orderId: string, status: string, amount = 49900, currency = "INR"): RazorpayPayment[] => [
  { id: `pay_${orderId}`, order_id: orderId, amount, currency, status },
];

/** A stand-in for GET /orders/{id}/payments that records which orders were asked about. */
function lookup(answers: Record<string, RazorpayPayment[] | Error>) {
  const calls: string[] = [];
  const fn: RecoveryDeps["fetchOrderPayments"] = async (orderId) => {
    calls.push(orderId);
    const a = answers[orderId];
    if (a instanceof Error) throw a;
    return a ?? [];
  };
  return { fn, calls };
}
function recorder() {
  const queued: string[] = [];
  return { queued, enqueue: async (id: string) => void queued.push(id) };
}
const mine = () => ({ booking: { session: { service: { influencerId } } } });
/** Recovery limited to the payments the current test created, so tests cannot see each other's leftovers. */
const recover = (deps: Partial<RecoveryDeps>) => runPaymentRecovery({ extraWhere: { id: { in: scope } }, log: () => {}, ...deps });
const capturedEvent = (orderId: string, amount = 49900): RazorpayWebhook => ({
  event: "payment.captured",
  payload: { payment: { entity: { id: `pay_${orderId}`, order_id: orderId, amount, currency: "INR" } } },
});
const payment = (orderId: string) => prisma.payment.findUniqueOrThrow({ where: { providerOrderId: orderId } });
const booking = (id: string) => prisma.booking.findUniqueOrThrow({ where: { id } });

before(async () => {
  if (skip) return;
  const inf = await prisma.influencer.create({ data: { slug: `rec-${run}`, name: "Recovery Test", email: `rec${run}@example.com` } });
  influencerId = inf.id;
  serviceId = (await prisma.service.create({ data: { influencerId, title: "1:1", durationMin: 30, priceMinor: 49900 } })).id;
});

after(async () => {
  if (!skip && influencerId) {
    const ids = (await prisma.payment.findMany({ where: mine(), select: { id: true } })).map((p) => p.id);
    await prisma.adminAuditLog.deleteMany({ where: { adminEmail: RECOVERY_ACTOR.email, targetId: { in: ids } } });
    await prisma.influencer.delete({ where: { id: influencerId } });
    await prisma.$executeRaw`DELETE FROM webhook_events WHERE event_id LIKE ${"recovery:pay_order_rec_" + run + "%"} OR event_id LIKE ${"evt_rec_" + run + "%"}`;
  }
  await prisma.$disconnect();
});

// --- the Razorpay helper (no database) -------------------------------------------------------------------------

async function withRazorpayEnv<T>(fn: () => Promise<T>): Promise<T> {
  const prev = { id: process.env.RAZORPAY_KEY_ID, secret: process.env.RAZORPAY_KEY_SECRET };
  process.env.RAZORPAY_KEY_ID = "rzp_test_unit";
  process.env.RAZORPAY_KEY_SECRET = "unit_secret";
  try {
    return await fn();
  } finally {
    if (prev.id === undefined) delete process.env.RAZORPAY_KEY_ID;
    else process.env.RAZORPAY_KEY_ID = prev.id;
    if (prev.secret === undefined) delete process.env.RAZORPAY_KEY_SECRET;
    else process.env.RAZORPAY_KEY_SECRET = prev.secret;
  }
}

test("fetchOrderPayments calls GET /orders/{id}/payments with basic auth and a timeout", () =>
  withRazorpayEnv(async () => {
    let seen: { url: string; init?: RequestInit } | undefined;
    const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
      seen = { url: String(url), init };
      return new Response(JSON.stringify({ entity: "collection", count: 2, items: [{ id: "pay_1", status: "failed" }, { id: "pay_2", status: "captured" }] }), { status: 200 });
    }) as typeof fetch;
    const items = await fetchOrderPayments("order_ABC/../x", fakeFetch);
    assert.deepEqual(items.map((i) => i.id), ["pay_1", "pay_2"]);
    assert.equal(seen?.url, "https://api.razorpay.com/v1/orders/order_ABC%2F..%2Fx/payments", "the id is URL-encoded");
    assert.equal((seen?.init?.headers as Record<string, string>).Authorization, `Basic ${Buffer.from("rzp_test_unit:unit_secret").toString("base64")}`);
    assert.ok(seen?.init?.signal, "a timeout signal is attached");
    assert.deepEqual(await fetchOrderPayments("order_x", (async () => new Response("{}", { status: 200 })) as typeof fetch), []);
  }));

test("fetchOrderPayments throws RazorpayHttpError for non-2xx answers and the underlying error for network failures", () =>
  withRazorpayEnv(async () => {
    const notFound = (async () => new Response('{"error":{"description":"The id provided does not exist"}}', { status: 400 })) as typeof fetch;
    await assert.rejects(fetchOrderPayments("order_x", notFound), (e: unknown) => e instanceof RazorpayHttpError && e.status === 400 && e.definiteRejection);
    const unavailable = (async () => new Response("bad gateway", { status: 502 })) as typeof fetch;
    await assert.rejects(fetchOrderPayments("order_x", unavailable), (e: unknown) => e instanceof RazorpayHttpError && e.status === 502 && !e.definiteRejection);
    const down = (async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch;
    await assert.rejects(fetchOrderPayments("order_x", down), /fetch failed/);
    await assert.rejects(fetchOrderPayments("", notFound), /order id/);
  }));

test("recheckIntervalMs backs off with the age of the order", () => {
  assert.equal(recheckIntervalMs(5 * MIN), RECHECK_TIERS[0].everyMs);
  assert.equal(recheckIntervalMs(59 * MIN), RECHECK_TIERS[0].everyMs);
  assert.equal(recheckIntervalMs(61 * MIN), RECHECK_TIERS[1].everyMs);
  assert.equal(recheckIntervalMs(3 * 86_400_000), RECHECK_TIERS[2].everyMs);
  assert.ok(RECHECK_TIERS[0].everyMs < 2 * MIN, "fresh orders are looked at on every two-minute run");
});

// --- what gets checked ------------------------------------------------------------------------------------------

test("only unpaid orders between 3 minutes and 7 days old, with an unpaid booking, are candidates", { skip }, async () => {
  const young = await pendingBooking({ ageMs: 1 * MIN });
  const ok = await pendingBooking({ ageMs: 4 * MIN });
  const expired = await pendingBooking({ ageMs: 30 * MIN, bookingStatus: "EXPIRED" });
  const held = await pendingBooking({ ageMs: 20 * MIN, bookingStatus: "HELD" });
  const ancient = await pendingBooking({ ageMs: RECOVERY_MAX_AGE_MS + 3_600_000 });
  const paidBooking = await pendingBooking({ bookingStatus: "PAID" });
  const cancelled = await pendingBooking({ bookingStatus: "CANCELLED" });
  const captured = await pendingBooking();
  await prisma.payment.update({ where: { id: captured.paymentId }, data: { status: "CAPTURED" } });

  const found = await prisma.payment.findMany({ where: recoverableWhere(new Date(), mine()), select: { providerOrderId: true } });
  const orders = new Set(found.map((p) => p.providerOrderId));
  for (const yes of [ok, expired, held]) assert.ok(orders.has(yes.orderId), `${yes.orderId} should be a candidate`);
  for (const no of [young, ancient, paidBooking, cancelled, captured]) assert.ok(!orders.has(no.orderId), `${no.orderId} should not be a candidate`);
  assert.ok(RECOVERY_MIN_AGE_MS === 3 * MIN);
});

test("an order that was checked recently is left alone until its re-check interval has passed", { skip }, async () => {
  const hourOld = await pendingBooking({ ageMs: 2 * 3_600_000 }); // 30 min interval
  const dayOld = await pendingBooking({ ageMs: 2 * 86_400_000 }); // 6 h interval
  const fresh = await pendingBooking({ ageMs: 10 * MIN }); // 90 s interval
  const stamp = (id: string, ms: number) => prisma.payment.update({ where: { id }, data: { recoveryCheckedAt: ago(ms) } });
  const candidates = async () =>
    new Set((await prisma.payment.findMany({ where: recoverableWhere(new Date(), mine()), select: { providerOrderId: true } })).map((p) => p.providerOrderId));

  await stamp(hourOld.paymentId, 10 * MIN);
  await stamp(dayOld.paymentId, 5 * 3_600_000);
  await stamp(fresh.paymentId, 30_000);
  let c = await candidates();
  assert.ok(!c.has(hourOld.orderId) && !c.has(dayOld.orderId) && !c.has(fresh.orderId), "all three were checked too recently");

  await stamp(hourOld.paymentId, 31 * MIN);
  await stamp(dayOld.paymentId, 7 * 3_600_000);
  await stamp(fresh.paymentId, 2 * MIN);
  c = await candidates();
  assert.ok(c.has(hourOld.orderId) && c.has(dayOld.orderId) && c.has(fresh.orderId), "each is due again");
});

// --- recovery ---------------------------------------------------------------------------------------------------

test("a payment captured at Razorpay whose webhook never came is booked, with exactly one create-meeting job", { skip }, async () => {
  const { bookingId, orderId, paymentId } = await pendingBooking();
  const rec = recorder();
  // A failed card attempt first, then the attempt that went through.
  const l = lookup({ [orderId]: [{ ...razorpay(orderId, "failed")[0], id: `pay_failed_${orderId}` }, ...razorpay(orderId, "captured")] });

  const summary = await recover({ fetchOrderPayments: l.fn, enqueue: rec.enqueue });
  assert.equal(summary.recovered, 1);
  assert.deepEqual(summary.recoveredBookingIds, [bookingId]);
  assert.deepEqual(rec.queued, [bookingId]);

  const b = await booking(bookingId);
  assert.equal(b.status, "PAID");
  assert.equal(b.holdExpiresAt, null);
  const p = await payment(orderId);
  assert.equal(p.status, "CAPTURED");
  assert.equal(p.providerPaymentId, `pay_${orderId}`);
  assert.equal(p.needsRefund, false);

  // Recorded in the audit log under the system actor, and in webhook_events under a synthetic id.
  const audit = await prisma.adminAuditLog.findFirstOrThrow({ where: { targetId: paymentId, adminEmail: "system:payment-recovery" } });
  assert.equal(audit.adminId, null);
  assert.equal(audit.action, "payment.recovered");
  assert.equal(audit.targetType, "payment");
  assert.equal((audit.detail as { bookingId: string }).bookingId, bookingId);
  const events = await prisma.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM webhook_events WHERE provider = 'razorpay' AND event_id = ${"recovery:pay_" + orderId}`;
  assert.equal(Number(events[0].n), 1);

  // A second run does not even ask about it: it is paid now.
  const again = await recover({ fetchOrderPayments: l.fn, enqueue: rec.enqueue });
  assert.equal(again.recovered, 0);
  assert.equal(l.calls.length, 1);
  assert.deepEqual(rec.queued, [bookingId]);
});

test("an order Razorpay says is not paid is left untouched, stamped as checked, and not asked about again right away", { skip }, async () => {
  const { bookingId, orderId } = await pendingBooking();
  const rec = recorder();
  const l = lookup({ [orderId]: razorpay(orderId, "failed") });

  const before = Date.now();
  const first = await recover({ fetchOrderPayments: l.fn, enqueue: rec.enqueue });
  assert.equal(first.recovered, 0);
  assert.equal(first.lookupsOk, 1);
  assert.equal((await booking(bookingId)).status, "PENDING_PAYMENT");
  const p = await payment(orderId);
  assert.equal(p.status, "CREATED");
  assert.equal(p.providerPaymentId, null);
  assert.ok(p.recoveryCheckedAt && p.recoveryCheckedAt.getTime() >= before - 1000, "recoveryCheckedAt was set");
  assert.equal(rec.queued.length, 0);

  await recover({ fetchOrderPayments: l.fn, enqueue: rec.enqueue });
  assert.equal(l.calls.filter((c) => c === orderId).length, 1, "within the re-check interval it is not fetched again");
});

test("an order with no payment attempts at all is also just stamped", { skip }, async () => {
  const { orderId } = await pendingBooking();
  const l = lookup({ [orderId]: [] });
  await recover({ fetchOrderPayments: l.fn, enqueue: recorder().enqueue });
  assert.ok((await payment(orderId)).recoveryCheckedAt);
});

test("webhook first, then recovery: one job, and recovery has nothing left to ask", { skip }, async () => {
  const { bookingId, orderId } = await pendingBooking();
  const rec = recorder();
  assert.equal(await handleRazorpayEvent(`evt_rec_${run}_wf`, capturedEvent(orderId), rec.enqueue), "processed");
  const l = lookup({ [orderId]: razorpay(orderId, "captured") });
  const summary = await recover({ fetchOrderPayments: l.fn, enqueue: rec.enqueue });
  assert.equal(summary.recovered, 0);
  assert.equal(l.calls.includes(orderId), false);
  assert.deepEqual(rec.queued, [bookingId]);
});

test("recovery first, then the late webhook: one job, and the payment is not flagged for refund", { skip }, async () => {
  const { bookingId, orderId } = await pendingBooking();
  const rec = recorder();
  await recover({ fetchOrderPayments: lookup({ [orderId]: razorpay(orderId, "captured") }).fn, enqueue: rec.enqueue });
  assert.equal(await handleRazorpayEvent(`evt_rec_${run}_rf`, capturedEvent(orderId), rec.enqueue), "processed");
  assert.equal(await handleRazorpayEvent(`evt_rec_${run}_rf2`, { ...capturedEvent(orderId), event: "order.paid" }, rec.enqueue), "processed");
  assert.deepEqual(rec.queued, [bookingId]);
  const p = await payment(orderId);
  assert.equal(p.status, "CAPTURED");
  assert.equal(p.needsRefund, false, "a webhook arriving after recovery must not look like a second payment");
  assert.equal((await booking(bookingId)).status, "PAID");
});

test("recovery and the webhook at the same moment book the payment once", { skip }, async () => {
  for (let i = 0; i < 2; i++) {
    const { bookingId, orderId } = await pendingBooking();
    const rec = recorder();
    const l = lookup({ [orderId]: razorpay(orderId, "captured") });
    const [webhook] = await Promise.all([
      handleRazorpayEvent(`evt_rec_${run}_race${i}`, capturedEvent(orderId), rec.enqueue),
      recover({ fetchOrderPayments: l.fn, enqueue: rec.enqueue }),
    ]);
    assert.equal(webhook, "processed");
    assert.deepEqual(rec.queued, [bookingId], `round ${i}: exactly one job`);
    const p = await payment(orderId);
    assert.equal(p.status, "CAPTURED");
    assert.equal(p.needsRefund, false, `round ${i}: not flagged for a refund`);
    assert.equal((await booking(bookingId)).status, "PAID");
  }
});

/** True once some other database session is blocked waiting on a `SELECT ... FROM bookings WHERE id ... FOR UPDATE`. */
async function bookingLockHasAWaiter(timeoutMs = 30_000): Promise<boolean> {
  // A separate connection: with the pool at 2 both pooled connections are busy (the lock holder and the waiter).
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  try {
    await client.connect();
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const res = await client.query(
        `SELECT count(*)::int AS n FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query ILIKE '%FROM bookings WHERE id%FOR UPDATE%'`,
      );
      if (res.rows[0].n > 0) return true;
      await new Promise((r) => setTimeout(r, 400));
    }
    return false;
  } catch {
    return false;
  } finally {
    await client.end().catch(() => {});
  }
}

test("recovery that has to wait for the booking lock re-reads the payment under it and does not flag a refund", { skip }, async () => {
  const { bookingId, orderId, paymentId } = await pendingBooking();
  const rec = recorder();
  let proceed!: () => void;
  const gate = new Promise<void>((r) => (proceed = r));
  let locked!: () => void;
  const lockedP = new Promise<void>((r) => (locked = r));

  // Stands in for a webhook transaction that is part-way through applying this very payment: it holds the booking lock,
  // and will mark the payment captured and the booking paid before it lets go.
  const holder = prisma.$transaction(
    async (tx) => {
      await tx.$queryRaw`SELECT id FROM bookings WHERE id = ${bookingId} FOR UPDATE`;
      locked();
      await gate;
      await tx.payment.update({ where: { id: paymentId }, data: { status: "CAPTURED", providerPaymentId: `pay_${orderId}` } });
      await tx.booking.update({ where: { id: bookingId }, data: { status: "PAID", holdExpiresAt: null } });
      rec.queued.push(bookingId); // the webhook's enqueue
    },
    { timeout: 120_000 },
  );
  await Promise.race([lockedP, holder]);

  // Recovery reads the payment as unpaid (the holder has not committed), then blocks on the booking row.
  const recovery = recover({ fetchOrderPayments: lookup({ [orderId]: razorpay(orderId, "captured") }).fn, enqueue: rec.enqueue });
  const waited = await bookingLockHasAWaiter();
  proceed();
  await holder;
  const summary = await recovery;

  assert.ok(waited, "recovery really was blocked on the booking row lock (so the re-read under the lock was exercised)");
  assert.equal(summary.recovered, 0, "it saw the payment already applied once it got the lock");
  assert.equal(summary.flagged, 0);
  assert.equal(summary.applyFailures, 0);
  assert.deepEqual(rec.queued, [bookingId], "one job in total, the holder's");
  const p = await payment(orderId);
  assert.equal(p.status, "CAPTURED");
  assert.equal(p.needsRefund, false, "the late transaction must not mistake the now-PAID booking for a second payment");
  assert.equal((await booking(bookingId)).status, "PAID");
});

test("an already-recorded recovery id is a no-op", { skip }, async () => {
  const { bookingId, orderId } = await pendingBooking();
  await prisma.$executeRaw`INSERT INTO webhook_events (id, provider, event_id, type, received_at) VALUES (${"we_" + crypto.randomUUID()}, 'razorpay', ${"recovery:pay_" + orderId}, 'recovery.payment.captured', now())`;
  const rec = recorder();
  const summary = await recover({ fetchOrderPayments: lookup({ [orderId]: razorpay(orderId, "captured") }).fn, enqueue: rec.enqueue });
  assert.equal(summary.recovered, 0);
  assert.equal(rec.queued.length, 0);
  assert.equal((await booking(bookingId)).status, "PENDING_PAYMENT");
});

test("a hold that expired but whose slot is still free is honoured", { skip }, async () => {
  const { bookingId, orderId } = await pendingBooking({ bookingStatus: "EXPIRED", ageMs: 30 * MIN });
  const rec = recorder();
  const summary = await recover({ fetchOrderPayments: lookup({ [orderId]: razorpay(orderId, "captured") }).fn, enqueue: rec.enqueue });
  assert.equal(summary.recovered, 1);
  assert.deepEqual(rec.queued, [bookingId]);
  assert.equal((await booking(bookingId)).status, "PAID");
});

test("a hold that expired and whose slot was taken is flagged for refund, not booked", { skip }, async () => {
  const { bookingId, orderId, paymentId, start } = await pendingBooking({ bookingStatus: "EXPIRED", ageMs: 30 * MIN });
  await createHold({
    serviceId,
    startTime: start,
    endTime: new Date(start.getTime() + 30 * MIN),
    capacity: 1,
    customerName: "Someone else",
    customerEmail: `other${run}_${n}@example.com`,
    whatsappE164: "+919876543210",
    whatsappOptIn: true,
  });
  const rec = recorder();
  const summary = await recover({ fetchOrderPayments: lookup({ [orderId]: razorpay(orderId, "captured") }).fn, enqueue: rec.enqueue });
  assert.equal(summary.recovered, 0);
  assert.equal(summary.flagged, 1);
  assert.equal(rec.queued.length, 0);
  const p = await payment(orderId);
  assert.equal(p.status, "CAPTURED");
  assert.equal(p.needsRefund, true);
  assert.match(p.failureReason ?? "", /slot was taken/);
  assert.equal((await booking(bookingId)).status, "FAILED");
  const audit = await prisma.adminAuditLog.findFirstOrThrow({ where: { targetId: paymentId, adminEmail: RECOVERY_ACTOR.email } });
  assert.equal(audit.action, "payment.recovered_needs_refund");
});

test("a captured amount that differs from the order is flagged for refund", { skip }, async () => {
  const { bookingId, orderId } = await pendingBooking();
  const rec = recorder();
  const summary = await recover({ fetchOrderPayments: lookup({ [orderId]: razorpay(orderId, "captured", 100) }).fn, enqueue: rec.enqueue });
  assert.equal(summary.flagged, 1);
  assert.equal(rec.queued.length, 0);
  assert.equal((await payment(orderId)).needsRefund, true);
  assert.equal((await booking(bookingId)).status, "FAILED");
});

// --- failures never escape --------------------------------------------------------------------------------------

test("Razorpay unreachable: no throw, nothing changed, and the pass stops after a few failures in a row", { skip }, async () => {
  const orders = [];
  for (let i = 0; i < 5; i++) orders.push(await pendingBooking({ ageMs: (10 + i) * MIN }));
  const down = new TypeError("fetch failed");
  const l = lookup(Object.fromEntries(orders.map((o) => [o.orderId, down])));
  const rec = recorder();

  const summary = await recover({ fetchOrderPayments: l.fn, enqueue: rec.enqueue });
  assert.equal(summary.aborted, true);
  assert.equal(summary.lookupErrors, 3);
  assert.equal(summary.lookupsOk, 0);
  assert.equal(l.calls.length, 3, "does not keep hammering a dead API");
  assert.match(summary.lastError ?? "", /fetch failed/);
  assert.equal(rec.queued.length, 0);
  for (const o of orders) {
    const p = await payment(o.orderId);
    assert.equal(p.status, "CREATED");
    assert.equal(p.recoveryCheckedAt, null, "an outage is not a 'checked': they are retried first next time");
    assert.equal(p.recoveryError, null);
    assert.equal((await booking(o.bookingId)).status, "PENDING_PAYMENT");
  }
});

test("Razorpay not knowing the order is an answered lookup and is remembered as checked; a 5xx is a failed one and is not", { skip }, async () => {
  const unknown = await pendingBooking();
  const flaky = await pendingBooking({ ageMs: 11 * MIN });
  const l = lookup({
    [unknown.orderId]: new RazorpayHttpError(400, "The id provided does not exist"),
    [flaky.orderId]: new RazorpayHttpError(503, "unavailable"),
  });
  const summary = await recover({ fetchOrderPayments: l.fn, enqueue: recorder().enqueue });
  assert.equal(summary.lookupsOk, 1, "the 400 counts as answered");
  assert.equal(summary.unknownOrders, 1);
  assert.equal(summary.lookupErrors, 1, "only the 503 failed");
  assert.ok((await payment(unknown.orderId)).recoveryCheckedAt, "a definite 'no such order' backs off");
  assert.equal((await payment(flaky.orderId)).recoveryCheckedAt, null, "a 503 is retried next run");
});

test("a whole batch of unknown orders (test-mode orders under live keys) is answered, never aborts the run, and is not a failing streak", { skip }, async () => {
  const orders = [];
  for (let i = 0; i < 5; i++) orders.push(await pendingBooking({ ageMs: (10 + i) * MIN }));
  const l = lookup(Object.fromEntries(orders.map((o) => [o.orderId, new RazorpayHttpError(400, "The id provided does not exist")])));
  const summary = await recover({ fetchOrderPayments: l.fn, enqueue: recorder().enqueue });
  assert.equal(l.calls.length, 5, "all five were looked at: the 400s did not trip the stop-after-3-failures rule");
  assert.equal(summary.aborted, false);
  assert.equal(summary.lookupErrors, 0);
  assert.equal(summary.lookupsOk, 5);
  assert.equal(summary.unknownOrders, 5);
  for (const o of orders) assert.ok((await payment(o.orderId)).recoveryCheckedAt, "each backs off");
  const state = nextRecoveryState(
    { consecutiveFailedRuns: 2, lastRunAt: 0, lastError: "x", lastCandidates: 0, lastRecovered: 0 },
    { at: Date.now(), candidates: summary.candidates, lookupsOk: summary.lookupsOk, lookupErrors: summary.lookupErrors, recovered: 0, aborted: summary.aborted },
  );
  assert.equal(state.consecutiveFailedRuns, 0, "so no false 'Razorpay lookups are failing' alert either");
});

test("a payment Razorpay captured under 3 minutes ago is left for the webhook, then applied on a later run", { skip }, async () => {
  const { bookingId, orderId } = await pendingBooking();
  const rec = recorder();
  const attempt = (createdSecondsAgo: number): RazorpayPayment[] => [
    { ...razorpay(orderId, "captured")[0], created_at: Math.floor(Date.now() / 1000) - createdSecondsAgo },
  ];
  const first = await recover({ fetchOrderPayments: lookup({ [orderId]: attempt(30) }).fn, enqueue: rec.enqueue });
  assert.equal(first.tooFresh, 1);
  assert.equal(first.recovered, 0);
  assert.equal(rec.queued.length, 0);
  assert.equal((await booking(bookingId)).status, "PENDING_PAYMENT", "untouched: the webhook is probably seconds away");
  assert.equal((await payment(orderId)).recoveryCheckedAt, null, "not stamped, so the next run looks again straight away");

  const later = await recover({ fetchOrderPayments: lookup({ [orderId]: attempt(5 * 60) }).fn, enqueue: rec.enqueue });
  assert.equal(later.tooFresh, 0);
  assert.equal(later.recovered, 1);
  assert.deepEqual(rec.queued, [bookingId]);
});

// --- Redis hanging, session already started ---------------------------------------------------------------------

const neverResolves = () => new Promise<void>(() => {});

test("recovery: a hanging enqueue times out, rolls everything back, is recorded, and the next run applies it", { skip }, async () => {
  const { bookingId, orderId, paymentId } = await pendingBooking();
  const l = lookup({ [orderId]: razorpay(orderId, "captured") });

  const started = Date.now();
  const hung = await recover({ fetchOrderPayments: l.fn, enqueue: neverResolves, enqueueTimeoutMs: 300 });
  assert.ok(Date.now() - started < 20_000, "the run did not hang on the queue");
  assert.equal(hung.applyFailures, 1);
  assert.equal(hung.recovered, 0);
  assert.equal((await booking(bookingId)).status, "PENDING_PAYMENT", "the booking was NOT marked paid without a job");
  const p = await payment(orderId);
  assert.equal(p.status, "CREATED");
  assert.match(p.recoveryError ?? "", /timed out/);
  const events = await prisma.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM webhook_events WHERE event_id = ${"recovery:pay_" + orderId}`;
  assert.equal(Number(events[0].n), 0, "the idempotency record rolled back with it");
  assert.equal(await prisma.adminAuditLog.count({ where: { targetId: paymentId, adminEmail: RECOVERY_ACTOR.email } }), 0);

  const rec = recorder();
  const ok = await recover({ fetchOrderPayments: l.fn, enqueue: rec.enqueue });
  assert.equal(ok.recovered, 1);
  assert.deepEqual(rec.queued, [bookingId]);
  assert.equal((await booking(bookingId)).status, "PAID");
  assert.equal((await payment(orderId)).recoveryError, null);
});

test("webhook: a hanging enqueue times out and rolls back, so Razorpay's retry of the same event is processed", { skip }, async () => {
  const { bookingId, orderId } = await pendingBooking();
  const eventId = `evt_rec_${run}_hang`;
  await assert.rejects(handleRazorpayEvent(eventId, capturedEvent(orderId), neverResolves, { enqueueTimeoutMs: 300 }), /timed out/);
  assert.equal((await booking(bookingId)).status, "PENDING_PAYMENT");
  assert.equal((await payment(orderId)).status, "CREATED");
  const rec = recorder();
  assert.equal(await handleRazorpayEvent(eventId, capturedEvent(orderId), rec.enqueue), "processed", "the event was not recorded as seen");
  assert.deepEqual(rec.queued, [bookingId]);
});

/** Moves the booking's session to one hour ago, as if the customer paid (or recovery found it) after the session began. */
async function startSessionInThePast(bookingId: string) {
  const b = await prisma.booking.findUniqueOrThrow({ where: { id: bookingId }, select: { sessionId: true } });
  const start = new Date(Date.now() - 3_600_000);
  await prisma.session.update({ where: { id: b.sessionId }, data: { startTime: start, endTime: new Date(start.getTime() + 30 * MIN) } });
}

test("a payment captured after the session has started is flagged for refund, not booked (recovery)", { skip }, async () => {
  const { bookingId, orderId } = await pendingBooking();
  await startSessionInThePast(bookingId);
  const rec = recorder();
  const summary = await recover({ fetchOrderPayments: lookup({ [orderId]: razorpay(orderId, "captured") }).fn, enqueue: rec.enqueue });
  assert.equal(summary.recovered, 0);
  assert.equal(summary.flagged, 1);
  assert.equal(rec.queued.length, 0);
  const p = await payment(orderId);
  assert.equal(p.status, "CAPTURED");
  assert.equal(p.needsRefund, true);
  assert.match(p.failureReason ?? "", /session had already started/);
  assert.equal((await booking(bookingId)).status, "FAILED");
});

test("a payment captured after the session has started is flagged for refund, not booked (webhook)", { skip }, async () => {
  const { bookingId, orderId } = await pendingBooking({ bookingStatus: "EXPIRED" });
  await startSessionInThePast(bookingId);
  const rec = recorder();
  assert.equal(await handleRazorpayEvent(`evt_rec_${run}_past`, capturedEvent(orderId), rec.enqueue), "processed");
  assert.equal(rec.queued.length, 0);
  const p = await payment(orderId);
  assert.equal(p.needsRefund, true);
  assert.match(p.failureReason ?? "", /session had already started/);
  assert.equal((await booking(bookingId)).status, "FAILED");
});

test("a second payment on a booking that is already paid is flagged but the paid booking is left alone, even after the session started", { skip }, async () => {
  const { bookingId, orderId } = await pendingBooking({ bookingStatus: "PAID" });
  await startSessionInThePast(bookingId);
  const rec = recorder();
  await handleRazorpayEvent(`evt_rec_${run}_second`, capturedEvent(orderId), rec.enqueue);
  assert.equal(rec.queued.length, 0);
  assert.equal((await payment(orderId)).needsRefund, true);
  assert.match((await payment(orderId)).failureReason ?? "", /while booking was PAID/);
  assert.equal((await booking(bookingId)).status, "PAID", "a paid booking is never turned into FAILED by a duplicate payment");
});

test("if queueing the meeting job fails the payment is rolled back, remembered as unapplied, and retried", { skip }, async () => {
  const { bookingId, orderId } = await pendingBooking();
  const l = lookup({ [orderId]: razorpay(orderId, "captured") });
  const failed = await recover({
    fetchOrderPayments: l.fn,
    enqueue: async () => {
      throw new Error("redis down");
    },
  });
  assert.equal(failed.applyFailures, 1);
  assert.equal(failed.recovered, 0);
  assert.equal((await booking(bookingId)).status, "PENDING_PAYMENT");
  let p = await payment(orderId);
  assert.equal(p.status, "CREATED");
  assert.match(p.recoveryError ?? "", /redis down/);
  const events = await prisma.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM webhook_events WHERE event_id = ${"recovery:pay_" + orderId}`;
  assert.equal(Number(events[0].n), 0, "the idempotency record rolled back with everything else");
  const audits = await prisma.adminAuditLog.count({ where: { targetId: p.id, adminEmail: RECOVERY_ACTOR.email } });
  assert.equal(audits, 0, "no audit row for a rolled-back recovery");

  const rec = recorder();
  const ok = await recover({ fetchOrderPayments: l.fn, enqueue: rec.enqueue });
  assert.equal(ok.recovered, 1);
  assert.deepEqual(rec.queued, [bookingId]);
  p = await payment(orderId);
  assert.equal(p.status, "CAPTURED");
  assert.equal(p.recoveryError, null, "cleared once applied");
});

test("a run whose database query fails does not throw", { skip }, async () => {
  const summary = await runPaymentRecovery({
    extraWhere: { id: 12345 as never }, // rejected by Prisma at query time
    log: () => {},
    fetchOrderPayments: async () => [],
  });
  assert.equal(summary.aborted, true);
  assert.equal(summary.candidates, 0);
  assert.ok(summary.lastError);
});

// --- batching ---------------------------------------------------------------------------------------------------

test("a run takes at most batchSize payments: never-checked first, then the longest-unchecked", { skip }, async () => {
  const p1 = await pendingBooking({ ageMs: 40 * MIN });
  const p2 = await pendingBooking({ ageMs: 39 * MIN });
  const p3 = await pendingBooking({ ageMs: 38 * MIN });
  const p4 = await pendingBooking({ ageMs: 37 * MIN });
  const p5 = await pendingBooking({ ageMs: 36 * MIN });
  await prisma.payment.update({ where: { id: p2.paymentId }, data: { recoveryCheckedAt: ago(5 * MIN) } });
  await prisma.payment.update({ where: { id: p4.paymentId }, data: { recoveryCheckedAt: ago(8 * MIN) } });

  const l = lookup({});
  const first = await recover({ fetchOrderPayments: l.fn, enqueue: recorder().enqueue, batchSize: 3 });
  assert.equal(first.candidates, 3);
  assert.deepEqual(l.calls, [p1.orderId, p3.orderId, p5.orderId], "unchecked payments first, oldest first");

  // The three just checked are not due again, so the next run reaches the ones that were passed over, longest-unchecked first.
  l.calls.length = 0;
  const second = await recover({ fetchOrderPayments: l.fn, enqueue: recorder().enqueue, batchSize: 3 });
  assert.equal(second.candidates, 2);
  assert.deepEqual(l.calls, [p4.orderId, p2.orderId]);
});
