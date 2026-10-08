import type { Metadata } from "next";
import { OnboardingWizard } from "@/components/app/OnboardingWizard";
import type { GoogleStatusView } from "@/components/app/GoogleConnect";
import { requirePageAuth } from "@/lib/auth/guards";
import { appUrl } from "@/lib/brand";
import { prisma } from "@/lib/db";
import { getGoogleStatus } from "@/lib/google-tokens";

export const metadata: Metadata = { title: "Set up your booking page", robots: { index: false } };

// Onboarding wizard shown after the first login: profile, first service, availability, Google Calendar, preview.
export default async function OnboardingPage({ searchParams }: { searchParams: Promise<{ step?: string; google?: string }> }) {
  const auth = await requirePageAuth("/onboarding", { allowOnboarding: true });
  const sp = await searchParams;
  const [influencer, services, rules, blocked, google] = await Promise.all([
    prisma.influencer.findUniqueOrThrow({
      where: { id: auth.influencerId },
      select: { name: true, bio: true, photoUrl: true, timezone: true, slug: true, notifyByEmail: true },
    }),
    prisma.service.findMany({ where: { influencerId: auth.influencerId }, orderBy: { createdAt: "asc" } }),
    prisma.availabilityRule.findMany({ where: { influencerId: auth.influencerId }, orderBy: [{ weekday: "asc" }, { startTime: "asc" }] }),
    prisma.blockedDate.findMany({ where: { influencerId: auth.influencerId }, orderBy: { date: "asc" } }),
    getGoogleStatus(auth.influencerId),
  ]);
  const googleView: GoogleStatusView =
    google.state === "connected"
      ? { state: "connected", email: google.email, connectedAt: google.connectedAt.toISOString() }
      : google.state === "reconnect-needed"
        ? { state: "reconnect-needed", email: google.email, reason: google.reason }
        : { state: "not-connected" };

  return (
    <OnboardingWizard
      step={Number(sp.step) || 0}
      profile={influencer}
      services={services.map((s) => ({
        id: s.id,
        title: s.title,
        description: s.description,
        durationMin: s.durationMin,
        priceMinor: s.priceMinor,
        currency: s.currency,
        type: s.type,
        capacity: s.capacity,
        active: s.active,
        refundPolicy: s.refundPolicy,
      }))}
      rules={rules.map((r) => ({ id: r.id, weekday: r.weekday, startTime: r.startTime, endTime: r.endTime, timezone: r.timezone }))}
      blocked={blocked.map((b) => ({ id: b.id, date: b.date.toISOString().slice(0, 10), reason: b.reason }))}
      google={googleView}
      googleOutcome={sp.google ?? null}
      publicUrl={`${appUrl()}/${influencer.slug}`}
      email={auth.email}
      emailVerified={auth.emailVerified}
    />
  );
}
