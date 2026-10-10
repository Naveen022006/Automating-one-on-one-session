import { NextResponse } from "next/server";
import { requireApiAuth } from "@/lib/auth/session";
import { loadSessionsView } from "@/lib/views/dashboard-sessions";
import { jsonView } from "@/lib/views/http";

export const dynamic = "force-dynamic";

// GET /api/dashboard/sessions?view=upcoming|requests|past|cancelled|attention&page=N -> one page of the influencer's sessions.
// An unknown view is "upcoming" and an odd page is page 1, exactly as the Sessions page treats its URL.
export async function GET(req: Request) {
  const auth = await requireApiAuth();
  if (auth instanceof NextResponse) return auth;
  const params = new URL(req.url).searchParams;
  return jsonView(await loadSessionsView(auth.influencerId, { view: params.get("view"), page: params.get("page") }));
}
