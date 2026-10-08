import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { activeSeatWhere } from "@/lib/holds";
import { blockedDaySet, dayBoundsUtc, generateSlots, isValidTimezone } from "@/lib/slots";

export const dynamic = "force-dynamic";

// GET /api/slots?serviceId=...&date=YYYY-MM-DD[&tz=Area/City]
// `date` is the calendar day in the customer's timezone `tz` (defaults to the influencer's).
export async function GET(req: Request) {
  const params = new URL(req.url).searchParams;
  const serviceId = params.get("serviceId");
  const date = params.get("date");
  if (!serviceId || !date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return NextResponse.json({ error: "serviceId and date (YYYY-MM-DD) are required" }, { status: 400 });
  }

  const service = await prisma.service.findFirst({
    where: { id: serviceId, active: true },
    include: { influencer: { include: { rules: true } } },
  });
  if (!service) return NextResponse.json({ error: "Service not found" }, { status: 404 });

  const tz = params.get("tz") ?? service.influencer.timezone;
  if (!isValidTimezone(tz)) return NextResponse.json({ error: "Invalid timezone" }, { status: 400 });
  const bounds = dayBoundsUtc(date, tz);
  if (!bounds) return NextResponse.json({ error: "Invalid date" }, { status: 400 });

  // Days the influencer has blocked off produce no slots. Load the ones overlapping this day (plus a day of
  // slack on each side, matching the rule-timezone/UTC day boundary handling in generateSlots).
  const blocked = await prisma.blockedDate.findMany({
    where: {
      influencerId: service.influencerId,
      date: {
        gte: new Date(bounds.from.getTime() - 86_400_000),
        lte: new Date(bounds.to.getTime() + 86_400_000),
      },
    },
    select: { date: true },
  });
  const blockedDates = blockedDaySet(blocked.map((b) => b.date));

  const now = new Date();
  const candidates = generateSlots(
    service.influencer.rules,
    service.durationMin,
    new Date(Math.max(bounds.from.getTime(), now.getTime())),
    bounds.to,
    blockedDates,
  );

  const sessions = await prisma.session.findMany({
    where: { serviceId, startTime: { gte: bounds.from, lt: bounds.to } },
    include: { bookings: { where: activeSeatWhere(now), select: { id: true } } },
  });
  const taken = new Map(sessions.map((s) => [s.startTime.getTime(), s.bookings.length]));

  const slots = candidates
    .map((start) => ({
      start: start.toISOString(),
      end: new Date(start.getTime() + service.durationMin * 60_000).toISOString(),
      seatsLeft: service.capacity - (taken.get(start.getTime()) ?? 0),
    }))
    .filter((s) => s.seatsLeft > 0);

  return NextResponse.json({ slots });
}
