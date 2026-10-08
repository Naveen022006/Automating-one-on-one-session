import { NextResponse } from "next/server";
import { requireApiAuth } from "@/lib/auth/session";
import { prisma } from "@/lib/db";
import { jsonError } from "@/lib/http";

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
