import { useParams } from "react-router";
import { ManageView } from "@/components/views/booking/ManageView";
import type { ManageView as ManageViewData } from "@/lib/views/booking-manage";
import { isApiError, useApiQuery, type ApiError } from "../../lib/api";
import { PageTitle } from "../../lib/head";
import type { Jsonify } from "../../lib/jsonify";
import { queryKeys } from "../../lib/query";
import { QueryGate } from "../../lib/states";

type ManageData = Jsonify<ManageViewData>;

/** A link that is invalid, expired or points at a missing booking is a 403 / 404 whose body says which: a screen, not an error. */
function stateOf(error: ApiError | null): ManageData | undefined {
  if (!isApiError(error) || (error.status !== 403 && error.status !== 404)) return undefined;
  const state = (error.data as { state?: unknown } | null)?.state;
  return state === "expired" || state === "not-found" ? { state } : undefined;
}

/**
 * `/manage/:token`: the customer's self-service page (reschedule, cancel). The token in the URL is the only credential.
 * The Referrer-Policy header the shell sends only applies to a full page load, and the booked state of the pay page links
 * here with a soft navigation, so the page sets the policy itself: React hoists the `<meta>` into the head and removes it
 * again when the customer leaves (the old Next page's `referrer: "no-referrer"` metadata applied to soft navigations too).
 * Without it, every request from this page to our own server would carry the token in its Referer.
 */
export function Component() {
  const { token = "" } = useParams();
  const query = useApiQuery<ManageData>(queryKeys.manage(token), `/api/manage/${encodeURIComponent(token)}`);
  const refused = query.data === undefined ? stateOf(query.error) : undefined;
  return (
    <>
      <meta name="referrer" content="no-referrer" />
      <PageTitle title="Manage your booking" />
      {refused ? (
        <ManageView data={refused} />
      ) : (
        <QueryGate query={query} framed>
          {(data) => <ManageView data={data} />}
        </QueryGate>
      )}
    </>
  );
}
