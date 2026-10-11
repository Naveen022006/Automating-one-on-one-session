import { useParams } from "react-router";
import { CustomerPortalView } from "@web/components/views/booking/CustomerPortalView";
import type { CustomerPortalView as CustomerPortalViewData } from "@/lib/views/customer-portal";
import { isApiError, useApiQuery, type ApiError } from "../../lib/api";
import { PageTitle } from "../../lib/head";
import type { Jsonify } from "../../lib/jsonify";
import { queryKeys } from "../../lib/query";
import { QueryGate } from "../../lib/states";

type PortalData = Jsonify<CustomerPortalViewData>;

/** A link that is unknown, expired or not a portal link is a 403 `{ state: "expired" }`: a screen, not an error. */
function expiredOf(error: ApiError | null): PortalData | undefined {
  return isApiError(error) && error.status === 403 && (error.data as { state?: unknown } | null)?.state === "expired" ? { state: "expired" } : undefined;
}

/**
 * `/bookings/:token`: the customer's list of bookings behind an e-mailed access link (valid for an hour). The token in the URL is the
 * only credential. Like the manage page it sets the `no-referrer` policy itself (React hoists the `<meta>` into the head), because the
 * header the shell sends only covers a full page load: without it, every request from this page to our own server would carry the
 * token in its Referer.
 */
export function Component() {
  const { token = "" } = useParams();
  const query = useApiQuery<PortalData>(queryKeys.customerPortal(token), `/api/customer/portal/${encodeURIComponent(token)}`);
  const refused = query.data === undefined ? expiredOf(query.error) : undefined;
  return (
    <>
      <meta name="referrer" content="no-referrer" />
      <PageTitle title="Your bookings" />
      {refused ? (
        <CustomerPortalView data={refused} token={token} />
      ) : (
        <QueryGate query={query} framed>
          {(data) => <CustomerPortalView data={data} token={token} onChanged={() => void query.refetch()} />}
        </QueryGate>
      )}
    </>
  );
}
