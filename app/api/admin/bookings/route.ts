import { NextResponse } from "next/server";
import { requireAdminMfa } from "@/lib/admin/session";
import { loadAdminBookingsView } from "@/lib/views/admin-bookings";
import { jsonView } from "@/lib/views/http";

export const dynamic = "force-dynamic";

// GET /api/admin/bookings?status=REQUESTED|PENDING_PAYMENT|PAID|SCHEDULED|COMPLETED|CANCELLED|FAILED|EXPIRED&page=N -> one page of
// bookings across all influencers. Same gate as the console page (403 `mfaRequired` for a password-only session of an admin who
// has 2FA, and for one who still has to enrol). Any other status means "all".
export async function GET(req: Request) {
  const admin = await requireAdminMfa();
  if (admin instanceof NextResponse) return admin;
  const params = new URL(req.url).searchParams;
  return jsonView(await loadAdminBookingsView({ status: params.get("status"), page: params.get("page") }));
}
