import { NextResponse } from "next/server";
import { isEntityId } from "@/lib/http";
import { BookingNotManageableError, resendBookingLink } from "@/lib/manage";
import { mayViewMeetingDetails } from "@/lib/self-service";
import { enforce, IDENTITY_RULES } from "@/lib/rate-limit";

// "Message not received? Resend" on the confirmation page. Public, but only with the page's poll token (`?t=`; the booking
// id alone is a shareable reference), only for paid bookings, and limited to 3 per hour per booking and per IP (proxy.ts).
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!isEntityId(id) || !mayViewMeetingDetails(id, new URL(req.url).searchParams.get("t"))) {
    return NextResponse.json({ error: "Booking not found" }, { status: 404 });
  }
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
