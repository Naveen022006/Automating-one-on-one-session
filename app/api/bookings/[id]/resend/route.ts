import { NextResponse } from "next/server";
import { BookingNotManageableError, resendBookingLink } from "@/lib/manage";
import { enforce, IDENTITY_RULES } from "@/lib/rate-limit";

// "Message not received? Resend" on the confirmation page. Public like GET /api/bookings/[id] (the booking id is
// the capability), only for paid bookings, and limited to 3 per hour per booking and per IP (proxy.ts).
export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const limited = await enforce(IDENTITY_RULES.bookingResend, id, "We already re-sent your link a few times. Check your spam folder or WhatsApp.");
  if (limited) return limited;
  try {
    await resendBookingLink(id);
    return NextResponse.json({ ok: true });
  } catch (e) {
    if (e instanceof BookingNotManageableError) return NextResponse.json({ error: e.message }, { status: 409 });
    throw e;
  }
}
