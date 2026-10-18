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
      const { payBy, emailed, payUrl, messageRoute, messageQueued } = await approveRequest(auth.influencerId, id);
      await recordActivity({ influencerId: auth.influencerId, action: "booking.request_approved", targetType: "booking", targetId: id, detail: { bookingId: id }, req });
      // `payLink` only when nobody else will deliver it: the customer could not be e-mailed (no Gmail connection and no platform e-mail) AND
      // no message is on its way. `messageRoute` is how a message can reach the customer (whatsapp-linked, whatsapp-official, sms or none) and
      // `messageQueued` whether the payment link message is really on the queue (the worker builds and sends it).
      return NextResponse.json({ ok: true, payBy: payBy.toISOString(), emailed, messageRoute, messageQueued, ...(payUrl ? { payLink: payUrl } : {}) });
    }
    const { messageRoute, messageQueued } = await declineRequest(auth.influencerId, id, parsed.data.reason ?? null);
    await recordActivity({ influencerId: auth.influencerId, action: "booking.request_declined", targetType: "booking", targetId: id, detail: { bookingId: id }, req });
    return NextResponse.json({ ok: true, messageRoute, messageQueued });
  } catch (e) {
    if (e instanceof ApprovalError) return jsonError(e.message, e.status);
    throw e;
  }
}
