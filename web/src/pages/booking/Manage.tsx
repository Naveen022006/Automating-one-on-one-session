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

/** `/manage/:token`: the customer's self-service page (reschedule, cancel). The token in the URL is the only credential. */
export function Component() {
  const { token = "" } = useParams();
  const query = useApiQuery<ManageData>(queryKeys.manage(token), `/api/manage/${encodeURIComponent(token)}`);
  const refused = query.data === undefined ? stateOf(query.error) : undefined;
  return (
    <>
      <PageTitle title="Manage your booking" />
      {refused ? <ManageView data={refused} /> : <QueryGate query={query}>{(data) => <ManageView data={data} />}</QueryGate>}
    </>
  );
}
