import { OverviewView } from "@web/components/views/dashboard/OverviewView";
import type { DashboardOverviewView } from "@/lib/views/dashboard-overview";
import { useApiQuery } from "../../lib/api";
import { PageTitle } from "../../lib/head";
import type { Jsonify } from "../../lib/jsonify";
import { queryKeys } from "../../lib/query";
import { QueryGate } from "../../lib/states";

/** /dashboard. The guard and the frame come from the router (RequireInfluencer, DashboardLayout). */
export function Component() {
  const query = useApiQuery<Jsonify<DashboardOverviewView>>(queryKeys.dashboard("overview"), "/api/dashboard/overview");
  return (
    <>
      <PageTitle title="Overview" template="dashboard" />
      <QueryGate query={query} embedded>
        {(data) => <OverviewView data={data} />}
      </QueryGate>
    </>
  );
}
