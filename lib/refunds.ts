import { alertInfluencer } from "@/lib/alerts";
import { prisma } from "@/lib/db";
import { RazorpayHttpError, createRefund, listRefunds, type RazorpayRefund } from "@/lib/payments";

export { NOTICE_MS, describeRefundPolicy, refundDecision, type CancelActor, type RefundPolicy } from "@/lib/refund-policy";

/** Razorpay definitely rejected the refund (nothing was refunded); the influencer can retry. */
export class RefundError extends Error {}
/** The refund is not allowed (wrong state, wrong owner, bad amount, one already in flight). */
export class RefundNotAllowedError extends Error {}
/** The payment is locked in a PENDING payout (nothing was sent to Razorpay). The refund has to wait until that payout is paid or cancelled. */
export class RefundBlockedByPayoutError extends RefundNotAllowedError {}
/** The admin console's expected amount no longer matches what is left of the payment (nothing was sent to Razorpay). */
export class RefundAmountChangedError extends Error {}
/**
 * Razorpay did not confirm the outcome (timeout, 5xx, network). The refund may still go through, so the payment
 * stays locked as "requested" until a webhook or reconciliation reports what actually happened.
 */
export class RefundPendingError extends Error {}

/**
 * Recorded at the very START of a payment's `failureReason` by `cancelBooking` when the platform (an administrator) cancelled the booking.
 * `failureReason` otherwise always starts with "booking ..." or a system sentence, and a host's own reason only ever comes after that, so
 * text a host types can never produce this prefix; it is matched with `startsWith`, never `includes`. (No column of its own: no migration.)
 */
export const PLATFORM_CANCEL_PREFIX = "[platform-cancel] ";

/** How long an unconfirmed "requested" claim blocks new refunds before it is reconciled against Razorpay. */
export const CLAIM_STALE_MS = 10 * 60_000;

export interface RefundDeps {
  createRefund: (input: Parameters<typeof createRefund>[0]) => Promise<RazorpayRefund>;
  listRefunds: (providerPaymentId: string) => Promise<RazorpayRefund[]>;
  alert: typeof alertInfluencer;
}
const defaultDeps: RefundDeps = {
  createRefund: (i) => createRefund(i),
  listRefunds: (id) => listRefunds(id),
  alert: alertInfluencer,
};

type Db = Pick<typeof prisma, "payment" | "refund">;

/**
 * Recomputes a payment's refund summary from its `refunds` rows: total = every refund that has not failed. The
 * payment is REFUNDED once the total covers the amount paid, otherwise CAPTURED (partial refunds allowed).
 */
export async function recomputeRefundSummary(
  paymentId: string,
  db: Db = prisma,
  extra: { needsRefund?: boolean; latestStatus?: string } = {},
): Promise<{ refundedMinor: number; status: "CAPTURED" | "REFUNDED" }> {
  const payment = await db.payment.findUniqueOrThrow({
    where: { id: paymentId },
    select: { amountMinor: true, refunds: { select: { amountMinor: true, status: true, createdAt: true }, orderBy: { createdAt: "desc" } } },
  });
  const refundedMinor = payment.refunds.filter((r) => r.status !== "failed").reduce((n, r) => n + r.amountMinor, 0);
  const status = refundedMinor >= payment.amountMinor ? "REFUNDED" : "CAPTURED";
  await db.payment.update({
    where: { id: paymentId },
    data: {
      status,
      refundAmountMinor: refundedMinor || null,
      refundStatus: extra.latestStatus ?? payment.refunds[0]?.status ?? null,
      ...(status === "REFUNDED" ? { needsRefund: false } : {}),
      ...(extra.needsRefund !== undefined && status !== "REFUNDED" ? { needsRefund: extra.needsRefund } : {}),
    },
  });
  return { refundedMinor, status };
}

async function upsertRefundRow(db: Db, paymentId: string, r: { id: string; amount: number; status: string }) {
  await db.refund.upsert({
    where: { providerRefundId: r.id },
    create: { paymentId, providerRefundId: r.id, amountMinor: r.amount, status: r.status },
    update: { status: r.status },
  });
}

/** A refund's final outcome; nothing moves a refund out of these. */
const FINAL_REFUND_STATUSES = ["processed", "failed"];

/**
 * Records the refund Razorpay just created and returns its status as stored. A row a webhook already settled
 * (processed/failed) keeps its status: the create-refund answer can reach us after that webhook.
 */
async function recordCreatedRefund(paymentId: string, r: { id: string; amount: number; status: string }): Promise<string> {
  await prisma.refund.upsert({
    where: { providerRefundId: r.id },
    create: { paymentId, providerRefundId: r.id, amountMinor: r.amount, status: r.status },
    update: {},
  });
  await prisma.refund.updateMany({ where: { providerRefundId: r.id, status: { notIn: FINAL_REFUND_STATUSES } }, data: { status: r.status } });
  const row = await prisma.refund.findUnique({ where: { providerRefundId: r.id }, select: { status: true } });
  return row?.status ?? r.status;
}

/**
 * Settles an unconfirmed claim: asks Razorpay which refunds exist for the payment, records them, and releases the
 * claim. Called when a "requested" claim is older than CLAIM_STALE_MS.
 */
async function reconcile(paymentId: string, providerPaymentId: string, deps: RefundDeps): Promise<void> {
  const items = await deps.listRefunds(providerPaymentId);
  for (const r of items) await upsertRefundRow(prisma, paymentId, r);
  await recomputeRefundSummary(paymentId, prisma, { latestStatus: items[0]?.status ?? undefined });
  await prisma.payment.updateMany({ where: { id: paymentId, refundStatus: "requested" }, data: { refundStatus: null } });
}

/**
 * Issues a Razorpay refund for a captured payment (all of what is left, or `amountMinor`) and records it.
 *
 *  - Ownership: with `influencerId`, only that influencer's payments can be refunded.
 *  - No double refunds: the payment is first claimed (refundStatus = "requested") with a conditional update, so
 *    only one caller reaches Razorpay at a time.
 *  - A definite Razorpay rejection (4xx) releases the claim. An unclear outcome (timeout, 5xx, network) keeps it:
 *    the refund may have gone through, and the webhook or a later reconciliation settles it.
 *  - Partial refunds are tracked as a running total; the payment becomes REFUNDED once fully refunded.
 */
export async function refundPayment(
  paymentId: string,
  opts: {
    influencerId?: string;
    amountMinor?: number;
    reason?: string;
    /**
     * The claim fails while the payment is locked in a PENDING payout (that payout's figures would be stale: the influencer would be overpaid).
     * ON for every caller; pass `false` only for an internal caller that must refund regardless (none today).
     */
    blockPendingPayout?: boolean;
    /**
     * Admin console only: a CHECK, never the amount. The refund is refused (RefundAmountChangedError) unless what is left of the payment is
     * exactly this, both when read and when the claim is taken (the claim also requires the refund total it read to be unchanged).
     */
    expectedRemainingMinor?: number;
  } = {},
  overrides: Partial<RefundDeps> = {},
): Promise<{ refundId: string; status: string; amountMinor: number; fullyRefunded: boolean }> {
  const deps = { ...defaultDeps, ...overrides };
  const find = () =>
    prisma.payment.findFirst({
      where: {
        id: paymentId,
        ...(opts.influencerId ? { booking: { session: { service: { influencerId: opts.influencerId } } } } : {}),
      },
    });
  let payment = await find();
  if (!payment) throw new RefundNotAllowedError("Payment not found");
  if (payment.status === "REFUNDED") throw new RefundNotAllowedError("This payment was already refunded in full");
  if (payment.status !== "CAPTURED" || !payment.providerPaymentId) {
    throw new RefundNotAllowedError("Only captured payments can be refunded");
  }
  const providerPaymentId = payment.providerPaymentId;

  if (payment.refundStatus === "requested") {
    if (Date.now() - payment.updatedAt.getTime() < CLAIM_STALE_MS) {
      throw new RefundNotAllowedError("A refund for this payment is already in progress. Wait for Razorpay to confirm it.");
    }
    await reconcile(payment.id, providerPaymentId, deps);
    payment = (await find())!;
    if (payment.status === "REFUNDED") throw new RefundNotAllowedError("This payment was already refunded in full");
  }

  const remaining = payment.amountMinor - (payment.refundAmountMinor ?? 0);
  const amountMinor = opts.amountMinor ?? remaining;
  if (remaining <= 0) throw new RefundNotAllowedError("This payment was already refunded in full");
  if (!Number.isInteger(amountMinor) || amountMinor <= 0 || amountMinor > remaining) {
    throw new RefundNotAllowedError("Refund amount must be between 1 and the amount not yet refunded");
  }

  if (opts.expectedRemainingMinor !== undefined && opts.expectedRemainingMinor !== remaining) {
    throw new RefundAmountChangedError("The amount left to refund changed. Reload the page and check it again.");
  }

  const previousStatus = payment.refundStatus;
  const blockPayout = opts.blockPendingPayout !== false;
  const claimed = await prisma.payment.updateMany({
    where: {
      id: payment.id,
      status: "CAPTURED",
      OR: [{ refundStatus: null }, { refundStatus: { in: ["pending", "processed", "failed"] } }],
      ...(blockPayout ? { AND: [{ OR: [{ payoutId: null }, { payout: { status: { not: "PENDING" as const } } }] }] } : {}),
      ...(opts.expectedRemainingMinor !== undefined ? { refundAmountMinor: payment.refundAmountMinor } : {}),
    },
    data: { refundStatus: "requested" },
  });
  if (claimed.count === 0) {
    if (blockPayout || opts.expectedRemainingMinor !== undefined) {
      // Say what actually changed (a payout took the payment, or another refund moved the total) instead of "in progress".
      const now = await prisma.payment.findUnique({ where: { id: payment.id }, select: { refundAmountMinor: true, payout: { select: { status: true } } } });
      if (blockPayout && now?.payout?.status === "PENDING") {
        throw new RefundBlockedByPayoutError(
          opts.influencerId
            ? "This payment is part of a payout the platform is preparing, so it cannot be refunded from here right now. If the booking was cancelled, the platform will process the refund once that payout is settled; you do not need to retry."
            : "This payment is in a pending payout. Cancel that payout first.",
        );
      }
      if (opts.expectedRemainingMinor !== undefined && now && now.refundAmountMinor !== payment.refundAmountMinor) {
        throw new RefundAmountChangedError("The amount left to refund changed. Reload the page and check it again.");
      }
    }
    throw new RefundNotAllowedError("A refund for this payment is already in progress");
  }

  let refund: RazorpayRefund;
  try {
    refund = await deps.createRefund({
      providerPaymentId,
      amountMinor,
      receipt: `rf_${payment.id}_${(payment.refundAmountMinor ?? 0) + amountMinor}`,
      notes: { paymentId: payment.id, bookingId: payment.bookingId, reason: (opts.reason ?? "").slice(0, 200) },
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (e instanceof RazorpayHttpError && e.definiteRejection) {
      await prisma.payment.update({ where: { id: payment.id }, data: { refundStatus: previousStatus } });
      throw new RefundError(message);
    }
    // Unclear outcome: keep the claim so nobody can refund again until Razorpay's answer is known.
    throw new RefundPendingError(
      "Razorpay did not confirm the refund in time. It may still go through; this payment updates automatically when Razorpay reports back.",
    );
  }

  // Razorpay can deliver refund.processed / refund.failed before its answer to this call reaches us; that webhook already
  // recorded the final outcome, which this (older) "pending" answer must not overwrite.
  const status = await recordCreatedRefund(payment.id, refund);
  await prisma.payment.update({ where: { id: payment.id }, data: { refundedAt: new Date() } });
  // A booking cancelled by the platform promised the customer a FULL refund (recorded in the payment's failureReason by cancelBooking, which
  // the prefix PLATFORM_CANCEL_PREFIX): a partial refund does not clear the flag; it goes when nothing is left to refund.
  const platformCancelled = (payment.failureReason ?? "").startsWith(PLATFORM_CANCEL_PREFIX);
  const summary = await recomputeRefundSummary(payment.id, prisma, { needsRefund: status === "failed" || platformCancelled, latestStatus: status });
  return {
    refundId: refund.id,
    status: refund.status,
    amountMinor: refund.amount ?? amountMinor,
    fullyRefunded: summary.status === "REFUNDED",
  };
}

/**
 * Applies a Razorpay `refund.processed` / `refund.failed` webhook. Refunds are matched by Razorpay's refund id, so
 * a late event for an older refund only ever updates that refund's own row and can never undo a newer one. A
 * refund we have no row for (issued in the Razorpay dashboard, or created during an unconfirmed call) is recorded.
 * Runs inside the payment webhook transaction (`db`).
 */
export async function applyRefundWebhook(
  event: "refund.processed" | "refund.failed",
  refund: { id: string; payment_id: string; amount?: number; status?: string },
  alert: typeof alertInfluencer = alertInfluencer,
  db: Db = prisma,
): Promise<boolean> {
  const existing = await db.refund.findUnique({ where: { providerRefundId: refund.id }, select: { paymentId: true, status: true } });
  const payment = existing
    ? await db.payment.findUnique({ where: { id: existing.paymentId }, include: { booking: { select: { id: true, session: { select: { service: { select: { influencerId: true } } } } } } } })
    : await db.payment.findFirst({ where: { providerPaymentId: refund.payment_id }, include: { booking: { select: { id: true, session: { select: { service: { select: { influencerId: true } } } } } } } });
  if (!payment) return false;

  const status = event === "refund.processed" ? "processed" : "failed";
  if (existing) {
    if (existing.status === status) return true; // replay of the same outcome
    await db.refund.update({ where: { providerRefundId: refund.id }, data: { status } });
  } else {
    if (refund.amount === undefined) return false;
    await db.refund.create({ data: { paymentId: payment.id, providerRefundId: refund.id, amountMinor: refund.amount, status } });
  }

  // Also settles an unconfirmed "requested" claim: the latest status replaces it.
  await recomputeRefundSummary(payment.id, db, {
    latestStatus: status,
    ...(status === "failed" ? { needsRefund: true } : {}),
  });

  if (status === "failed") {
    // alertInfluencer never throws, so a failed alert cannot roll the webhook transaction back.
    void alert(payment.booking.session.service.influencerId, {
      kind: "refund-failed",
      detail: "Razorpay could not complete a refund. The payment is flagged again so you can retry from the dashboard.",
      bookingId: payment.booking.id,
    });
  }
  return true;
}
