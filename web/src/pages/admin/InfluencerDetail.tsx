import { useParams } from "react-router";
import { InfluencerDetailView } from "@/components/views/admin/InfluencerDetailView";
import type { AdminInfluencerView } from "@/lib/views/admin-influencer";
import { useApiQuery } from "../../lib/api";
import { PageTitle } from "../../lib/head";
import type { Jsonify } from "../../lib/jsonify";
import { queryKeys } from "../../lib/query";
import { QueryGate } from "../../lib/states";

/**
 * `/admin/influencers/:id`: GET /api/admin/influencers/:id. An unknown id is a 404, which QueryGate shows as the usual "This page
 * does not exist" inside the console frame. Every payout/fee/payout-detail action calls `router.refresh()`, which refetches this.
 */
export function Component() {
  const { id = "" } = useParams();
  const query = useApiQuery<Jsonify<AdminInfluencerView>>(queryKeys.admin("influencer", { id }), `/api/admin/influencers/${encodeURIComponent(id)}`);
  return (
    <>
      <PageTitle title="Influencer" template="admin" />
      <QueryGate query={query} embedded>
        {(data) => <InfluencerDetailView data={data} />}
      </QueryGate>
    </>
  );
}
