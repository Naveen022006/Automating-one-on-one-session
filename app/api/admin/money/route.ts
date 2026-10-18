import { NextResponse } from "next/server";
import { requireAdminMfa } from "@/lib/admin/session";
import { loadAdminMoneyView, parseMoneyQuery } from "@/lib/views/admin-money";
import { jsonView } from "@/lib/views/http";

export const dynamic = "force-dynamic";

// GET /api/admin/money?from=YYYY-MM-DD&to=YYYY-MM-DD&type=all|in|out|refunds|payouts&influencerId=ID&page=N -> the money ledger: every customer
// payment (in), refund and payout (out) of the range, newest first, 50 to a page; the totals of the range (the Reports figures); the payouts
// created and not yet sent; and, with an influencerId, that influencer's payout summary. Same gate as the console pages (403 `mfaRequired`
// for a password-only session of an admin who has 2FA, and for one who still has to enrol). Dates are IST days and `to` is inclusive, parsed
// exactly like the Reports page (an odd date is ignored, a range that ends before it starts or is longer than 366 days is a 400 with a
// sentence). An influencerId that is not shaped like an id is a 400; a well-formed id nobody has gives an empty page. Read-only. The
// references are masked (last four characters). Rate rule: admin-money-ledger.
export async function GET(req: Request) {
  const admin = await requireAdminMfa();
  if (admin instanceof NextResponse) return admin;
  const params = new URL(req.url).searchParams;
  const now = new Date();
  const query = parseMoneyQuery(
    { from: params.get("from"), to: params.get("to"), type: params.get("type"), influencerId: params.get("influencerId"), page: params.get("page") },
    now,
  );
  if (!query.ok) return jsonView({ error: query.error }, { status: 400 });
  return jsonView(await loadAdminMoneyView(query.filter, query.page, now));
}
