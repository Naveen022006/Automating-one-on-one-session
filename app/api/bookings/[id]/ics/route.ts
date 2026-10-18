import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { isEntityId } from "@/lib/http";
import { formatSessionTime } from "@/lib/format";
import { buildIcs } from "@/lib/ics";
import { mayViewMeetingDetails } from "@/lib/self-service";

// Same exposure rule as GET /api/bookings/[id]: only paid/scheduled bookings, and only with a token for the booking
// (`?t=`: the calendar-link token from an e-mail, the page's poll token or the manage-link token; see
// mayViewMeetingDetails). The file carries the Meet link, and the booking id alone is a reference that may be shared.
const VISIBLE = new Set(["PAID", "SCHEDULED", "COMPLETED"]);

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!isEntityId(id) || !mayViewMeetingDetails(id, new URL(req.url).searchParams.get("t"))) {
    return NextResponse.json({ error: "Booking not found" }, { status: 404 });
  }
  const booking = await prisma.booking.findUnique({
    where: { id },
    include: { session: { include: { service: { include: { influencer: { select: { name: true } } } } } } },
  });
  if (!booking || !VISIBLE.has(booking.status)) return NextResponse.json({ error: "Booking not found" }, { status: 404 });
  const { session } = booking;
  const link = booking.meetLink ?? session.meetLink;
  const ics = buildIcs({
    uid: `${booking.id}@session-automation`,
    title: `${session.service.title} with ${session.service.influencer.name}`,
    // DTSTART stays UTC (every calendar app shows it in the owner's own zone); the description says the time in IST.
    description: `${formatSessionTime(session.startTime)}. ${link ? `Join with Google Meet: ${link}` : "Your Google Meet link will be sent by WhatsApp and email."}`,
    start: session.startTime,
    end: session.endTime,
    url: link,
    organizerName: session.service.influencer.name,
  });
  return new NextResponse(ics, {
    headers: {
      "Content-Type": "text/calendar; charset=utf-8",
      "Content-Disposition": `attachment; filename="session-${booking.id}.ics"`,
      "Cache-Control": "private, no-store",
    },
  });
}
