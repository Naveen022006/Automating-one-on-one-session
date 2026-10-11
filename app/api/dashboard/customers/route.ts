import { NextResponse } from "next/server";
import { requireApiAuth } from "@/lib/auth/session";
import { loadCustomersView } from "@/lib/views/dashboard-customers";
import { jsonView } from "@/lib/views/http";

export const dynamic = "force-dynamic";

// GET /api/dashboard/customers?q=text -> the influencer's customers (grouped by email), optionally filtered by name or email.
// Customers' contact details go only to the influencer they booked with; erasing one is POST /api/dashboard/customers/erase.
export async function GET(req: Request) {
  const auth = await requireApiAuth();
  if (auth instanceof NextResponse) return auth;
  return jsonView(await loadCustomersView(auth.influencerId, new URL(req.url).searchParams.get("q")));
}
