import { keepPreviousData } from "@tanstack/react-query";
import { useSearchParams } from "react-router";
import { MessagesView } from "@/components/views/dashboard/MessagesView";
import type { DashboardMessagesView } from "@/lib/views/dashboard-messages";
import { useApiQuery } from "../../lib/api";
import { PageTitle } from "../../lib/head";
import type { Jsonify } from "../../lib/jsonify";
import { queryKeys } from "../../lib/query";
import { QueryGate } from "../../lib/states";

/** /dashboard/messages?status&page. Tabs and pagination are links, so the URL is the state (keepPreviousData: see Sessions). */
export function Component() {
  const [search] = useSearchParams();
  const status = search.get("status");
  const page = search.get("page");
  const params = new URLSearchParams();
  if (status !== null) params.set("status", status);
  if (page !== null) params.set("page", page);
  const query = useApiQuery<Jsonify<DashboardMessagesView>>(queryKeys.dashboard("messages", { status, page }), `/api/dashboard/messages?${params}`, {
    placeholderData: keepPreviousData,
  });
  return (
    <>
      <PageTitle title="Messages" template="dashboard" />
      <QueryGate query={query} embedded>
        {(data) => <MessagesView data={data} busy={query.isPlaceholderData} />}
      </QueryGate>
    </>
  );
}
