import { NextResponse } from "next/server";
import { parseInfluencerStatusFilter, parsePage } from "@/lib/admin/data";
import { requireAdminMfa } from "@/lib/admin/session";
import { loadAdminInfluencersView } from "@/lib/views/admin-influencer";
import { jsonView } from "@/lib/views/http";

export const dynamic = "force-dynamic";

/**
 * One page of the admin console's influencer list: `?page=` (default 1), `?q=` (search text, at most 80 characters) and
 * `?status=` (all | live | not-live | suspended | awaiting-approval; anything else means all).
 * Gate: `requireAdminMfa()`, the same as the console page (see GET /api/admin/overview).
 */
export async function GET(req: Request) {
  const admin = await requireAdminMfa();
  if (admin instanceof NextResponse) return admin;
  const params = new URL(req.url).searchParams;
  return jsonView(await loadAdminInfluencersView(parsePage(params.get("page") ?? undefined), params.get("q")?.slice(0, 80), parseInfluencerStatusFilter(params.get("status"))));
}
