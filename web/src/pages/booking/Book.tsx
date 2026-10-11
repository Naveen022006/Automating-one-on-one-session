import { useParams, useSearchParams } from "react-router";
import { BookView } from "@/components/views/booking/BookView";
import type { PublicProfile } from "@/lib/public-profile";
import { useApiQuery } from "../../lib/api";
import { PageTitle } from "../../lib/head";
import type { Jsonify } from "../../lib/jsonify";
import { queryKeys } from "../../lib/query";
import { QueryGate } from "../../lib/states";

/**
 * `/:slug/book?service=`. Shares the profile query with `/:slug` (same key), so moving from the profile to its booking
 * page shows the cached profile at once. The title follows the same rule as Profile.tsx.
 */
export function Component() {
  const { slug = "" } = useParams();
  const [search] = useSearchParams();
  const query = useApiQuery<Jsonify<PublicProfile>>(queryKeys.publicProfile(slug), `/api/public/profiles/${encodeURIComponent(slug)}`);
  return (
    <>
      {query.data ? (
        <PageTitle title={`Book ${query.data.name}`} />
      ) : query.error?.status === 404 ? (
        <PageTitle title="Not found" />
      ) : query.isError ? (
        <PageTitle title="Something went wrong" />
      ) : null}
      <QueryGate query={query} framed>
        {(profile) => <BookView data={profile} initialServiceId={search.get("service")} />}
      </QueryGate>
    </>
  );
}
