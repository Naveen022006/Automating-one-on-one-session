import { NextResponse } from "next/server";
import { requireAdminMfa } from "@/lib/admin/session";
import { loadAdminPaymentsView } from "@/lib/views/admin-payments";
import { jsonView } from "@/lib/views/http";

export const dynamic = "force-dynamic";

// GET /api/admin/payments?view=all|unreconciled|captured|needs-refund|mismatch|unpaid&page=N -> one page of payments and the
// number on each tab. Same gate as the console page: a password-only session of an admin who has 2FA, and an admin who still has
// to enrol, are refused (403 `mfaRequired`). Any other view means "all".
export async function GET(req: Request) {
  const admin = await requireAdminMfa();
  if (admin instanceof NextResponse) return admin;
  const params = new URL(req.url).searchParams;
  return jsonView(await loadAdminPaymentsView({ view: params.get("view"), page: params.get("page") }));
}
