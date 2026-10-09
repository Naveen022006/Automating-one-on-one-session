import type { Metadata } from "next";
import Link from "next/link";
import { FocusedLayout } from "@/components/site/SiteChrome";
import { Alert } from "@/components/ui/primitives";
import { prisma } from "@/lib/db";
import { formatMoney, formatSessionTime } from "@/lib/format";
import { buildSelfServiceUrl, signBookingPollToken, verifyPayToken } from "@/lib/self-service";
import { PayNow } from "./PayNow";

export const metadata: Metadata = { title: "Complete your booking", robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

function Notice({ title, children, tone = "info" }: { title: string; children: React.ReactNode; tone?: "info" | "danger" | "warning" | "success" }) {
  return (
    <FocusedLayout>
      <div className="stack stack--lg">
        <h1 className="focused__title">{title}</h1>
        <Alert tone={tone}>{children}</Alert>
      </div>
    </FocusedLayout>
  );
}

// The page behind the payment link emailed after an influencer approves a booking request. The signed link only
// identifies the booking; what can be done depends on the booking's state when the page loads.
export default async function PayPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const bookingId = verifyPayToken(decodeURIComponent(token));
  if (!bookingId) {
    return (
      <Notice title="This link has expired" tone="danger">
        The payment link is invalid or has expired. If you were approved, ask the host to approve again, or request the session again.
      </Notice>
    );
  }
  const booking = await prisma.booking.findUnique({
    where: { id: bookingId },
    include: { session: { include: { service: { include: { influencer: { select: { name: true, slug: true, timezone: true } } } } } } },
  });
  if (!booking) {
    return (
      <Notice title="Booking not found" tone="danger">
        We could not find this booking.
      </Notice>
    );
  }
  const { service } = booking.session;
  const host = service.influencer;
  const tz = booking.customerTz ?? host.timezone;
  const when = formatSessionTime(booking.session.startTime, tz);
  const now = new Date();

  if (["PAID", "SCHEDULED", "COMPLETED"].includes(booking.status)) {
    let manage: string | null = null;
    try {
      manage = buildSelfServiceUrl(booking.id);
    } catch {
      manage = null;
    }
    return (
      <Notice title="You're already booked" tone="success">
        {service.title} with {host.name}, {when}. {manage ? <Link href={manage}>Manage your booking</Link> : null}
      </Notice>
    );
  }
  if (booking.status === "REQUESTED") {
    return (
      <Notice title="Still waiting for approval" tone="warning">
        {host.name} has not answered your request for {service.title} yet. We will email you a link to pay as soon as they do.
      </Notice>
    );
  }
  if (booking.status === "CANCELLED") {
    return (
      <Notice title="This request was not accepted" tone="danger">
        {host.name} could not accept this request. You have not been charged. <Link href={`/${host.slug}/book`}>Choose another time</Link>.
      </Notice>
    );
  }
  const payable = (booking.status === "HELD" || booking.status === "PENDING_PAYMENT") && booking.holdExpiresAt !== null && booking.holdExpiresAt > now;
  if (!payable) {
    return (
      <Notice title="The time to pay has passed" tone="danger">
        The held time was released. <Link href={`/${host.slug}/book`}>Request the session again</Link>.
      </Notice>
    );
  }

  return (
    <FocusedLayout>
      <div className="stack stack--lg">
        <div className="stack stack--sm">
          <h1 className="focused__title">Complete your booking</h1>
          <p className="muted">
            {host.name} approved your request. Pay to confirm {service.title}.
          </p>
        </div>
        <dl className="summary">
          <dt>Session</dt>
          <dd>{service.title}</dd>
          <dt>With</dt>
          <dd>{host.name}</dd>
          <dt>When</dt>
          <dd>{when}</dd>
          <dt>Price</dt>
          <dd className="money">{formatMoney(service.priceMinor, service.currency)}</dd>
        </dl>
        {service.prepNotes && (
          <Alert tone="info" title="Before your session">
            {service.prepNotes}
          </Alert>
        )}
        <PayNow
          bookingId={booking.id}
          pollToken={signBookingPollToken(booking.id)}
          hostName={host.name}
          serviceTitle={service.title}
          amountText={formatMoney(service.priceMinor, service.currency)}
          payByText={formatSessionTime(booking.holdExpiresAt!, tz)}
        />
      </div>
    </FocusedLayout>
  );
}
