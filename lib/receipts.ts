import { BRAND_NAME } from "@/lib/brand";

/**
 * The printable receipt of a paid booking, shown in the customer portal and on the manage page. Pure: rows in, view out
 * (no DB, no clock), so both pages and the tests build it the same way. It carries nothing the confirmation e-mail does not
 * already carry: the booking reference, the customer's own name, the host and service, the amount and the Razorpay payment id.
 */
export interface ReceiptView {
  /** The booking id, already shown to customers as their reference. */
  reference: string;
  /** The customer's name as booked. */
  issuedTo: string;
  /** BRAND_NAME: the platform collects the payment. */
  seller: string;
  hostName: string;
  serviceTitle: string;
  sessionStart: string;
  paidAt: string;
  amountMinor: number;
  currency: string;
  /** The Razorpay payment id (also in the confirmation e-mail), or null while it is not known. */
  paymentReference: string | null;
  refundedMinor: number;
  statusText: "Paid" | "Partly refunded" | "Refunded";
}

export interface ReceiptBooking {
  id: string;
  customerName: string;
  session: { startTime: Date; service: { title: string; influencer: { name: string } } };
}

export interface ReceiptPayment {
  status: string;
  amountMinor: number;
  currency: string;
  createdAt: Date;
  providerPaymentId: string | null;
  refundAmountMinor: number | null;
  /** Set on a payment that could not be honoured (a duplicate or a late capture): it is not the one that bought the session. */
  needsRefund?: boolean;
}

/** How much of a payment has been given back (pending refunds count: the money is on its way). */
export function refundedMinorOf(p: Pick<ReceiptPayment, "status" | "amountMinor" | "refundAmountMinor">): number {
  const refunded = p.refundAmountMinor ?? (p.status === "REFUNDED" ? p.amountMinor : 0);
  return Math.max(0, Math.min(p.amountMinor, refunded));
}

/**
 * The payment that describes the booking: among the captured or refunded ones, a payment that is neither flagged for a refund nor
 * refunded in full comes first (so a refunded or flagged duplicate never makes a paid session read "Refunded"), then the earliest.
 */
export function pickReceiptPayment<T extends Pick<ReceiptPayment, "status" | "amountMinor" | "refundAmountMinor" | "createdAt" | "needsRefund">>(payments: readonly T[]): T | undefined {
  const rank = (p: T) => (!p.needsRefund && refundedMinorOf(p) < p.amountMinor ? 0 : 1);
  return payments
    .filter((p) => p.status === "CAPTURED" || p.status === "REFUNDED")
    .sort((a, b) => rank(a) - rank(b) || a.createdAt.getTime() - b.createdAt.getTime())[0];
}

/**
 * The receipt for a booking, or null when it never had a captured payment. With more than one payment, see pickReceiptPayment.
 * `paidAt` is the payment row's creation time, like the earnings export's `paid_at` (no capture time is stored).
 */
export function buildReceipt(booking: ReceiptBooking, payments: readonly ReceiptPayment[]): ReceiptView | null {
  const payment = pickReceiptPayment(payments);
  if (!payment) return null;
  const refundedMinor = refundedMinorOf(payment);
  return {
    reference: booking.id,
    issuedTo: booking.customerName,
    seller: BRAND_NAME,
    hostName: booking.session.service.influencer.name,
    serviceTitle: booking.session.service.title,
    sessionStart: booking.session.startTime.toISOString(),
    paidAt: payment.createdAt.toISOString(),
    amountMinor: payment.amountMinor,
    currency: payment.currency,
    paymentReference: payment.providerPaymentId,
    refundedMinor,
    statusText: refundedMinor >= payment.amountMinor ? "Refunded" : refundedMinor > 0 ? "Partly refunded" : "Paid",
  };
}
