import { NextResponse } from "next/server";
import { requireAdminMfa } from "@/lib/admin/session";
import { loadAdminInfluencerView } from "@/lib/views/admin-influencer";
import { jsonView } from "@/lib/views/http";

export const dynamic = "force-dynamic";

/**
 * The admin console's Influencer page. Gate: `requireAdminMfa()`, the same as the console page (see GET
 * /api/admin/overview). The payout details are the masked ones; the full number is only available through the audited
 * POST .../payout-account { action: "reveal" }. The approval state of each payout is the SIGNED-IN administrator's.
 */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const admin = await requireAdminMfa();
  if (admin instanceof NextResponse) return admin;
  const { id } = await ctx.params;
  const view = await loadAdminInfluencerView(id, admin.email);
  if (!view) return jsonView({ error: "Influencer not found" }, { status: 404 });
  return jsonView(view);
}
