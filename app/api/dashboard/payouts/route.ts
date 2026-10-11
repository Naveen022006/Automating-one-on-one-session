import { NextResponse } from "next/server";
import { requireApiAuth } from "@/lib/auth/session";
import { loadPayoutsView } from "@/lib/views/dashboard-payouts";
import { jsonView } from "@/lib/views/http";

export const dynamic = "force-dynamic";

// The Payouts page's data for the SPA (the old Next page renders from the same loadPayoutsView): this influencer's
// masked payout details, what is ready or waiting, and the payout history. Saving details is PUT /api/dashboard/payout-account,
// which keeps its recent-password requirement and its own rate limit; this read has neither (it shows masked values only).
export async function GET() {
  const auth = await requireApiAuth();
  if (auth instanceof NextResponse) return auth;
  return jsonView(await loadPayoutsView(auth.influencerId));
}
