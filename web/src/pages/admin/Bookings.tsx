import { keepPreviousData } from "@tanstack/react-query";
import { useSearchParams } from "react-router";
import { BookingsView } from "@web/components/views/admin/BookingsView";
import type { AdminBookingsView } from "@/lib/views/admin-bookings";
import { useApiQuery } from "../../lib/api";
import { PageTitle } from "../../lib/head";
import type { Jsonify } from "../../lib/jsonify";
import { queryKeys } from "../../lib/query";
import { QueryGate } from "../../lib/states";

/** /admin/bookings?status&page. Tabs and pagination are links, so the URL is the state (keepPreviousData: see dashboard Sessions). */
export function Component() {
  const [search] = useSearchParams();
  const status = search.get("status");
  const page = search.get("page");
  const params = new URLSearchParams();
  if (status !== null) params.set("status", status);
  if (page !== null) params.set("page", page);
  const query = useApiQuery<Jsonify<AdminBookingsView>>(queryKeys.admin("bookings", { status, page }), `/api/admin/bookings?${params}`, {
    placeholderData: keepPreviousData,
  });
  return (
    <>
      <PageTitle title="Bookings" template="admin" />
      <QueryGate query={query} embedded>
        {(data) => <BookingsView data={data} busy={query.isPlaceholderData} />}
      </QueryGate>
    </>
  );
}
