import { NextResponse } from "next/server";
import { requireApiAuth } from "@/lib/auth/session";
import { loadDashboardActivityView } from "@/lib/views/dashboard-activity";
import { jsonView } from "@/lib/views/http";

export const dynamic = "force-dynamic";

// GET /api/dashboard/activity?page=N[&action=<action>] -> one page (25 rows, newest first) of the signed-in influencer's account activity: sign-ins,
// password and payout-detail changes, refunds... Only their own rows (the id comes from the login session, never from the URL).
export async function GET(req: Request) {
  const auth = await requireApiAuth();
  if (auth instanceof NextResponse) return auth;
  const params = new URL(req.url).searchParams;
  return jsonView(await loadDashboardActivityView(auth.influencerId, { page: params.get("page"), action: params.get("action") }));
}
