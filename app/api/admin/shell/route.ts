import { NextResponse } from "next/server";
import { requireAdminMfa } from "@/lib/admin/session";
import { loadAdminShell } from "@/lib/views/admin-shell";
import { jsonView } from "@/lib/views/http";

export const dynamic = "force-dynamic";

/**
 * The admin console frame (sidebar badges, account menu). Same gate as the console pages: an admin who still has to
 * enrol two-factor may read it (the Security page, the only screen open to them, has the same sidebar), a password-only
 * session of an admin who has 2FA may not (403 `mfaAction: "verify"`).
 */
export async function GET() {
  const admin = await requireAdminMfa({ allowEnrollment: true });
  if (admin instanceof NextResponse) return admin;
  return jsonView(await loadAdminShell(admin));
}
