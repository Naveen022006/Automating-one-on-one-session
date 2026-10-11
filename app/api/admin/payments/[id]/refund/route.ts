import { NextResponse } from "next/server";
import { z } from "zod";
import { adminRefundPayment } from "@/lib/admin/refund";
import { requireAdminMfa } from "@/lib/admin/session";
import { isEntityId, jsonError, parseJson } from "@/lib/http";
import { clientIp } from "@/lib/rate-limit";

// The body names no amount on purpose: the refund is always what is left of the payment, worked out on the server.
const schema = z.object({
  reason: z.string().trim().min(5, "Enter a reason of at least 5 characters.").max(300),
  confirm: z.literal(true),
});

// POST /api/admin/payments/:id/refund { reason, confirm: true } -> refunds the rest of a captured payment through Razorpay.
// MFA-gated, rate limited (`admin-money`), audited before Razorpay is called. 200 { ok, status, amountMinor, fullyRefunded } |
// 202 { ok, status: "pending" } (Razorpay did not confirm; the payment settles by webhook) | 400 | 404 | 409 { error } (not allowed
// now, or another refund won) | 502 { error } (Razorpay rejected it; nothing was refunded).
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const admin = await requireAdminMfa();
  if (admin instanceof NextResponse) return admin;
  const { id } = await ctx.params;
  if (!isEntityId(id)) return jsonError("Payment not found.", 404);
  const parsed = await parseJson(req, schema);
  if (!parsed.ok) return parsed.response;

  const result = await adminRefundPayment(id, { adminId: admin.adminId, email: admin.email }, parsed.data.reason, clientIp(req.headers));
  switch (result.kind) {
    case "not-found":
      return jsonError("Payment not found.", 404);
    case "not-allowed":
      return jsonError(result.reason, 409);
    case "failed":
      return jsonError(result.message, 502);
    case "pending":
      return NextResponse.json({ ok: true, status: "pending" }, { status: 202 });
    case "ok":
      return NextResponse.json({ ok: true, status: result.status, amountMinor: result.amountMinor, fullyRefunded: result.fullyRefunded });
  }
}
