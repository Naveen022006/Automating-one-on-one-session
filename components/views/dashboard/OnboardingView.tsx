import { OnboardingWizard } from "@/components/app/OnboardingWizard";
import type { Jsonify } from "@/lib/jsonify";
import type { DashboardOnboardingView } from "@/lib/views/dashboard-onboarding";

/**
 * The onboarding wizard. Rendered by the old Next page and by the SPA page from the same JSON. `step` (`?step=`) and
 * `outcome` (`?google=`, the result of Google's return trip) come from the URL; the wizard keeps its own step after
 * the first render and rewrites `?step=` itself.
 */
export function OnboardingView({ data, step, outcome }: { data: Jsonify<DashboardOnboardingView>; step: number; outcome: string | null }) {
  return (
    <OnboardingWizard
      step={step}
      profile={data.profile}
      services={data.services}
      rules={data.rules}
      blocked={data.blocked}
      google={data.google}
      googleOutcome={outcome}
      whatsapp={data.whatsapp}
      embedded={data.embedded}
      payout={data.payout}
      checklist={data.checklist}
      publicUrl={data.publicUrl}
      email={data.email}
      emailVerified={data.emailVerified}
    />
  );
}
