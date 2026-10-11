import { adminRefundEligibility } from "@/lib/admin/refund";
import { prisma } from "@/lib/db";
import { listPayments,MISMATCH_BOOKING_STATUSES, paymentViewCounts, parsePage, type PaymentFilter } from "@/lib/admin/data";

/**
 * The admin Payments page's data, for GET /api/admin/payments. The caller has already passed the admin
 * gate (`requireAdminMfa()`).
 */

/** The filter tabs; "all" is the default. Any other `?view=` is treated as "all". */
export const PAYMENT_VIEW_KEYS = ["all", "unreconciled", "captured", "needs-refund", "mismatch", "unpaid"] as const;
export type PaymentViewKey = (typeof PAYMENT_VIEW_KEYS)[number];

export function parsePaymentView(value: string | null | undefined): PaymentViewKey {
  return PAYMENT_VIEW_KEYS.find((k) => k === value) ?? "all";
}

export interface AdminPaymentRow {
  id: string;
  createdAt: Date;
  status: string;
  needsRefund: boolean;
  refundStatus: string | null;
  refundAmountMinor: number | null;
  amountMinor: number;
  currency: string;
  /** Checked against Razorpay by an administrator (the page shows "Yes" and an Undo button; the time and who did it are not shown). */
  reconciled: boolean;
  /** The payment went into a payout (the page shows "In payout" and offers no reconcile or undo; the payout is not named). */
  inPayout: boolean;
  /** What the "Razorpay" column shows: the Razorpay payment id, or the order id while there is no payment id. Nothing else of the provider ids is sent. */
  razorpayId: string;
  /** Captured, but the booking is in a state that should not coexist with a captured payment (computed on the server). */
  mismatch: boolean;
  /** Whether the Refund button is offered, worked out on the server (adminRefundEligibility); `reason` says why not, `remainingMinor` is what a refund would return. */
  refund: { allowed: boolean; reason: string | null; remainingMinor: number };
  booking: { status: string; customerName: string };
  service: { title: string };
  influencer: { id: string; name: string };
}

export interface AdminPaymentsView {
  view: PaymentViewKey;
  page: number;
  pageCount: number;
  total: number;
  /** The number on each tab. */
  counts: { all: number; unreconciled: number; captured: number; needsRefund: number; mismatch: number; unpaid: number };
  rows: AdminPaymentRow[];
}

export async function loadAdminPaymentsView(params: { view?: string | null; page?: string | null }): Promise<AdminPaymentsView> {
  const view = parsePaymentView(params.view);
  const page = parsePage(params.page ?? undefined);
  const filter: PaymentFilter = { view: view === "all" ? undefined : view };
  const [data, counts] = await Promise.all([listPayments(page, filter), paymentViewCounts()]);
  // Whether a refund is offered depends on the status of the payout a payment is locked in (a pending one blocks it): one more read, by id.
  const payoutIds = [...new Set(data.rows.map((p) => p.payoutId).filter((id): id is string => id !== null))];
  const payouts = payoutIds.length ? await prisma.payout.findMany({ where: { id: { in: payoutIds } }, select: { id: true, status: true } }) : [];
  const payoutStatus = new Map(payouts.map((p) => [p.id, p.status as string]));
  // A flagged payment on a live booking is refundable only when the booking has ANOTHER captured payment (a real duplicate).
  const flaggedBookingIds = [...new Set(data.rows.filter((p) => p.needsRefund && p.booking).map((p) => p.booking.id))];
  const captured = flaggedBookingIds.length
    ? await prisma.payment.findMany({ where: { bookingId: { in: flaggedBookingIds }, status: "CAPTURED" }, select: { id: true, bookingId: true } })
    : [];
  const now = new Date();
  return {
    view,
    page: data.page,
    pageCount: data.pageCount,
    total: data.total,
    counts: {
      all: counts.all,
      unreconciled: counts.unreconciled,
      captured: counts.captured,
      needsRefund: counts.needsRefund,
      mismatch: counts.mismatch,
      unpaid: counts.unpaid,
    },
    // A payment deleted together with its booking (a cascade) while the page is being read can come back without its relations. It no
    // longer exists, so it is left out, instead of the whole page failing on it.
    rows: data.rows.filter((p) => p.booking?.session?.service?.influencer).map((p) => ({
      id: p.id,
      createdAt: p.createdAt,
      status: p.status,
      needsRefund: p.needsRefund,
      refundStatus: p.refundStatus,
      refundAmountMinor: p.refundAmountMinor,
      amountMinor: p.amountMinor,
      currency: p.currency,
      reconciled: p.reconciledAt !== null,
      inPayout: p.payoutId !== null,
      razorpayId: p.providerPaymentId ?? p.providerOrderId,
      mismatch: p.status === "CAPTURED" && (MISMATCH_BOOKING_STATUSES as readonly string[]).includes(p.booking.status),
      refund: (() => {
        const e = adminRefundEligibility(
          {
            ...p,
            hasOtherCapturedPayment: captured.some((c) => c.bookingId === p.booking.id && c.id !== p.id),
            booking: { status: p.booking.status, startTime: p.booking.session.startTime },
            payoutStatus: p.payoutId ? (payoutStatus.get(p.payoutId) ?? null) : null,
          },
          now,
        );
        return { allowed: e.allowed, reason: e.allowed ? null : e.reason, remainingMinor: e.remainingMinor };
      })(),
      booking: { status: p.booking.status, customerName: p.booking.customerName },
      service: { title: p.booking.session.service.title },
      influencer: { id: p.booking.session.service.influencer.id, name: p.booking.session.service.influencer.name },
    })),
  };
}
