import { NextResponse } from "next/server";
import { z } from "zod";
import { adminCancelBooking } from "@/lib/admin/cancel";
import { requireAdminMfa } from "@/lib/admin/session";
import { isEntityId, jsonError, parseJson } from "@/lib/http";
import { clientIp } from "@/lib/rate-limit";

const schema = z.object({
  reason: z.string().trim().min(5, "Enter a reason of at least 5 characters.").max(500),
  confirm: z.literal(true),
});

// POST /api/admin/bookings/:id/cancel { reason, confirm: true } -> cancels a paid/scheduled booking (session not yet started) or a failed
// one on the platform's behalf, through the same cancelBooking the influencer uses (full-refund decision, customer notice, Calendar,
// reminders). MFA-gated, rate limited (`admin-money`), audited before anything changes.
// 200 { ok, refund: { eligible, issued }, warning } | 400 | 404 | 409 { error }.
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const admin = await requireAdminMfa();
  if (admin instanceof NextResponse) return admin;
  const { id } = await ctx.params;
  if (!isEntityId(id)) return jsonError("Booking not found.", 404);
  const parsed = await parseJson(req, schema);
  if (!parsed.ok) return parsed.response;

  const result = await adminCancelBooking(id, { adminId: admin.adminId, email: admin.email }, parsed.data.reason, clientIp(req.headers));
  switch (result.kind) {
    case "not-found":
      return jsonError("Booking not found.", 404);
    case "not-allowed":
      return jsonError(result.reason, 409);
    case "ok":
      return NextResponse.json({ ok: true, refund: { eligible: result.refund.eligible, issued: result.refund.issued }, warning: result.warning });
  }
}
