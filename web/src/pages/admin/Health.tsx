import { HealthView } from "@web/components/views/admin/HealthView";
import type { AdminHealthView } from "@/lib/views/admin-health";
import { useApiQuery } from "../../lib/api";
import { PageTitle } from "../../lib/head";
import type { Jsonify } from "../../lib/jsonify";
import { queryKeys } from "../../lib/query";
import { QueryGate } from "../../lib/states";

/**
 * /admin/health. The page's "Refresh" button is a link to this same URL; the shared link component answers a click on the current
 * location by refetching every active query (web/src/lib/link.tsx), which measures everything again. The page keeps showing the
 * previous answer meanwhile, so `busy` (a fetch is running) is what tells the view to say "Refreshing".
 */
export function Component() {
  const query = useApiQuery<Jsonify<AdminHealthView>>(queryKeys.admin("health"), "/api/admin/health");
  return (
    <>
      <PageTitle title="System health" template="admin" />
      <QueryGate query={query} embedded>
        {(data) => <HealthView data={data} busy={query.isFetching} />}
      </QueryGate>
    </>
  );
}
