import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import {
  createHold,
  DuplicateBookingError,
  HOLD_MINUTES,
  SlotUnavailableError,
} from "@/lib/holds";
import { toE164 } from "@/lib/phone";
import { blockedDaySet, isSlotStart, isValidTimezone } from "@/lib/slots";

const bodySchema = z.object({
  serviceId: z.string().min(1),
  startTime: z.iso.datetime(),
  name: z.string().trim().min(1).max(100),
  email: z.email().max(200),
  whatsapp: z.string().trim().min(5).max(30),
  whatsappOptIn: z.boolean(),
  tz: z.string().optional(),
});

export async function POST(req: Request) {
  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid request", details: z.flattenError(parsed.error) }, { status: 400 });
  }
  const body = parsed.data;

  const whatsappE164 = toE164(body.whatsapp);
  if (!whatsappE164) {
    return NextResponse.json({ error: "Enter a valid WhatsApp number with country code" }, { status: 400 });
  }
  if (!body.whatsappOptIn) {
    return NextResponse.json({ error: "WhatsApp opt-in is required to receive your meeting link" }, { status: 400 });
  }
  if (body.tz && !isValidTimezone(body.tz)) {
    return NextResponse.json({ error: "Invalid timezone" }, { status: 400 });
  }

  const service = await prisma.service.findFirst({
    where: { id: body.serviceId, active: true },
    include: { influencer: { include: { rules: true } } },
  });
  if (!service) return NextResponse.json({ error: "Service not found" }, { status: 404 });

  // A blocked day cannot be booked even if a rule would otherwise produce slots on it.
  const startTime = new Date(body.startTime);
  const blocked = await prisma.blockedDate.findMany({
    where: {
      influencerId: service.influencerId,
      date: {
        gte: new Date(startTime.getTime() - 86_400_000),
        lte: new Date(startTime.getTime() + 86_400_000),
      },
    },
    select: { date: true },
  });
  const blockedDates = blockedDaySet(blocked.map((b) => b.date));

  // Only real slots can be held: the start must come out of the influencer's availability rules and not fall
  // on a blocked day.
  if (
    startTime <= new Date() ||
    !isSlotStart(service.influencer.rules, service.durationMin, startTime, blockedDates)
  ) {
    return NextResponse.json({ error: "That time is not available" }, { status: 409 });
  }

  try {
    const booking = await createHold({
      serviceId: service.id,
      startTime,
      endTime: new Date(startTime.getTime() + service.durationMin * 60_000),
      capacity: service.capacity,
      customerName: body.name,
      customerEmail: body.email.toLowerCase(),
      whatsappE164,
      whatsappOptIn: body.whatsappOptIn,
      customerTz: body.tz,
    });
    return NextResponse.json(
      { bookingId: booking.id, holdExpiresAt: booking.holdExpiresAt, holdMinutes: HOLD_MINUTES },
      { status: 201 },
    );
  } catch (e) {
    if (e instanceof SlotUnavailableError || e instanceof DuplicateBookingError) {
      return NextResponse.json({ error: e.message }, { status: 409 });
    }
    throw e;
  }
}
