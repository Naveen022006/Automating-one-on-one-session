import { NextResponse } from "next/server";
import { requireAdminMfa } from "@/lib/admin/session";
import { loadAdminHealthView } from "@/lib/views/admin-health";
import { jsonView } from "@/lib/views/http";

export const dynamic = "force-dynamic";

// GET /api/admin/health -> the System health page's data: the worker heartbeat, the monitored conditions, the queue counts, recently
// recovered payments and failed jobs. Measured fresh on every call (the page's "Refresh" button calls it again). Same gate as the
// console page (403 `mfaRequired` for a password-only session of an admin who has 2FA, and for one who still has to enrol). Error
// messages in it have connection strings and secret values taken out. This is NOT the public /api/health liveness route.
export async function GET() {
  const admin = await requireAdminMfa();
  if (admin instanceof NextResponse) return admin;
  return jsonView(await loadAdminHealthView());
}
