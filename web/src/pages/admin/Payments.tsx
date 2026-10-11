import { keepPreviousData } from "@tanstack/react-query";
import { useSearchParams } from "react-router";
import { PaymentsView } from "@web/components/views/admin/PaymentsView";
import type { AdminPaymentsView } from "@/lib/views/admin-payments";
import { useApiQuery } from "../../lib/api";
import { PageTitle } from "../../lib/head";
import type { Jsonify } from "../../lib/jsonify";
import { queryKeys } from "../../lib/query";
import { QueryGate } from "../../lib/states";

/** /admin/payments?view&page. Tabs and pagination are links, so the URL is the state (keepPreviousData: see dashboard Sessions). */
export function Component() {
  const [search] = useSearchParams();
  const view = search.get("view");
  const page = search.get("page");
  const params = new URLSearchParams();
  if (view !== null) params.set("view", view);
  if (page !== null) params.set("page", page);
  const query = useApiQuery<Jsonify<AdminPaymentsView>>(queryKeys.admin("payments", { view, page }), `/api/admin/payments?${params}`, {
    placeholderData: keepPreviousData,
  });
  return (
    <>
      <PageTitle title="Payments" template="admin" />
      <QueryGate query={query} embedded>
        {(data) => <PaymentsView data={data} busy={query.isPlaceholderData} />}
      </QueryGate>
    </>
  );
}
