import { NextResponse } from "next/server";
import { z } from "zod";
import { recordActivity } from "@/lib/activity";
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
      const { payBy, emailed, payUrl } = await approveRequest(auth.influencerId, id);
      await recordActivity({ influencerId: auth.influencerId, action: "booking.request_approved", targetType: "booking", targetId: id, detail: { bookingId: id }, req });
      // `payLink` only when the customer could not be e-mailed (no Gmail connection and no platform e-mail): send it to them yourself.
      return NextResponse.json({ ok: true, payBy: payBy.toISOString(), emailed, ...(payUrl ? { payLink: payUrl } : {}) });
    }
    await declineRequest(auth.influencerId, id, parsed.data.reason ?? null);
    await recordActivity({ influencerId: auth.influencerId, action: "booking.request_declined", targetType: "booking", targetId: id, detail: { bookingId: id }, req });
    return NextResponse.json({ ok: true });
  } catch (e) {
    if (e instanceof ApprovalError) return jsonError(e.message, e.status);
    throw e;
  }
}
