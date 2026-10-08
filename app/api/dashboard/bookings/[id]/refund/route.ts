import { NextResponse } from "next/server";
import { z } from "zod";
import { requireRecentAuth } from "@/lib/auth/session";
import { prisma } from "@/lib/db";
import { jsonError, parseJson } from "@/lib/http";
import { RefundError, RefundNotAllowedError, refundPayment } from "@/lib/refunds";

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
    select: { id: true },
  });
  if (!payment) return jsonError("There is no captured payment to refund on this booking.", 404);

  try {
    const result = await refundPayment(payment.id, {
      influencerId: auth.influencerId,
      amountMinor: parsed.data.amountMinor,
      reason: parsed.data.reason,
    });
    return NextResponse.json({ ok: true, refund: result });
  } catch (e) {
    if (e instanceof RefundNotAllowedError) return jsonError(e.message, 409);
    if (e instanceof RefundError) return jsonError(`Razorpay did not accept the refund: ${e.message}`, 502);
    throw e;
  }
}
