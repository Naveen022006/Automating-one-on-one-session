import { NextResponse } from "next/server";
import { requireApiAuth } from "@/lib/auth/session";
import { loadSettingsView } from "@/lib/views/dashboard-settings";
import { jsonView } from "@/lib/views/http";

export const dynamic = "force-dynamic";

// The Settings page's data for the SPA (the old Next page renders from the same loadSettingsView): profile, the Google
// and WhatsApp connection states, and the public Embedded Signup ids. Never a stored token. The signed-in devices list
// is GET /api/auth/sessions, which the devices panel already reads on its own.
export async function GET() {
  const auth = await requireApiAuth();
  if (auth instanceof NextResponse) return auth;
  return jsonView(await loadSettingsView(auth));
}
