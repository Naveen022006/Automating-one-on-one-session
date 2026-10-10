import { keepPreviousData } from "@tanstack/react-query";
import { useSearchParams } from "react-router";
import { EarningsView } from "@/components/views/dashboard/EarningsView";
import type { DashboardEarningsView } from "@/lib/views/dashboard-earnings";
import { useApiQuery } from "../../lib/api";
import { PageTitle } from "../../lib/head";
import type { Jsonify } from "../../lib/jsonify";
import { queryKeys } from "../../lib/query";
import { QueryGate } from "../../lib/states";

/** /dashboard/earnings?from&to. The date form is a GET form (GetForm); missing dates are filled in by the server (UTC). */
export function Component() {
  const [search] = useSearchParams();
  const from = search.get("from");
  const to = search.get("to");
  const params = new URLSearchParams();
  if (from !== null) params.set("from", from);
  if (to !== null) params.set("to", to);
  const query = useApiQuery<Jsonify<DashboardEarningsView>>(queryKeys.dashboard("earnings", { from, to }), `/api/dashboard/earnings?${params}`, {
    placeholderData: keepPreviousData,
  });
  return (
    <>
      <PageTitle title="Earnings" template="dashboard" />
      <QueryGate query={query} embedded>
        {(data) => <EarningsView data={data} busy={query.isPlaceholderData} />}
      </QueryGate>
    </>
  );
}
