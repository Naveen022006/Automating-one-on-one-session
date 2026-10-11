import { recordAudit, type AuditActor } from "@/lib/admin/audit";
import { prisma } from "@/lib/db";
import { reportError } from "@/lib/observability";
import { CLAIM_STALE_MS, RefundError, RefundNotAllowedError, RefundPendingError, refundPayment } from "@/lib/refunds";

/**
 * Administrator refund of a captured payment, from the console. Money moves here, so the rules are few and strict:
 *
 *  - The amount is never supplied by the caller: it is always what is left of the payment (`amountMinor - refundAmountMinor`), read from
 *    the row on the server. `refundPayment` is called without an amount, so it refunds exactly that remainder.
 *  - Double clicks and two administrators at once are settled by `refundPayment`'s conditional claim (`refundStatus = "requested"`, one
 *    winner) and by Razorpay's deterministic receipt `rf_<paymentId>_<cumulative>`. Nothing here re-implements either.
 *  - An audit entry (`payment.refund_requested`) is written and awaited BEFORE Razorpay is called; if it cannot be written, nothing is
 *    refunded. The outcome is audited afterwards (`payment.refunded`, `payment.refund_pending`, `payment.refund_failed`,
 *    `payment.refund_refused`).
 *  - Refused while the booking is still an upcoming live session (cancel it first), unless the payment is flagged `needsRefund` (a double
 *    payment on a live booking), and while the payment is locked in a PENDING payout (that payout's snapshot would be wrong).
 *  - The webhook path (`applyRefundWebhook`) is untouched and still settles the refund by Razorpay's refund id.
 */

export interface RefundEligibilityInput {
  status: string;
  providerPaymentId: string | null;
  amountMinor: number;
  refundAmountMinor: number | null;
  refundStatus: string | null;
  /** When the payment row last changed; with `refundStatus = "requested"` this is when the refund was claimed. */
  updatedAt: Date;
  needsRefund: boolean;
  booking: { status: string; startTime: Date };
  /** Status of the payout the payment is locked in, or null when it is in none. */
  payoutStatus: string | null;
}

export type RefundEligibility =
  | { allowed: true; remainingMinor: number }
  /** `remainingMinor` is what a refund would be if the reason went away (0 when nothing is left). */
  | { allowed: false; reason: string; remainingMinor: number };

export function adminRefundEligibility(p: RefundEligibilityInput, now: Date = new Date()): RefundEligibility {
  const remainingMinor = Math.max(0, p.amountMinor - (p.refundAmountMinor ?? 0));
  const no = (reason: string): RefundEligibility => ({ allowed: false, reason, remainingMinor });
  if (p.status === "REFUNDED") return no("This payment was already refunded in full.");
  if (p.status !== "CAPTURED" || !p.providerPaymentId) return no("Only captured payments can be refunded.");
  if (remainingMinor <= 0) return no("This payment was already refunded in full.");
  if (p.refundStatus === "requested" && now.getTime() - p.updatedAt.getTime() < CLAIM_STALE_MS) return no("A refund is already in progress.");
  if ((p.booking.status === "PAID" || p.booking.status === "SCHEDULED") && p.booking.startTime.getTime() > now.getTime() && !p.needsRefund) {
    return no("Cancel the booking first (Bookings > Cancel).");
  }
  if (p.payoutStatus === "PENDING") return no("This payment is in a pending payout. Cancel that payout first.");
  return { allowed: true, remainingMinor };
}

export type AdminRefundResult =
  | { kind: "not-found" }
  | { kind: "not-allowed"; reason: string }
  | { kind: "failed"; message: string }
  | { kind: "pending" }
  | { kind: "ok"; status: string; amountMinor: number; fullyRefunded: boolean };

export interface AdminRefundDeps {
  refund: (paymentId: string, opts: { reason?: string }) => ReturnType<typeof refundPayment>;
  audit: typeof recordAudit;
}
const defaultDeps: AdminRefundDeps = { refund: (id, opts) => refundPayment(id, opts), audit: recordAudit };

/** Audit entries written AFTER the money call must not turn its outcome into a 500: the refund happened (or not) either way. */
async function auditAfter(deps: AdminRefundDeps, admin: AuditActor, paymentId: string, action: string, ip: string | null, detail: Record<string, string | number | boolean | null>) {
  try {
    await deps.audit(admin, { action, targetType: "payment", targetId: paymentId, detail, ip });
  } catch (e) {
    reportError(e, { where: "adminRefundPayment", action, paymentId });
  }
}

export async function adminRefundPayment(
  paymentId: string,
  admin: AuditActor,
  reason: string,
  ip: string | null,
  overrides: Partial<AdminRefundDeps> = {},
  now: Date = new Date(),
): Promise<AdminRefundResult> {
  const deps = { ...defaultDeps, ...overrides };
  const payment = await prisma.payment.findUnique({
    where: { id: paymentId },
    select: {
      status: true,
      providerPaymentId: true,
      amountMinor: true,
      currency: true,
      refundAmountMinor: true,
      refundStatus: true,
      updatedAt: true,
      needsRefund: true,
      payout: { select: { status: true } },
      booking: { select: { status: true, session: { select: { startTime: true } } } },
    },
  });
  if (!payment || !payment.booking?.session) return { kind: "not-found" };
  const eligibility = adminRefundEligibility(
    { ...payment, booking: { status: payment.booking.status, startTime: payment.booking.session.startTime }, payoutStatus: payment.payout?.status ?? null },
    now,
  );
  if (!eligibility.allowed) return { kind: "not-allowed", reason: eligibility.reason };

  // Before Razorpay: if this write fails the error propagates (a 500) and nothing has been refunded.
  await deps.audit(admin, {
    action: "payment.refund_requested",
    targetType: "payment",
    targetId: paymentId,
    detail: { remainingMinor: eligibility.remainingMinor, currency: payment.currency, reason },
    ip,
  });

  try {
    const done = await deps.refund(paymentId, { reason });
    await auditAfter(deps, admin, paymentId, "payment.refunded", ip, {
      amountMinor: done.amountMinor,
      currency: payment.currency,
      status: done.status,
      fullyRefunded: done.fullyRefunded,
    });
    return { kind: "ok", status: done.status, amountMinor: done.amountMinor, fullyRefunded: done.fullyRefunded };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (e instanceof RefundNotAllowedError) {
      // Lost the race to another refund, or the row changed since it was read: nothing was sent to Razorpay.
      await auditAfter(deps, admin, paymentId, "payment.refund_refused", ip, { reason: message.slice(0, 200) });
      return { kind: "not-allowed", reason: message };
    }
    if (e instanceof RefundError) {
      await auditAfter(deps, admin, paymentId, "payment.refund_failed", ip, { error: message.slice(0, 200) });
      return { kind: "failed", message };
    }
    if (e instanceof RefundPendingError) {
      await auditAfter(deps, admin, paymentId, "payment.refund_pending", ip, { remainingMinor: eligibility.remainingMinor, currency: payment.currency });
      return { kind: "pending" };
    }
    // Not one of the refund errors (a database or code fault). The refund may or may not have reached Razorpay; the claim, if it was
    // taken, stays until a webhook or a later reconciliation settles it.
    await auditAfter(deps, admin, paymentId, "payment.refund_error", ip, { error: message.slice(0, 200) });
    throw e;
  }
}
