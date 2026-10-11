import { NextResponse } from "next/server";
import { requireApiAuth } from "@/lib/auth/session";
import { prisma } from "@/lib/db";
import { jsonError } from "@/lib/http";
import { loadOnboardingView } from "@/lib/views/dashboard-onboarding";
import { jsonView } from "@/lib/views/http";

export const dynamic = "force-dynamic";

// The onboarding wizard's data for the SPA (loadOnboardingView is the one source). Any signed-in
// influencer may read it, finished onboarding or not: this is the screen an account sees BEFORE it has finished. The
// step (?step=) and Google's return outcome (?google=) stay in the URL.
export async function GET() {
  const auth = await requireApiAuth();
  if (auth instanceof NextResponse) return auth;
  return jsonView(await loadOnboardingView(auth));
}

// Marks onboarding finished. Requires at least one active service and one availability rule, so a public page
// is never published with nothing to book.
export async function POST() {
  const auth = await requireApiAuth();
  if (auth instanceof NextResponse) return auth;
  const [services, rules] = await Promise.all([
    prisma.service.count({ where: { influencerId: auth.influencerId, active: true } }),
    prisma.availabilityRule.count({ where: { influencerId: auth.influencerId } }),
  ]);
  if (services === 0) return jsonError("Add at least one service first.", 400);
  if (rules === 0) return jsonError("Add your weekly availability first.", 400);
  await prisma.influencer.update({ where: { id: auth.influencerId }, data: { onboardedAt: new Date() } });
  return NextResponse.json({ ok: true, redirect: "/dashboard" });
}
