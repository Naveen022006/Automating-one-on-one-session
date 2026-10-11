import { NextResponse } from "next/server";
import { requireAdminMfa } from "@/lib/admin/session";
import { loadAdminReportsView, parseReportsRange } from "@/lib/views/admin-reports";
import { jsonView } from "@/lib/views/http";

export const dynamic = "force-dynamic";

// GET /api/admin/reports?from=YYYY-MM-DD&to=YYYY-MM-DD -> the finance report: per currency, the gross, refunds, fees and payouts of the
// range, a 12-month table, and the balances right now (held for influencers, in pending payouts, owed to customers, to recover).
// Same gate as the console pages (403 `mfaRequired` for a password-only session of an admin who has 2FA, and for one who still has to
// enrol). Dates are UTC days and `to` is inclusive; a date that is not a real day is ignored (default: the 1st of the month to today),
// a range that ends before it starts or is longer than 366 days is a 400 with a sentence. Read-only, aggregates only. Rate rule: admin-reports.
export async function GET(req: Request) {
  const admin = await requireAdminMfa();
  if (admin instanceof NextResponse) return admin;
  const params = new URL(req.url).searchParams;
  const now = new Date();
  const range = parseReportsRange({ from: params.get("from"), to: params.get("to") }, now);
  if (!range.ok) return jsonView({ error: range.error }, { status: 400 });
  return jsonView(await loadAdminReportsView(range.from, range.to, now));
}
