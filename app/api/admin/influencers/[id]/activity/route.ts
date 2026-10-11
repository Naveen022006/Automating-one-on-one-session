import { NextResponse } from "next/server";
import { requireAdminMfa } from "@/lib/admin/session";
import { loadAdminInfluencerActivityView } from "@/lib/views/admin-influencer-activity";
import { jsonView } from "@/lib/views/http";

export const dynamic = "force-dynamic";

// GET /api/admin/influencers/:id/activity?page=N -> one page (25 rows, newest first) of one influencer's account activity, for the
// Influencer page. Gate: `requireAdminMfa()`, the same as the console page. 404 for an unknown influencer.
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const admin = await requireAdminMfa();
  if (admin instanceof NextResponse) return admin;
  const { id } = await ctx.params;
  const view = await loadAdminInfluencerActivityView(id, { page: new URL(req.url).searchParams.get("page") });
  if (!view) return jsonView({ error: "Influencer not found" }, { status: 404 });
  return jsonView(view);
}
