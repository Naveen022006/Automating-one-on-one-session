import { NextResponse } from "next/server";
import { requireAdminMfa } from "@/lib/admin/session";
import { loadAdminPayoutsView } from "@/lib/views/admin-payouts";
import { jsonView } from "@/lib/views/http";

export const dynamic = "force-dynamic";

// GET /api/admin/payouts?status=PENDING|PAID|CANCELLED|all&page=N&id=ID -> one page of payouts, the number on each tab, and for each
// row what THIS administrator may do (the creator of a payout cannot approve it). Same gate as the console page (403 `mfaRequired`
// for a password-only session of an admin who has 2FA, and for one who still has to enrol). Any other status means "PENDING".
// `id` (not empty) answers with that ONE payout, in any status (`single: true`), in the same shape; an id nobody has, or that is not shaped like
// an id, gives no rows. The Money page links to a payout this way.
// The actions (approve, mark paid, cancel) are the POST in ./[id]/route.ts; this GET falls under the generic `admin` rate rule.
export async function GET(req: Request) {
  const admin = await requireAdminMfa();
  if (admin instanceof NextResponse) return admin;
  const params = new URL(req.url).searchParams;
  return jsonView(await loadAdminPayoutsView({ status: params.get("status"), page: params.get("page"), id: params.get("id") }, admin.email));
}
