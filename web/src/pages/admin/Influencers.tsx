import { keepPreviousData } from "@tanstack/react-query";
import { useSearchParams } from "react-router";
import { InfluencersView } from "@web/components/views/admin/InfluencersView";
import type { AdminInfluencersView } from "@/lib/views/admin-influencer";
import { useApiQuery } from "../../lib/api";
import { PageTitle } from "../../lib/head";
import type { Jsonify } from "../../lib/jsonify";
import { queryKeys } from "../../lib/query";
import { QueryGate } from "../../lib/states";

/** `/admin/influencers?page&q&status`: GET /api/admin/influencers (the server validates `page` and `status` and trims `q`). */
export function Component() {
  const [params] = useSearchParams();
  const page = params.get("page") ?? "";
  const q = params.get("q")?.slice(0, 80) ?? "";
  const status = params.get("status") ?? "";
  const qs = new URLSearchParams();
  if (page) qs.set("page", page);
  if (q) qs.set("q", q);
  if (status) qs.set("status", status);
  const search = qs.toString();
  // keepPreviousData: a new search or page keeps the list and the search box on screen (marked busy) while it loads, instead of
  // swapping the whole page for a skeleton (same as the other list pages).
  const query = useApiQuery<Jsonify<AdminInfluencersView>>(queryKeys.admin("influencers", { page, q, status }), `/api/admin/influencers${search ? `?${search}` : ""}`, {
    placeholderData: keepPreviousData,
  });
  return (
    <>
      <PageTitle title="Influencers" template="admin" />
      <QueryGate query={query} embedded>
        {(data) => <InfluencersView data={data} q={q || undefined} busy={query.isPlaceholderData} />}
      </QueryGate>
    </>
  );
}
