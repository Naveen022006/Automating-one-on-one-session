import { NextResponse } from "next/server";
import { parsePage } from "@/lib/admin/data";
import { requireAdminMfa } from "@/lib/admin/session";
import { loadAdminInfluencersView } from "@/lib/views/admin-influencer";
import { jsonView } from "@/lib/views/http";

export const dynamic = "force-dynamic";

/**
 * One page of the admin console's influencer list: `?page=` (default 1) and `?q=` (search text, at most 80 characters).
 * Gate: `requireAdminMfa()`, the same as the console page (see GET /api/admin/overview).
 */
export async function GET(req: Request) {
  const admin = await requireAdminMfa();
  if (admin instanceof NextResponse) return admin;
  const params = new URL(req.url).searchParams;
  return jsonView(await loadAdminInfluencersView(parsePage(params.get("page") ?? undefined), params.get("q")?.slice(0, 80)));
}
