import { OverviewView } from "@web/components/views/admin/OverviewView";
import type { AdminOverviewView } from "@/lib/views/admin-overview";
import { useApiQuery } from "../../lib/api";
import { PageTitle } from "../../lib/head";
import type { Jsonify } from "../../lib/jsonify";
import { queryKeys } from "../../lib/query";
import { QueryGate } from "../../lib/states";

/** `/admin`: GET /api/admin/overview. */
export function Component() {
  const query = useApiQuery<Jsonify<AdminOverviewView>>(queryKeys.admin("overview"), "/api/admin/overview");
  return (
    <>
      <PageTitle title="Overview" template="admin" />
      <QueryGate query={query} embedded>
        {(data) => <OverviewView data={data} />}
      </QueryGate>
    </>
  );
}
