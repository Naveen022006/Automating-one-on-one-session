import { NextResponse } from "next/server";
import { requireAdminMfa } from "@/lib/admin/session";
import { loadAdminAuditView } from "@/lib/views/admin-audit";
import { jsonView } from "@/lib/views/http";

export const dynamic = "force-dynamic";

// GET /api/admin/audit?page=N -> one page (25 entries, newest first) of the audit log, without the free-form `detail` column. There is
// no way to ask for more than a page at a time. Same gate as the console page (403 `mfaRequired` for a password-only session of an
// admin who has 2FA, and for one who still has to enrol).
export async function GET(req: Request) {
  const admin = await requireAdminMfa();
  if (admin instanceof NextResponse) return admin;
  return jsonView(await loadAdminAuditView({ page: new URL(req.url).searchParams.get("page") }));
}
