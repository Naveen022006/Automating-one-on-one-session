import { keepPreviousData } from "@tanstack/react-query";
import { useSearchParams } from "react-router";
import { PayoutsView } from "@web/components/views/admin/PayoutsView";
import type { AdminPayoutsView } from "@/lib/views/admin-payouts";
import { useApiQuery } from "../../lib/api";
import { PageTitle } from "../../lib/head";
import type { Jsonify } from "../../lib/jsonify";
import { queryKeys } from "../../lib/query";
import { QueryGate } from "../../lib/states";

/**
 * /admin/payouts?status&page. Tabs and pagination are links, so the URL is the state (keepPreviousData: see dashboard Sessions).
 * What each row lets the viewer do (approve, mark paid) is worked out by the server for this administrator; an action refreshes
 * every active query (`router.refresh()` in PayoutActions), which fetches the rows again with the new approval state.
 */
export function Component() {
  const [search] = useSearchParams();
  const status = search.get("status");
  const page = search.get("page");
  const params = new URLSearchParams();
  if (status !== null) params.set("status", status);
  if (page !== null) params.set("page", page);
  const query = useApiQuery<Jsonify<AdminPayoutsView>>(queryKeys.admin("payouts", { status, page }), `/api/admin/payouts?${params}`, {
    placeholderData: keepPreviousData,
  });
  return (
    <>
      <PageTitle title="Payouts" template="admin" />
      <QueryGate query={query} embedded>
        {(data) => <PayoutsView data={data} busy={query.isPlaceholderData} />}
      </QueryGate>
    </>
  );
}
