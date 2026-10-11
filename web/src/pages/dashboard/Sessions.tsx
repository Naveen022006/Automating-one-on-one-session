import { keepPreviousData } from "@tanstack/react-query";
import { useSearchParams } from "react-router";
import { SessionsView } from "@web/components/views/dashboard/SessionsView";
import type { DashboardSessionsView } from "@/lib/views/dashboard-sessions";
import { useApiQuery } from "../../lib/api";
import { PageTitle } from "../../lib/head";
import type { Jsonify } from "../../lib/jsonify";
import { queryKeys } from "../../lib/query";
import { QueryGate } from "../../lib/states";

/**
 * /dashboard/sessions?view&page&booking. Tabs and pagination are links, so the URL is the state. `booking` only opens the
 * drawer (the board reads it once, when it first appears), so it is not part of the data request or the query key.
 * keepPreviousData: a tab or page change keeps the current list (and any open drawer) on screen until the next one arrives.
 */
export function Component() {
  const [search] = useSearchParams();
  const view = search.get("view");
  const page = search.get("page");
  const params = new URLSearchParams();
  if (view !== null) params.set("view", view);
  if (page !== null) params.set("page", page);
  const query = useApiQuery<Jsonify<DashboardSessionsView>>(queryKeys.dashboard("sessions", { view, page }), `/api/dashboard/sessions?${params}`, {
    placeholderData: keepPreviousData,
  });
  return (
    <>
      <PageTitle title="Sessions" template="dashboard" />
      <QueryGate query={query} embedded>
        {(data) => <SessionsView data={data} bookingId={search.get("booking")} busy={query.isPlaceholderData} />}
      </QueryGate>
    </>
  );
}
