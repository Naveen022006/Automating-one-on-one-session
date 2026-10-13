import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { buildSelfServiceUrl, mayViewMeetingDetails, verifyBookingPollToken } from "@/lib/self-service";

// Statuses in which the meeting link may be surfaced to the poller. The link is a join capability,
// so we never expose it before the booking is actually paid/scheduled.
const LINK_VISIBLE_STATUSES = new Set(["PAID", "SCHEDULED", "COMPLETED"]);

// Polled by the booking page after checkout. Status only: the browser never decides that a payment succeeded.
//
// This endpoint is intentionally public (customers are guests) and rate limited per IP (proxy.ts). The status is
// answered for the id alone. The Meet link and the self-service link are returned only once the booking is paid AND
// with a token for it (`?t=`, see mayViewMeetingDetails: the poll token issued to the browser that created the hold
// in practice), because the booking id is shown to customers as a reference on receipts and may be shared.
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const booking = await prisma.booking.findUnique({
    where: { id },
    select: { status: true, holdExpiresAt: true, meetLink: true, session: { select: { meetLink: true } } },
  });
  if (!booking) return NextResponse.json({ error: "Booking not found" }, { status: 404 });
  const paid = LINK_VISIBLE_STATUSES.has(booking.status);
  const token = new URL(req.url).searchParams.get("t");
  let manageUrl: string | null = null;
  // The self-service link (which can cancel the booking) only goes to the browser that created the hold.
  if (paid && verifyBookingPollToken(id, token)) {
    try {
      manageUrl = buildSelfServiceUrl(id);
    } catch {
      manageUrl = null;
    }
  }
  return NextResponse.json({
    status: booking.status,
    holdExpiresAt: booking.holdExpiresAt,
    meetLink: paid && mayViewMeetingDetails(id, token) ? (booking.meetLink ?? booking.session.meetLink) : null,
    manageUrl,
  });
}
