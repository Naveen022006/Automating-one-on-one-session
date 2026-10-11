import { prisma } from "@/lib/db";
import { describeRefundPolicy, refundDecision } from "@/lib/refund-policy";
import { verifySelfServiceToken } from "@/lib/self-service";

/** What the manage page's client component (app/manage/[token]/ManageBooking.tsx) shows and acts on. */
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
  /** False for group sessions and inside a 24-hour notice window. */
  canReschedule: boolean;
  refundPolicyText: string;
  cancelRefundText: string | null;
}

/**
 * Public customer self-service page. The signed token in the path is verified before any booking is loaded or shown;
 * an invalid or expired token is `expired`, a valid one for a missing or erased booking is `not-found`. A valid token
 * lets the customer reschedule or cancel their own booking. One function, two callers: the old Next page and
 * GET /api/manage/:token (403 / 404 / 200), so they cannot disagree.
 */
export type ManageView = { state: "expired" } | { state: "not-found" } | { state: "ok"; booking: ManageBookingData };

export async function loadManageView(token: string): Promise<ManageView> {
  const bookingId = verifySelfServiceToken(token);
  if (!bookingId) return { state: "expired" };
  const booking = await prisma.booking.findUnique({
    where: { id: bookingId },
    include: { session: { include: { service: { include: { influencer: { select: { name: true } } } } } }, payments: { where: { status: "CAPTURED" } } },
  });
  if (!booking || booking.redactedAt) return { state: "not-found" };

  const { session } = booking;
  const { service } = session;
  const policy = booking.refundPolicy ?? service.refundPolicy;
  const decision = refundDecision({ policy, actor: "customer", sessionStart: session.startTime });
  const msToStart = session.startTime.getTime() - Date.now();
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
      canReschedule: service.type !== "GROUP" && !(policy === "NOTICE_24H" && msToStart < 24 * 3_600_000),
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
