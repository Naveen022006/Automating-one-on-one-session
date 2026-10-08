import type { Metadata } from "next";
import { FocusedLayout } from "@/components/site/SiteChrome";
import { Alert } from "@/components/ui/primitives";
import { prisma } from "@/lib/db";
import { describeRefundPolicy, refundDecision } from "@/lib/refund-policy";
import { verifySelfServiceToken } from "@/lib/self-service";
import { ManageBooking, type ManageBookingData } from "./ManageBooking";

export const metadata: Metadata = { title: "Manage your booking", robots: { index: false }, referrer: "no-referrer" };

// Public customer self-service page. The signed token in the path is verified before any booking is loaded or
// shown; an invalid/expired token renders a friendly 403. A valid token lets the customer reschedule or cancel
// their own booking.
export default async function ManagePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const bookingId = verifySelfServiceToken(token);
  const booking = bookingId
    ? await prisma.booking.findUnique({
        where: { id: bookingId },
        include: { session: { include: { service: { include: { influencer: true } } } }, payments: { where: { status: "CAPTURED" } } },
      })
    : null;

  if (!booking || booking.redactedAt) {
    return (
      <FocusedLayout>
        <div className="stack stack--lg">
          <h1 className="focused__title">Manage your booking</h1>
          <Alert tone="warning" title={bookingId ? "We could not find this booking" : "This link has expired"}>
            {bookingId
              ? "It may have been removed. Contact the host if you think this is a mistake."
              : "For your security, management links expire. Use the most recent link from your confirmation email, or contact the host."}
          </Alert>
        </div>
      </FocusedLayout>
    );
  }

  const { session } = booking;
  const { service } = session;
  const policy = booking.refundPolicy ?? service.refundPolicy;
  const decision = refundDecision({ policy, actor: "customer", sessionStart: session.startTime });
  const msToStart = session.startTime.getTime() - Date.now();
  const data: ManageBookingData = {
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
  };
  return <ManageBooking data={data} />;
}
