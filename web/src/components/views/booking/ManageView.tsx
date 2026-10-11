import { ManageBooking } from "@/app/manage/[token]/ManageBooking";
import { FocusedLayout } from "@/components/site/SiteChrome";
import { Alert } from "@/components/ui/primitives";
import type { Jsonify } from "@/lib/jsonify";
import type { ManageView as ManageViewData } from "@/lib/views/booking-manage";

/**
 * The customer self-service page (`/manage/:token`): the booking with its reschedule and cancel actions, or a friendly
 * notice when the link is invalid, expired, or points at a booking that is gone or was erased on request.
 */
export function ManageView({ data }: { data: Jsonify<ManageViewData> }) {
  if (data.state === "ok") return <ManageBooking key={data.booking.token} data={data.booking} />;
  const expired = data.state === "expired";
  return (
    <FocusedLayout>
      <div className="stack stack--lg">
        <h1 className="focused__title">Manage your booking</h1>
        <Alert tone="warning" title={expired ? "This link has expired" : "We could not find this booking"}>
          {expired
            ? "For your security, management links expire. Use the most recent link from your confirmation email, or contact the host."
            : "It may have been removed. Contact the host if you think this is a mistake."}
        </Alert>
      </div>
    </FocusedLayout>
  );
}
