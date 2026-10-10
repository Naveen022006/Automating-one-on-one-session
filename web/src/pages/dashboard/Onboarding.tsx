import { useSearchParams } from "react-router";
import { FocusedLayout } from "@/components/site/SiteChrome";
import { OnboardingView } from "@/components/views/dashboard/OnboardingView";
import type { DashboardOnboardingView } from "@/lib/views/dashboard-onboarding";
import { useApiQuery } from "../../lib/api";
import { PageTitle } from "../../lib/head";
import type { Jsonify } from "../../lib/jsonify";
import { queryKeys } from "../../lib/query";
import { QueryGate } from "../../lib/states";

/**
 * /onboarding?step&google. The guard is RequireSession (any signed-in influencer); there is no dashboard frame, the wizard
 * brings its own header and main#main. The step and Google's outcome stay in the URL and are NOT part of the query key:
 * the wizard owns its step after the first render (and rewrites ?step= itself), and a step change must not refetch into a
 * skeleton. Adding a service or hours inside the wizard calls router.refresh(), which refetches this query and updates
 * the "Continue" button without unmounting the wizard.
 */
export function Component() {
  const [search] = useSearchParams();
  const query = useApiQuery<Jsonify<DashboardOnboardingView>>(queryKeys.dashboard("onboarding"), "/api/dashboard/onboarding");
  const gate = (
    <QueryGate query={query}>{(data) => <OnboardingView data={data} step={Number(search.get("step")) || 0} outcome={search.get("google")} />}</QueryGate>
  );
  return (
    <>
      <PageTitle title="Set up your booking page" />
      {/* While there is no data the wizard's own header and main#main do not exist yet; give the skeleton and any error a frame. */}
      {query.data ? gate : <FocusedLayout>{gate}</FocusedLayout>}
    </>
  );
}
