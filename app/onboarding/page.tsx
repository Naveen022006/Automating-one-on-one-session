import type { Metadata } from "next";
import { OnboardingView } from "@/components/views/dashboard/OnboardingView";
import { requirePageAuth } from "@/lib/auth/guards";
import { jsonify } from "@/lib/jsonify";
import { loadOnboardingView } from "@/lib/views/dashboard-onboarding";

export const metadata: Metadata = { title: "Set up your booking page", robots: { index: false } };

// Onboarding wizard shown after the first login: profile, first service, availability, Google Calendar, preview.
export default async function OnboardingPage({ searchParams }: { searchParams: Promise<{ step?: string; google?: string }> }) {
  const auth = await requirePageAuth("/onboarding", { allowOnboarding: true });
  const sp = await searchParams;
  return <OnboardingView data={jsonify(await loadOnboardingView(auth))} step={Number(sp.step) || 0} outcome={sp.google ?? null} />;
}
