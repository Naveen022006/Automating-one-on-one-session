import { keepPreviousData } from "@tanstack/react-query";
import { useSearchParams } from "react-router";
import { CustomersView } from "@web/components/views/dashboard/CustomersView";
import type { DashboardCustomersView } from "@/lib/views/dashboard-customers";
import { useApiQuery } from "../../lib/api";
import { PageTitle } from "../../lib/head";
import type { Jsonify } from "../../lib/jsonify";
import { queryKeys } from "../../lib/query";
import { QueryGate } from "../../lib/states";

/**
 * /dashboard/customers?q. The search form is a GET form (GetForm), so the URL is the state. keepPreviousData keeps the
 * search box mounted, with the cursor in it, while the next result loads.
 */
export function Component() {
  const [search] = useSearchParams();
  const q = search.get("q");
  const params = new URLSearchParams();
  if (q !== null) params.set("q", q);
  const query = useApiQuery<Jsonify<DashboardCustomersView>>(queryKeys.dashboard("customers", { q }), `/api/dashboard/customers?${params}`, {
    placeholderData: keepPreviousData,
  });
  return (
    <>
      <PageTitle title="Customers" template="dashboard" />
      <QueryGate query={query} embedded>
        {(data) => <CustomersView data={data} busy={query.isPlaceholderData} />}
      </QueryGate>
    </>
  );
}
