import { NextResponse } from "next/server";
import { requireApiAuth } from "@/lib/auth/session";
import { loadDashboardShell } from "@/lib/views/dashboard-shell";
import { jsonView } from "@/lib/views/http";

export const dynamic = "force-dynamic";

/**
 * The dashboard frame in one request (guard and layout data together, so one page load costs one database round trip
 * and not two). 401 when signed out. It answers for accounts that have not finished onboarding too (`user.onboarded`
 * is false): sending them to /onboarding is the SPA guard's job, as the server-rendered pages used to.
 */
export async function GET() {
  const auth = await requireApiAuth();
  if (auth instanceof NextResponse) return auth;
  return jsonView(await loadDashboardShell(auth));
}
