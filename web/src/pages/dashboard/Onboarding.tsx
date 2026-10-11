import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, type ReactNode } from "react";
import { useSearchParams } from "react-router";
import { Wordmark } from "@/components/site/SiteChrome";
import { OnboardingView } from "@/components/views/dashboard/OnboardingView";
import type { DashboardOnboardingView } from "@/lib/views/dashboard-onboarding";
import { useApiQuery } from "../../lib/api";
import { PageTitle } from "../../lib/head";
import type { Jsonify } from "../../lib/jsonify";
import { queryKeys } from "../../lib/query";
import { QueryGate } from "../../lib/states";

/**
 * The frame around the skeleton and around a failed load, while there is no data. It looks like FocusedLayout but has NO
 * `id="main"` on purpose: FocusOnNavigate (frozen, web/src/lib/a11y.tsx) focuses `#main` after a route change and, when
 * there is none yet, waits for one to appear. A temporary `#main` here would take the focus and then be removed when the
 * data arrives (focus would fall to <body>); without it the focus goes to the wizard's own `main#main` once that renders.
 */
function LoadingFrame({ children }: { children: ReactNode }) {
  return (
    <div className="focused">
      <header className="focused__header">
        <div className="container">
          <Wordmark />
        </div>
      </header>
      <div className="focused__main">
        <div className="focused__card">{children}</div>
      </div>
    </div>
  );
}

/**
 * /onboarding?step&google. The guard is RequireSession (any signed-in influencer); there is no dashboard frame, the wizard
 * brings its own header and main#main. The step and Google's outcome stay in the URL and are NOT part of the query key:
 * the wizard owns its step after the first render (and rewrites ?step= itself), and a step change must not swap the
 * wizard for a skeleton. Adding a service or hours inside the wizard calls router.refresh(), which refetches this query and
 * updates the "Continue" button without unmounting the wizard.
 *
 * In Next every `router.replace('/onboarding?step=n')` fetched fresh server data, so the page also refetches here whenever
 * ?step= changes after the first render (for example a verify-email banner goes away after confirming in another tab).
 * QueryGate keeps showing the wizard while that refetch runs.
 */
export function Component() {
  const [search] = useSearchParams();
  const step = Number(search.get("step")) || 0;
  const query = useApiQuery<Jsonify<DashboardOnboardingView>>(queryKeys.dashboard("onboarding"), "/api/dashboard/onboarding");
  const queryClient = useQueryClient();

  const shownStep = useRef(step);
  useEffect(() => {
    if (shownStep.current === step) return; // the first render (and StrictMode's second effect run) loads through the query itself
    shownStep.current = step;
    void queryClient.invalidateQueries({ queryKey: queryKeys.dashboard("onboarding") });
  }, [step, queryClient]);

  const gate = <QueryGate query={query}>{(data) => <OnboardingView data={data} step={step} outcome={search.get("google")} />}</QueryGate>;
  return (
    <>
      <PageTitle title="Set up your booking page" />
      {query.data ? gate : <LoadingFrame>{gate}</LoadingFrame>}
    </>
  );
}
