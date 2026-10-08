import { prisma } from "@/lib/db";
import { verifySelfServiceToken } from "@/lib/self-service";
import { ManageBooking, type ManageBookingData } from "./ManageBooking";

export const dynamic = "force-dynamic";

// Public customer self-service page. The signed token in the path is verified before any booking is loaded or
// shown; an invalid/expired token renders a friendly 403, mirroring the static-message style of
// app/api/google/callback/route.ts. A valid token lets the customer reschedule or cancel their own booking.
export default async function ManagePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const bookingId = verifySelfServiceToken(token);
  if (!bookingId) {
    return (
      <main>
        <h1>Manage your booking</h1>
        <p className="error" role="alert">
          This management link is invalid or has expired (403). Please check your confirmation email for the latest link.
        </p>
      </main>
    );
  }

  const booking = await prisma.booking.findUnique({
    where: { id: bookingId },
    include: { session: { include: { service: { include: { influencer: true } } } } },
  });
  if (!booking) {
    return (
      <main>
        <h1>Manage your booking</h1>
        <p className="error" role="alert">
          We could not find this booking (404).
        </p>
      </main>
    );
  }

  const { session } = booking;
  const { service } = session;
  const data: ManageBookingData = {
    token,
    serviceId: service.id,
    serviceTitle: service.title,
    influencerName: service.influencer.name,
    influencerTimezone: service.influencer.timezone,
    customerName: booking.customerName,
    status: booking.status,
    startTime: session.startTime.toISOString(),
    endTime: session.endTime.toISOString(),
    meetLink: booking.meetLink ?? session.meetLink,
    canManage: booking.status === "PAID" || booking.status === "SCHEDULED",
  };

  return <ManageBooking data={data} />;
}
