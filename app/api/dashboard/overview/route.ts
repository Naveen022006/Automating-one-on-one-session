import { NextResponse } from "next/server";
import { requireApiAuth } from "@/lib/auth/session";
import { loadOverviewView } from "@/lib/views/dashboard-overview";
import { jsonView } from "@/lib/views/http";

export const dynamic = "force-dynamic";

// GET /api/dashboard/overview -> the Overview page's data (checklist, attention items, the week's sessions, this month's earnings).
export async function GET() {
  const auth = await requireApiAuth();
  if (auth instanceof NextResponse) return auth;
  return jsonView(await loadOverviewView(auth));
}
