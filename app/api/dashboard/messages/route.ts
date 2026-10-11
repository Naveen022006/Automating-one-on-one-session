import { NextResponse } from "next/server";
import { requireApiAuth } from "@/lib/auth/session";
import { loadMessagesView } from "@/lib/views/dashboard-messages";
import { jsonView } from "@/lib/views/http";

export const dynamic = "force-dynamic";

// GET /api/dashboard/messages?status=FAILED|PENDING|DELIVERED&page=N -> one page of the messages sent for the influencer's bookings.
// Any other status means "all".
export async function GET(req: Request) {
  const auth = await requireApiAuth();
  if (auth instanceof NextResponse) return auth;
  const params = new URL(req.url).searchParams;
  return jsonView(await loadMessagesView(auth.influencerId, { status: params.get("status"), page: params.get("page") }));
}
