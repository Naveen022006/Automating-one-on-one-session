import { keepPreviousData } from "@tanstack/react-query";
import { useSearchParams } from "react-router";
import { ReportsRangeProblem, ReportsView } from "@web/components/views/admin/ReportsView";
import type { AdminReportsView } from "@/lib/views/admin-reports";
import { useApiQuery } from "../../lib/api";
import { PageTitle } from "../../lib/head";
import type { Jsonify } from "../../lib/jsonify";
import { queryKeys } from "../../lib/query";
import { QueryGate } from "../../lib/states";

/**
 * /admin/reports?from&to. The date form is a GET form (GetForm); a missing or invalid date is replaced by the server (the 1st of the month
 * to today, IST). A range the server refuses (400: it ends before it starts, or is longer than a year) keeps the form on screen with the
 * server's sentence instead of the generic error.
 */
export function Component() {
  const [search] = useSearchParams();
  const from = search.get("from");
  const to = search.get("to");
  const params = new URLSearchParams();
  if (from !== null) params.set("from", from);
  if (to !== null) params.set("to", to);
  const query = useApiQuery<Jsonify<AdminReportsView>>(queryKeys.admin("reports", { from, to }), `/api/admin/reports?${params}`, {
    placeholderData: keepPreviousData,
  });
  const refused = query.data === undefined && query.error?.status === 400;
  return (
    <>
      <PageTitle title="Reports" template="admin" />
      {refused ? (
        <ReportsRangeProblem from={from ?? ""} to={to ?? ""} message={query.error?.serverMessage ?? "Choose a range of at most 366 days that ends after it starts."} />
      ) : (
        <QueryGate query={query} embedded>
          {(data) => <ReportsView data={data} busy={query.isPlaceholderData} />}
        </QueryGate>
      )}
    </>
  );
}
