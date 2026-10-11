import { NextResponse } from "next/server";
import { requireAdminMfa } from "@/lib/admin/session";
import { loadAdminSecurityView } from "@/lib/views/admin-security";
import { jsonView } from "@/lib/views/http";

export const dynamic = "force-dynamic";

/**
 * The admin console's Security page. Like the shell, one of the two reads open to an administrator who still has to enrol
 * two-factor (`allowEnrollment`: the Security page is the only console screen they may open); a password-only session of
 * an administrator who HAS two-factor gets 403 `mfaAction: "verify"`. The list of administrators (`admins`) is null until
 * the session has passed what it must (`canViewAdminList`), so an enrolling administrator's cookie cannot be used to read it.
 */
export async function GET() {
  const admin = await requireAdminMfa({ allowEnrollment: true });
  if (admin instanceof NextResponse) return admin;
  return jsonView(await loadAdminSecurityView(admin));
}
