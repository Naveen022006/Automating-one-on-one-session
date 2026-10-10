import { PayoutsView } from "@/components/views/dashboard/PayoutsView";
import type { DashboardPayoutsView } from "@/lib/views/dashboard-payouts";
import { useApiQuery } from "../../lib/api";
import { PageTitle } from "../../lib/head";
import type { Jsonify } from "../../lib/jsonify";
import { queryKeys } from "../../lib/query";
import { QueryGate } from "../../lib/states";

/** /dashboard/payouts. The guard and the frame come from the router (RequireInfluencer, DashboardLayout). */
export function Component() {
  const query = useApiQuery<Jsonify<DashboardPayoutsView>>(queryKeys.dashboard("payouts"), "/api/dashboard/payouts");
  return (
    <>
      <PageTitle title="Payouts" template="dashboard" />
      <QueryGate query={query} embedded>
        {(data) => <PayoutsView data={data} />}
      </QueryGate>
    </>
  );
}
