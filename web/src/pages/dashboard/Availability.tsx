import { AvailabilityView } from "@web/components/views/dashboard/AvailabilityView";
import type { DashboardAvailabilityView } from "@/lib/views/dashboard-availability";
import { useApiQuery } from "../../lib/api";
import { PageTitle } from "../../lib/head";
import type { Jsonify } from "../../lib/jsonify";
import { queryKeys } from "../../lib/query";
import { QueryGate } from "../../lib/states";

/** /dashboard/availability. The guard and the frame come from the router (RequireInfluencer, DashboardLayout). */
export function Component() {
  const query = useApiQuery<Jsonify<DashboardAvailabilityView>>(queryKeys.dashboard("availability"), "/api/dashboard/availability");
  return (
    <>
      <PageTitle title="Availability" template="dashboard" />
      <QueryGate query={query} embedded>
        {(data) => <AvailabilityView data={data} />}
      </QueryGate>
    </>
  );
}
