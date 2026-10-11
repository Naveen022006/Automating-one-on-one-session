import { listPayments, MISMATCH_BOOKING_STATUSES, paymentViewCounts, parsePage, type PaymentFilter } from "@/lib/admin/data";

/**
 * The admin Payments page's data, for the old Next page and GET /api/admin/payments. The caller has already passed the admin
 * gate (`requireAdminPage` / `requireAdminMfa()`).
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
      booking: { status: p.booking.status, customerName: p.booking.customerName },
      service: { title: p.booking.session.service.title },
      influencer: { id: p.booking.session.service.influencer.id, name: p.booking.session.service.influencer.name },
    })),
  };
}
