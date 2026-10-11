import { AppLink } from "@web/lib/link";
import { PayNow } from "@web/pages/booking/PayNow";
import { FocusedLayout } from "@web/components/site/SiteChrome";
import { Alert } from "@web/components/ui/primitives";
import type { Jsonify } from "@/lib/jsonify";
import type { PayView as PayViewData } from "@/lib/views/booking-pay";

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

/**
 * The page behind the payment link emailed after an influencer approves a booking request (`/pay/:token`). The signed
 * link only identifies the booking; `data.state` says what can be done with it (GET /api/pay/:token).
 */
export function PayView({ data }: { data: Jsonify<PayViewData> }) {
  switch (data.state) {
    case "invalid":
      return (
        <Notice title="This link has expired" tone="danger">
          The payment link is invalid or has expired. If you were approved, ask the host to approve again, or request the session again.
        </Notice>
      );
    case "not-found":
      return (
        <Notice title="Booking not found" tone="danger">
          We could not find this booking.
        </Notice>
      );
    case "booked":
      return (
        <Notice title="You're already booked" tone="success">
          {data.serviceTitle} with {data.hostName}, {data.whenText}. {data.manageUrl ? <AppLink href={data.manageUrl}>Manage your booking</AppLink> : null}
        </Notice>
      );
    case "requested":
      return (
        <Notice title="Still waiting for approval" tone="warning">
          {data.hostName} has not answered your request for {data.serviceTitle} yet. We will email you a link to pay as soon as they do.
        </Notice>
      );
    case "declined":
      return (
        <Notice title="This request was not accepted" tone="danger">
          {data.hostName} could not accept this request. You have not been charged. <AppLink href={`/${data.hostSlug}/book`}>Choose another time</AppLink>.
        </Notice>
      );
    case "cancelled":
      return (
        <Notice title="This booking was cancelled" tone="warning">
          {data.refund === "issued"
            ? "This booking was cancelled and your payment has been refunded to your original payment method."
            : data.refund === "on-its-way"
              ? "This booking was cancelled. A refund is on its way to your original payment method."
              : "This booking was cancelled. Under its cancellation policy no refund is due; the cancellation email has the details."}{" "}
          <AppLink href={`/${data.hostSlug}/book`}>Book another time</AppLink>.
        </Notice>
      );
    case "not-completed":
      return (
        <Notice title="Payment received, but your booking could not be completed" tone="warning">
          We could not complete this booking, so you will be refunded. Please do not pay again.
        </Notice>
      );
    case "expired":
      return (
        <Notice title="The time to pay has passed" tone="danger">
          The held time was released. <AppLink href={`/${data.hostSlug}/book`}>Request the session again</AppLink>.
        </Notice>
      );
    case "payable":
      return (
        <FocusedLayout>
          <div className="stack stack--lg">
            <div className="stack stack--sm">
              <h1 className="focused__title">Complete your booking</h1>
              <p className="muted">
                {data.hostName} approved your request. Pay to confirm {data.serviceTitle}.
              </p>
            </div>
            <dl className="summary">
              <dt>Session</dt>
              <dd>{data.serviceTitle}</dd>
              <dt>With</dt>
              <dd>{data.hostName}</dd>
              <dt>When</dt>
              <dd>{data.whenText}</dd>
              <dt>Price</dt>
              <dd className="money">{data.amountText}</dd>
            </dl>
            {data.prepNotes && (
              <Alert tone="info" title="Before your session">
                {data.prepNotes}
              </Alert>
            )}
            <PayNow
              key={data.bookingId}
              bookingId={data.bookingId}
              pollToken={data.pollToken}
              hostName={data.hostName}
              serviceTitle={data.serviceTitle}
              amountText={data.amountText}
              payByText={data.payByText}
            />
          </div>
        </FocusedLayout>
      );
  }
}
