import { NextResponse } from "next/server";
import { AccountHelpError, adminVerifyEmail } from "@/lib/admin/account-help";
import { requireAdminMfa } from "@/lib/admin/session";
import { isEntityId } from "@/lib/http";
import { clientIp } from "@/lib/rate-limit";
import { jsonView } from "@/lib/views/http";

export const dynamic = "force-dynamic";

/**
 * Marks an influencer's login e-mail as verified (doc/15: the platform may send no e-mail, so nobody could click a link). One
 * transaction with its audit row. 404 unknown influencer; 409 already verified, or no sign-in account. Gate: `requireAdminMfa()`.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const admin = await requireAdminMfa();
  if (admin instanceof NextResponse) return admin;
  const { id } = await ctx.params;
  if (!isEntityId(id)) return jsonView({ error: "Influencer not found" }, { status: 404 });
  try {
    await adminVerifyEmail({ adminId: admin.adminId, email: admin.email }, id, clientIp(req.headers));
  } catch (e) {
    if (e instanceof AccountHelpError) return jsonView({ error: e.message }, { status: e.status });
    throw e;
  }
  return jsonView({ ok: true, emailVerified: true });
}
