import { NextResponse } from "next/server";
import { requireAdminMfa } from "@/lib/admin/session";
import { loadAdminBookingsView } from "@/lib/views/admin-bookings";
import { jsonView } from "@/lib/views/http";

export const dynamic = "force-dynamic";

// GET /api/admin/bookings?status=REQUESTED|PENDING_PAYMENT|PAID|SCHEDULED|COMPLETED|CANCELLED|FAILED|EXPIRED&page=N&q=text -> one page of
// bookings across all influencers; `q` (trimmed, at most 120 characters) finds a booking by its id or by part of the customer's e-mail or
// name (searching is not case sensitive). Same gate as the console page (403 `mfaRequired` for a password-only session of an admin who
// has 2FA, and for one who still has to enrol). Any other status means "all".
export async function GET(req: Request) {
  const admin = await requireAdminMfa();
  if (admin instanceof NextResponse) return admin;
  const params = new URL(req.url).searchParams;
  return jsonView(await loadAdminBookingsView({ status: params.get("status"), page: params.get("page"), q: params.get("q") }));
}
