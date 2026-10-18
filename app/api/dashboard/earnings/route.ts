import { NextResponse } from "next/server";
import { requireApiAuth } from "@/lib/auth/session";
import { loadEarningsView } from "@/lib/views/dashboard-earnings";
import { jsonView } from "@/lib/views/http";

export const dynamic = "force-dynamic";

// GET /api/dashboard/earnings?from=YYYY-MM-DD&to=YYYY-MM-DD -> earnings summary for the range (IST days); the CSV is
// GET /api/dashboard/earnings/export. Missing or invalid dates default to the 1st of this month and today.
export async function GET(req: Request) {
  const auth = await requireApiAuth();
  if (auth instanceof NextResponse) return auth;
  const params = new URL(req.url).searchParams;
  return jsonView(await loadEarningsView(auth.influencerId, { from: params.get("from"), to: params.get("to") }));
}
