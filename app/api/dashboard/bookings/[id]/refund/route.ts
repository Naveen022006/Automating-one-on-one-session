import { NextResponse } from "next/server";
import { z } from "zod";
import { recordActivity } from "@/lib/activity";
import { requireRecentAuth } from "@/lib/auth/session";
import { prisma } from "@/lib/db";
import { jsonError, parseJson } from "@/lib/http";
import { RefundError, RefundNotAllowedError, RefundPendingError, refundPayment } from "@/lib/refunds";

const schema = z.object({
  /** Partial refund in minor units; omitted = the full captured amount. */
  amountMinor: z.number().int().positive().optional(),
  reason: z.string().trim().max(200).optional(),
});

// Issues a Razorpay refund for the booking's captured payment. Moves money, so it needs a password entry within
// the last 8 hours (requireRecentAuth) and has its own tight rate limit (lib/rate-limit/policies.ts).
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireRecentAuth();
  if (auth instanceof NextResponse) return auth;
  const { id } = await params;
  const parsed = await parseJson(req, schema);
  if (!parsed.ok) return parsed.response;

  const payment = await prisma.payment.findFirst({
    where: { bookingId: id, status: "CAPTURED", booking: { session: { service: { influencerId: auth.influencerId } } } },
    orderBy: { createdAt: "desc" },
    select: { id: true, currency: true },
  });
  if (!payment) return jsonError("There is no captured payment to refund on this booking.", 404);

  try {
    const result = await refundPayment(payment.id, {
      influencerId: auth.influencerId,
      amountMinor: parsed.data.amountMinor,
      reason: parsed.data.reason,
    });
    await recordActivity({
      influencerId: auth.influencerId,
      action: "booking.refunded",
      targetType: "booking",
      targetId: id,
      detail: { bookingId: id, amountMinor: result.amountMinor, currency: payment.currency, status: result.status },
      req,
    });
    return NextResponse.json({ ok: true, refund: result });
  } catch (e) {
    if (e instanceof RefundNotAllowedError) return jsonError(e.message, 409);
    if (e instanceof RefundError) return jsonError(`Razorpay did not accept the refund: ${e.message}`, 502);
    if (e instanceof RefundPendingError) {
      // Razorpay may still process it: the trail says it was asked for, even though the outcome is not known yet.
      await recordActivity({
        influencerId: auth.influencerId,
        action: "booking.refunded",
        targetType: "booking",
        targetId: id,
        detail: { bookingId: id, currency: payment.currency, status: "unconfirmed", ...(parsed.data.amountMinor !== undefined ? { amountMinor: parsed.data.amountMinor } : {}) },
        req,
      });
      return NextResponse.json({ ok: true, pending: true, warning: e.message }, { status: 202 });
    }
    throw e;
  }
}
