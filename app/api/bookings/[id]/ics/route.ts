import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { buildIcs } from "@/lib/ics";

// Same exposure rule as GET /api/bookings/[id]: only paid/scheduled bookings, and the Meet link only then.
const VISIBLE = new Set(["PAID", "SCHEDULED", "COMPLETED"]);

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
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
    description: link ? `Join with Google Meet: ${link}` : "Your Google Meet link will be sent by WhatsApp and email.",
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
