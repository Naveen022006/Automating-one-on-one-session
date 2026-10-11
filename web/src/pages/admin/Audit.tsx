import { keepPreviousData } from "@tanstack/react-query";
import { useSearchParams } from "react-router";
import { AuditView } from "@web/components/views/admin/AuditView";
import type { AdminAuditView } from "@/lib/views/admin-audit";
import { useApiQuery } from "../../lib/api";
import { PageTitle } from "../../lib/head";
import type { Jsonify } from "../../lib/jsonify";
import { queryKeys } from "../../lib/query";
import { QueryGate } from "../../lib/states";

/** /admin/audit?page. Pagination is made of links, so the URL is the state (keepPreviousData: see dashboard Sessions). */
export function Component() {
  const [search] = useSearchParams();
  const page = search.get("page");
  const params = new URLSearchParams();
  if (page !== null) params.set("page", page);
  const query = useApiQuery<Jsonify<AdminAuditView>>(queryKeys.admin("audit", { page }), `/api/admin/audit?${params}`, {
    placeholderData: keepPreviousData,
  });
  return (
    <>
      <PageTitle title="Audit log" template="admin" />
      <QueryGate query={query} embedded>
        {(data) => <AuditView data={data} busy={query.isPlaceholderData} />}
      </QueryGate>
    </>
  );
}
