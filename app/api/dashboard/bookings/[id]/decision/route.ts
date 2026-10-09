import { NextResponse } from "next/server";
import { z } from "zod";
import { requireApiAuth } from "@/lib/auth/session";
import { approveRequest, ApprovalError, declineRequest } from "@/lib/booking-approval";
import { jsonError, parseJson } from "@/lib/http";

const schema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("approve") }),
  z.object({ action: z.literal("decline"), reason: z.string().trim().max(300).optional() }),
]);

// The influencer answers a booking request. Ownership is checked inside lib/booking-approval.ts (404 for anyone
// else's booking), and each transition is conditional so a double click or a race with the expiry job is safe.
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireApiAuth();
  if (auth instanceof NextResponse) return auth;
  const { id } = await ctx.params;
  const parsed = await parseJson(req, schema);
  if (!parsed.ok) return parsed.response;

  try {
    if (parsed.data.action === "approve") {
      const { payBy } = await approveRequest(auth.influencerId, id);
      return NextResponse.json({ ok: true, payBy: payBy.toISOString() });
    }
    await declineRequest(auth.influencerId, id, parsed.data.reason ?? null);
    return NextResponse.json({ ok: true });
  } catch (e) {
    if (e instanceof ApprovalError) return jsonError(e.message, e.status);
    throw e;
  }
}
