import { NextResponse } from "next/server";
import { z } from "zod";
import { moderateInfluencer, ModerationError } from "@/lib/admin/moderation";
import { requireAdminMfa } from "@/lib/admin/session";
import { isEntityId, parseJson } from "@/lib/http";
import { clientIp } from "@/lib/rate-limit";
import { loadInfluencerStatusView } from "@/lib/views/admin-influencer-status";
import { jsonView } from "@/lib/views/http";

export const dynamic = "force-dynamic";

const NOT_FOUND = { error: "Influencer not found" };

const schema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("suspend"), reason: z.string().trim().min(5).max(500) }),
  z.object({ action: z.literal("reinstate") }),
  z.object({ action: z.literal("approve") }),
]);

/**
 * The moderation panel's data: account status, who suspended or approved and why, and what a suspension leaves untouched.
 * Gate: `requireAdminMfa()`, like the rest of the console.
 */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const admin = await requireAdminMfa();
  if (admin instanceof NextResponse) return admin;
  const { id } = await ctx.params;
  const view = isEntityId(id) ? await loadInfluencerStatusView(id) : null;
  if (!view) return jsonView(NOT_FOUND, { status: 404 });
  return jsonView(view);
}

/**
 * Suspend (with a reason of 5 to 500 characters), reinstate or approve an influencer. The change and its audit entry are
 * written in one transaction. 409 when the state does not allow it (already suspended, not suspended, already approved).
 * `emailed` says whether the influencer was e-mailed (an approval is not announced to a suspended account or while the
 * approval gate is off). Approving is allowed while the gate is off, so a page can be approved in advance.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const admin = await requireAdminMfa();
  if (admin instanceof NextResponse) return admin;
  const { id } = await ctx.params;
  if (!isEntityId(id)) return jsonView(NOT_FOUND, { status: 404 });
  const parsed = await parseJson(req, schema);
  if (!parsed.ok) return parsed.response;

  let emailed = false;
  try {
    emailed = (await moderateInfluencer({ adminId: admin.adminId, email: admin.email }, id, parsed.data, clientIp(req.headers))).emailed;
  } catch (e) {
    if (e instanceof ModerationError) return jsonView({ error: e.message }, { status: e.status });
    throw e;
  }
  const view = await loadInfluencerStatusView(id);
  if (!view) return jsonView(NOT_FOUND, { status: 404 });
  return jsonView({ ok: true, emailed, view });
}
