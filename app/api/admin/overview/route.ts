import { NextResponse } from "next/server";
import { requireAdminMfa } from "@/lib/admin/session";
import { loadAdminOverviewView } from "@/lib/views/admin-overview";
import { jsonView } from "@/lib/views/http";

export const dynamic = "force-dynamic";

/**
 * The admin console Overview page's data. Same gate as the console page it replaces: `requireAdminMfa()` also denies an
 * administrator who still has to enrol two-factor and a password-only session of one who has it (403 `mfaRequired`),
 * which `requireAdminApi()` alone would let through.
 */
export async function GET() {
  const admin = await requireAdminMfa();
  if (admin instanceof NextResponse) return admin;
  return jsonView(await loadAdminOverviewView());
}
