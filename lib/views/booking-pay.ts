import { prisma } from "@/lib/db";
import { formatMoney, formatSessionTime } from "@/lib/format";
import { buildSelfServiceUrl, signBookingPollToken, verifyPayToken } from "@/lib/self-service";
import { decodeSpaParam } from "@/lib/spa/routes";

/**
 * The page behind the payment link emailed after an influencer approves a booking request. Served by
 * GET /api/pay/:token.
 *
 * The signed link only identifies the booking; what can be done depends on the booking's state when the page loads, so
 * the answer is a union by `state` and is always a normal 200 (an invalid link is a screen, not an HTTP error). The
 * texts that depend on the server's locale (`whenText`, `amountText`, `payByText`: Indian Standard Time and rupees) are
 * formatted here, exactly as the page always did. Nothing about the customer (name, email, phone) is part of it.
 */
export type PayView =
  | { state: "invalid" }
  | { state: "not-found" }
  | { state: "booked"; serviceTitle: string; hostName: string; whenText: string; manageUrl: string | null }
  | { state: "requested"; hostName: string; serviceTitle: string }
  | { state: "declined"; hostName: string; hostSlug: string }
  /**
   * A booking with money behind it that was cancelled: by the customer from the manage link (the policy decides the refund), or because
   * a payment arrived after it was cancelled (a full refund is flagged). Never the "declined request, nothing was charged" screen.
   * `refund`: `issued` = the payment is refunded, `on-its-way` = a refund is flagged, pending or partly paid, `none` = the policy
   * gives none.
   */
  | { state: "cancelled"; hostName: string; hostSlug: string; refund: "issued" | "on-its-way" | "none" }
  /**
   * The customer's payment was captured but the booking could not be honoured (amount mismatch, paid after the hold ended and the slot
   * was taken, paid after the session started, the calendar rejected the event: status FAILED). Not "the time to pay has passed":
   * that invites a second payment. No pay button, ever.
   */
  | { state: "not-completed" }
  | { state: "expired"; hostSlug: string }
  /** The booking could still be paid, but the host's account is suspended by the platform (checkout refuses it): no pay button. Nothing was charged. */
  | { state: "unavailable"; hostName: string }
  | {
      state: "payable";
      bookingId: string;
      /** Lets the browser that opens this page poll the booking after payment (the same token the booking flow gets). */
      pollToken: string;
      hostName: string;
      serviceTitle: string;
      whenText: string;
      amountText: string;
      payByText: string;
      prepNotes: string | null;
    };

/** `token` as it appears in the URL path (still percent-encoded, or already decoded: both work). */
export async function loadPayView(token: string): Promise<PayView> {
  const bookingId = verifyPayToken(decodeSpaParam(token));
  if (!bookingId) return { state: "invalid" };
  const booking = await prisma.booking.findUnique({
    where: { id: bookingId },
    include: {
      payments: { select: { status: true, needsRefund: true, refundAmountMinor: true } },
      session: { include: { service: { include: { influencer: { select: { name: true, slug: true, suspendedAt: true } } } } } },
    },
  });
  // A booking erased on request is as good as missing here too (as in the manage view): its customer asked to be forgotten, and
  // the "already booked" answer would mint a fresh 30-day manage link for it.
  if (!booking || booking.redactedAt) return { state: "not-found" };
  const { service } = booking.session;
  const host = service.influencer;
  const when = formatSessionTime(booking.session.startTime);
  const now = new Date();

  if (["PAID", "SCHEDULED", "COMPLETED"].includes(booking.status)) {
    let manageUrl: string | null = null;
    try {
      manageUrl = buildSelfServiceUrl(booking.id);
    } catch {
      manageUrl = null;
    }
    return { state: "booked", serviceTitle: service.title, hostName: host.name, whenText: when, manageUrl };
  }
  // Money first: whatever the status, a booking with a captured (or refunded) payment is never "declined, you have not been charged",
  // never "the time to pay has passed" (which invites a second payment), and never gets a pay button.
  const paid = booking.payments.some((p) => p.status === "CAPTURED" || p.status === "REFUNDED");
  if (booking.status === "CANCELLED") {
    if (!paid) return { state: "declined", hostName: host.name, hostSlug: host.slug };
    const refund = booking.payments.some((p) => p.status === "REFUNDED")
      ? "issued"
      : booking.payments.some((p) => p.needsRefund || (p.refundAmountMinor ?? 0) > 0)
        ? "on-its-way"
        : "none";
    return { state: "cancelled", hostName: host.name, hostSlug: host.slug, refund };
  }
  if (paid) return { state: "not-completed" };
  if (booking.status === "REQUESTED") return { state: "requested", hostName: host.name, serviceTitle: service.title };
  const payable = (booking.status === "HELD" || booking.status === "PENDING_PAYMENT") && booking.holdExpiresAt !== null && booking.holdExpiresAt > now;
  if (!payable) return { state: "expired", hostSlug: host.slug };
  if (host.suspendedAt) return { state: "unavailable", hostName: host.name };

  return {
    state: "payable",
    bookingId: booking.id,
    pollToken: signBookingPollToken(booking.id),
    hostName: host.name,
    serviceTitle: service.title,
    whenText: when,
    amountText: formatMoney(service.priceMinor, service.currency),
    payByText: formatSessionTime(booking.holdExpiresAt!),
    prepNotes: service.prepNotes,
  };
}
