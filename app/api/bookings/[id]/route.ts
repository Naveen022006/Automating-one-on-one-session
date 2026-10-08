import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";

// Statuses in which the meeting link may be surfaced to the poller. The link is a join capability,
// so we never expose it before the booking is actually paid/scheduled.
const LINK_VISIBLE_STATUSES = new Set(["PAID", "SCHEDULED", "COMPLETED"]);

// Polled by the booking page after checkout. Status only: the browser never decides that a payment succeeded.
//
// Security note (review Issue 3): this endpoint is intentionally public and unauthenticated (there is
// no session/auth system in this repo yet) and the doc requires "always show the link on the
// confirmation page ... so a message failure never blocks the customer". A Google Meet link is a
// bearer capability, so we gate it rather than returning it unconditionally:
//   - meetLink is only ever populated after the booking is PAID (by the Phase 3 create-meeting job),
//     and we only return it while the booking is in a terminal paid/scheduled/completed state. A
//     booking id guessed before payment therefore never yields a link.
//   - booking ids are cuids (high entropy, not enumerable), and the same link is also delivered to
//     the customer over WhatsApp/SMS, so returning it to the confirmation poll does not materially
//     widen exposure beyond those channels.
// This keeps the doc rule satisfied (the confirmation page, driven by this poll right after the
// customer's own checkout, still shows the link) without exposing it for non-paid bookings. A proper
// session/ownership check is deferred to when auth lands.
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const booking = await prisma.booking.findUnique({
    where: { id },
    select: { status: true, holdExpiresAt: true, meetLink: true },
  });
  if (!booking) return NextResponse.json({ error: "Booking not found" }, { status: 404 });
  const meetLink = LINK_VISIBLE_STATUSES.has(booking.status) ? booking.meetLink : null;
  return NextResponse.json({ ...booking, meetLink });
}
