import { prisma } from "@/lib/db";
import { describeRefundPolicy, refundDecision } from "@/lib/refund-policy";
import { verifySelfServiceToken } from "@/lib/self-service";

/** What the manage page's client component (web/src/pages/booking/ManageBooking.tsx) shows and acts on. */
export interface ManageBookingData {
  /** The self-service token from the URL: the component posts its actions to /api/manage/<token>. */
  token: string;
  bookingId: string;
  serviceId: string;
  serviceTitle: string;
  serviceType: "ONE_TO_ONE" | "GROUP";
  durationMin: number;
  influencerName: string;
  customerName: string;
  status: string;
  startTime: string;
  meetLink: string | null;
  canManage: boolean;
  /** False for group sessions, inside a 24-hour notice window and while the host's account is suspended (no open times are offered then). */
  canReschedule: boolean;
  /** The platform suspended the host: rescheduling is unavailable for now, cancelling still works. Says nothing else about the account. */
  hostSuspended: boolean;
  refundPolicyText: string;
  cancelRefundText: string | null;
}

/**
 * Public customer self-service page. The signed token in the path is verified before any booking is loaded or shown;
 * an invalid or expired token is `expired`, a valid one for a missing or erased booking is `not-found`. A valid token
 * lets the customer reschedule or cancel their own booking. Served by
 * GET /api/manage/:token (403 / 404 / 200).
 */
export type ManageView = { state: "expired" } | { state: "not-found" } | { state: "ok"; booking: ManageBookingData };

export async function loadManageView(token: string): Promise<ManageView> {
  const bookingId = verifySelfServiceToken(token);
  if (!bookingId) return { state: "expired" };
  const booking = await prisma.booking.findUnique({
    where: { id: bookingId },
    include: { session: { include: { service: { include: { influencer: { select: { name: true, suspendedAt: true } } } } } }, payments: { where: { status: "CAPTURED" } } },
  });
  if (!booking || booking.redactedAt) return { state: "not-found" };

  const { session } = booking;
  const { service } = session;
  const policy = booking.refundPolicy ?? service.refundPolicy;
  const decision = refundDecision({ policy, actor: "customer", sessionStart: session.startTime });
  const msToStart = session.startTime.getTime() - Date.now();
  // A suspended host offers no open times (the slot endpoints are not changed), so say so instead of showing an empty calendar.
  const hostSuspended = service.influencer.suspendedAt !== null;
  return {
    state: "ok",
    booking: {
      token,
      serviceId: service.id,
      serviceTitle: service.title,
      serviceType: service.type,
      durationMin: service.durationMin,
      influencerName: service.influencer.name,
      customerName: booking.customerName,
      status: booking.status,
      startTime: session.startTime.toISOString(),
      meetLink: booking.meetLink ?? session.meetLink,
      canManage: (booking.status === "PAID" || booking.status === "SCHEDULED") && msToStart > 0,
      canReschedule: service.type !== "GROUP" && !(policy === "NOTICE_24H" && msToStart < 24 * 3_600_000) && !hostSuspended,
      hostSuspended,
      refundPolicyText: describeRefundPolicy(policy),
      cancelRefundText:
        booking.payments.length === 0
          ? null
          : decision.refund
            ? "If you cancel now, you will be refunded in full to your original payment method."
            : "If you cancel now, no refund is due under this session's policy.",
      bookingId: booking.id,
    },
  };
}
