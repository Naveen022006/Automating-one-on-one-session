import { ServicesView } from "@web/components/views/dashboard/ServicesView";
import type { DashboardServicesView } from "@/lib/views/dashboard-services";
import { useApiQuery } from "../../lib/api";
import { PageTitle } from "../../lib/head";
import type { Jsonify } from "../../lib/jsonify";
import { queryKeys } from "../../lib/query";
import { QueryGate } from "../../lib/states";

/** /dashboard/services. The guard and the frame come from the router (RequireInfluencer, DashboardLayout). */
export function Component() {
  const query = useApiQuery<Jsonify<DashboardServicesView>>(queryKeys.dashboard("services"), "/api/dashboard/services");
  return (
    <>
      <PageTitle title="Services" template="dashboard" />
      <QueryGate query={query} embedded>
        {(data) => <ServicesView data={data} />}
      </QueryGate>
    </>
  );
}
