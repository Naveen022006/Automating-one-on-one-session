import type { AuthContext } from "@/lib/auth/session";
import { appUrl } from "@/lib/brand";
import { platformEmailEnabled } from "@/lib/email/providers";
import { loadReadiness } from "@/lib/readiness";
import { listBlockedViews, listRuleViews } from "@/lib/views/dashboard-availability";
import { loadPayoutAccountData } from "@/lib/views/dashboard-payouts";
import { listServiceViews } from "@/lib/views/dashboard-services";
import { loadEmbeddedSignupView, loadGoogleClientView, loadGoogleStatusView, loadProfileView, loadWhatsAppView, type EmbeddedSignupView } from "@/lib/views/dashboard-settings";
import type { GoogleClientView, GoogleStatusView, OnboardingData, ProfileData, WhatsAppView } from "@/lib/views/dashboard-types";

/**
 * Everything the onboarding wizard needs, except what lives in the URL: the step (`?step=`) and the Google outcome
 * (`?google=`) are the page's props. Served by GET
 * /api/dashboard/onboarding. Composed from the same loaders as the Services, Availability, Payouts and Settings pages,
 * so the wizard shows exactly what those pages show.
 *
 * The caller has authenticated but NOT checked `onboarded`: this is the page an account sees before it has finished.
 */
export interface DashboardOnboardingView {
  profile: ProfileData;
  services: OnboardingData["services"];
  rules: OnboardingData["rules"];
  blocked: OnboardingData["blocked"];
  google: GoogleStatusView;
  googleClient: GoogleClientView;
  whatsapp: WhatsAppView | null;
  embedded: EmbeddedSignupView | null;
  payout: OnboardingData["payout"];
  /** What still stands between this account and a live booking page, and what is merely recommended. */
  checklist: OnboardingData["checklist"];
  /** The booking page's full address, for the preview step. */
  publicUrl: string;
  email: string;
  emailVerified: boolean;
  emailEnabled: boolean;
}

export async function loadOnboardingView(auth: AuthContext): Promise<DashboardOnboardingView> {
  const [profile, services, rules, blocked, google, googleClient, whatsapp, payout, readiness] = await Promise.all([
    loadProfileView(auth.influencerId),
    listServiceViews(auth.influencerId),
    listRuleViews(auth.influencerId),
    listBlockedViews(auth.influencerId),
    loadGoogleStatusView(auth.influencerId),
    loadGoogleClientView(auth.influencerId),
    loadWhatsAppView(auth.influencerId),
    loadPayoutAccountData(auth.influencerId),
    loadReadiness(auth.influencerId, auth.emailVerified),
  ]);
  return {
    profile,
    services,
    rules,
    blocked,
    google,
    googleClient,
    whatsapp,
    embedded: loadEmbeddedSignupView(),
    payout,
    checklist: readiness.items.map((i) => ({ key: i.key, label: i.label, done: i.state === "done", required: i.required })),
    publicUrl: `${appUrl()}/${profile.slug}`,
    email: auth.email,
    emailVerified: auth.emailVerified,
    emailEnabled: platformEmailEnabled(),
  };
}
