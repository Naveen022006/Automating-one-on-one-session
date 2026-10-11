import { NextResponse } from "next/server";
import { z } from "zod";
import { adminRefundPayment } from "@/lib/admin/refund";
import { requireAdminMfa } from "@/lib/admin/session";
import { isEntityId, jsonError, parseJson } from "@/lib/http";
import { clientIp } from "@/lib/rate-limit";

// The body names no amount to refund on purpose: the refund is always what is left of the payment, worked out on the server.
// `expectedRemainingMinor` is what the administrator was shown, sent only so the server can refuse (409 `amount-changed`) when it differs.
const schema = z.object({
  reason: z.string().trim().min(5, "Enter a reason of at least 5 characters.").max(300),
  confirm: z.literal(true),
  expectedRemainingMinor: z.number().int().positive().max(2_000_000_000),
});

// POST /api/admin/payments/:id/refund { reason, confirm: true, expectedRemainingMinor } -> refunds the rest of a captured payment through
// Razorpay. MFA-gated, rate limited (`admin-money`), audited before Razorpay is called.
// 200 { ok, status, amountMinor, fullyRefunded } | 202 { ok, status: "pending" } (Razorpay did not confirm; the payment settles by webhook) |
// 400 | 404 | 409 { error } (not allowed now, or another refund won) | 409 { error, code: "amount-changed" } | 502 { error } (Razorpay
// rejected it; nothing was refunded) | 500 { error: "outcome-unknown" } (a fault after the claim: Razorpay may have accepted it; check the payment).
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const admin = await requireAdminMfa();
  if (admin instanceof NextResponse) return admin;
  const { id } = await ctx.params;
  if (!isEntityId(id)) return jsonError("Payment not found.", 404);
  const parsed = await parseJson(req, schema);
  if (!parsed.ok) return parsed.response;

  const result = await adminRefundPayment(
    id,
    { adminId: admin.adminId, email: admin.email },
    parsed.data.reason,
    clientIp(req.headers),
    {},
    new Date(),
    parsed.data.expectedRemainingMinor,
  );
  switch (result.kind) {
    case "not-found":
      return jsonError("Payment not found.", 404);
    case "not-allowed":
      return jsonError(result.reason, 409);
    case "amount-changed":
      return jsonError("The amount left to refund changed. Reload the page and check it again.", 409, { code: "amount-changed" });
    case "failed":
      return jsonError(result.message, 502);
    case "outcome-unknown":
      return jsonError("outcome-unknown", 500);
    case "pending":
      return NextResponse.json({ ok: true, status: "pending" }, { status: 202 });
    case "ok":
      return NextResponse.json({ ok: true, status: result.status, amountMinor: result.amountMinor, fullyRefunded: result.fullyRefunded });
  }
}
