import { prisma } from "@/lib/db";
import { isEntityId } from "@/lib/http";
import { loadActivityPage, parseActivityPage, type ActivityPageView } from "@/lib/views/dashboard-activity";

/**
 * The activity table on the admin Influencer page, for GET /api/admin/influencers/:id/activity. The caller has already passed the
 * admin gate (`requireAdminMfa()`). Same rows and rules as the influencer's own card (lib/views/dashboard-activity.ts); only the
 * wording of the actor differs. Null when there is no such influencer (the route answers 404).
 */

export type AdminInfluencerActivityView = ActivityPageView<"influencer" | "system">;

export async function loadAdminInfluencerActivityView(influencerId: string, params: { page?: string | null }): Promise<AdminInfluencerActivityView | null> {
  if (!isEntityId(influencerId)) return null;
  const influencer = await prisma.influencer.findUnique({ where: { id: influencerId }, select: { id: true } });
  if (!influencer) return null;
  return loadActivityPage(influencer.id, parseActivityPage(params.page), (actor) => (actor === "system" ? "system" : "influencer"));
}
