import { NextResponse } from "next/server";
import { z } from "zod";
import { requireApiAuth, requireRecentAuth } from "@/lib/auth/session";
import { prisma } from "@/lib/db";
import { BookingNotManageableError, autoRefundOnCancel, cancelBooking } from "@/lib/manage";

// Phase 5 cancel endpoint, now authenticated (Phase 7): only the logged-in influencer who owns the booking may
// call it (customers use their signed /manage link instead). Delegates to the same lib/manage.ts cancel the
// dashboard uses, so reminders, refunds and notifications behave identically.
const bodySchema = z.object({
  reason: z.string().trim().max(500).optional(),
});

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireApiAuth();
  if (auth instanceof NextResponse) return auth;
  const { id } = await ctx.params;
  const parsed = bodySchema.safeParse((await req.json().catch(() => null)) ?? {});
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid request", details: z.flattenError(parsed.error) }, { status: 400 });
  }
  const owned = await prisma.booking.findFirst({
    where: { id, session: { service: { influencerId: auth.influencerId } } },
    select: { id: true, status: true },
  });
  if (!owned) return NextResponse.json({ error: "Booking not found" }, { status: 404 });
  if (owned.status === "CANCELLED") return NextResponse.json({ status: "CANCELLED", outcome: "already-cancelled" });
  // With automatic refunds on, a cancel moves money: require a recent password entry, like the refund route.
  if (autoRefundOnCancel() && (await prisma.payment.count({ where: { bookingId: id, status: "CAPTURED" } })) > 0) {
    const recent = await requireRecentAuth();
    if (recent instanceof NextResponse) return recent;
  }

  try {
    const result = await cancelBooking(id, { actor: "influencer", reason: parsed.data.reason });
    return NextResponse.json({
      status: "CANCELLED",
      outcome: "cancelled",
      refund: result.refund,
      ...(result.warning ? { warning: result.warning } : {}),
    });
  } catch (e) {
    if (e instanceof BookingNotManageableError) return NextResponse.json({ error: e.message }, { status: 409 });
    throw e;
  }
}
