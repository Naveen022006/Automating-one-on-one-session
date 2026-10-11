import { useParams } from "react-router";
import { ProfileView } from "@/components/views/booking/ProfileView";
import type { PublicProfile } from "@/lib/public-profile";
import { useApiQuery } from "../../lib/api";
import { PageTitle } from "../../lib/head";
import type { Jsonify } from "../../lib/jsonify";
import { queryKeys } from "../../lib/query";
import { QueryGate } from "../../lib/states";

/**
 * `/:slug`. The title depends on the host's name, so nothing is rendered until it is known (the server already wrote
 * the right one into the shell, and a neutral title here would only replace it for a moment); a 404 says "Not found".
 */
export function Component() {
  const { slug = "" } = useParams();
  const query = useApiQuery<Jsonify<PublicProfile>>(queryKeys.publicProfile(slug), `/api/public/profiles/${encodeURIComponent(slug)}`);
  return (
    <>
      {query.data ? (
        <PageTitle title={`Book a session with ${query.data.name}`} />
      ) : query.error?.status === 404 ? (
        <PageTitle title="Not found" />
      ) : query.isError ? (
        <PageTitle title="Something went wrong" />
      ) : null}
      <QueryGate query={query} framed>
        {(profile) => <ProfileView data={profile} />}
      </QueryGate>
    </>
  );
}
