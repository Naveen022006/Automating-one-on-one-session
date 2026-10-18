import { NextResponse } from "next/server";
import { recordAudit } from "@/lib/admin/audit";
import { buildExport, exportFilename, ExportTooLargeError, isExportKind, parseExportRange } from "@/lib/admin/exports";
import { requireAdminMfa } from "@/lib/admin/session";
import { toCsv } from "@/lib/dashboard";
import { jsonError } from "@/lib/http";
import { clientIp } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

// GET /api/admin/exports/payments|bookings|payouts|audit?from=YYYY-MM-DD&to=YYYY-MM-DD -> a CSV file of the rows CREATED in that range
// (both days included; default: the 1st of this month to today, IST; at most 366 days). The files hold personal data, so this takes the
// same gate as the console (403 `mfaRequired` for a password-only session of an admin who has 2FA, and for one who still has to enrol),
// is rate limited (`admin-export`) and is audited (`admin.export` with the kind, the range and the row count) BEFORE the file is returned:
// if the audit entry cannot be written, no data leaves. More than 20,000 rows is refused with a 400, never cut short.
export async function GET(req: Request, ctx: { params: Promise<{ kind: string }> }) {
  const admin = await requireAdminMfa();
  if (admin instanceof NextResponse) return admin;
  const { kind } = await ctx.params;
  if (!isExportKind(kind)) return jsonError("Unknown export.", 404);

  const parsed = parseExportRange(new URL(req.url).searchParams);
  if (!parsed.ok) return jsonError(parsed.error, 400);
  const { range } = parsed;

  let rows;
  try {
    rows = await buildExport(kind, range);
  } catch (e) {
    if (e instanceof ExportTooLargeError) return jsonError(e.message, 400);
    throw e;
  }

  await recordAudit(
    { adminId: admin.adminId, email: admin.email },
    { action: "admin.export", targetType: "export", targetId: kind, detail: { kind, from: range.from, to: range.to, rows: rows.length - 1 }, ip: clientIp(req.headers) },
  );
  // The BOM makes Excel on Windows read the file as UTF-8 (non-Latin names would otherwise turn into mojibake); other readers skip it.
  return new NextResponse(`﻿${toCsv(rows)}`, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${exportFilename(kind, range)}"`,
      "Cache-Control": "no-store",
    },
  });
}
