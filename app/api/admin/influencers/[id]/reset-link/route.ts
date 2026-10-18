import { NextResponse } from "next/server";
import { AccountHelpError, adminCreateResetLink } from "@/lib/admin/account-help";
import { requireAdminMfa } from "@/lib/admin/session";
import { isEntityId } from "@/lib/http";
import { clientIp } from "@/lib/rate-limit";
import { jsonView } from "@/lib/views/http";

export const dynamic = "force-dynamic";

/**
 * Creates a one-time password-reset link for an influencer and returns the FULL link in this response, once, for the administrator to
 * hand over (doc/15: the platform may send no e-mail). The link is stored only as a hash, is never logged and is not in the audit entry
 * (which records that a link was created, and when it expires). Same expiry as an e-mailed reset link. `private, no-store`.
 * 404 unknown influencer; 409 no sign-in account. Gate: `requireAdminMfa()`.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const admin = await requireAdminMfa();
  if (admin instanceof NextResponse) return admin;
  const { id } = await ctx.params;
  if (!isEntityId(id)) return jsonView({ error: "Influencer not found" }, { status: 404 });
  try {
    const { url, expiresAt } = await adminCreateResetLink({ adminId: admin.adminId, email: admin.email }, id, clientIp(req.headers));
    return jsonView({ ok: true, url, expiresAt });
  } catch (e) {
    if (e instanceof AccountHelpError) return jsonView({ error: e.message }, { status: e.status });
    throw e;
  }
}
