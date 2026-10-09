import { NextResponse } from "next/server";
import { z } from "zod";
import { notifyRequestCreated } from "@/lib/booking-approval";
import { windowProblem } from "@/lib/booking-window";
import { prisma } from "@/lib/db";
import { parseQuestions, validateAnswers } from "@/lib/intake";
import {
  createHold,
  DuplicateBookingError,
  HOLD_MINUTES,
  REQUEST_TTL_HOURS,
  SlotUnavailableError,
} from "@/lib/holds";
import { toE164 } from "@/lib/phone";
import { signBookingPollToken } from "@/lib/self-service";
import { publicInfluencerWhere } from "@/lib/public";
import { enforce, IDENTITY_RULES } from "@/lib/rate-limit";
import { blockedDaySet, isSlotStart, isValidTimezone } from "@/lib/slots";

const bodySchema = z.object({
  serviceId: z.string().min(1),
  startTime: z.iso.datetime(),
  name: z.string().trim().min(1).max(100),
  email: z.email().max(200),
  whatsapp: z.string().trim().min(5).max(30),
  whatsappOptIn: z.boolean(),
  tz: z.string().optional(),
  // Answers to the service's intake questions, keyed by question id.
  answers: z.record(z.string().max(30), z.string().max(2000)).optional(),
});

function safePollToken(bookingId: string): string | null {
  try {
    return signBookingPollToken(bookingId);
  } catch {
    return null; // APP_SECRET unset: the confirmation page simply shows no manage link
  }
}

export async function POST(req: Request) {
  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid request", details: z.flattenError(parsed.error) }, { status: 400 });
  }
  const body = parsed.data;

  // Per-IP limits run in proxy.ts; this one stops a single email from squatting many seats.
  const limited = await enforce(IDENTITY_RULES.holdEmail, body.email, "Too many holds for this email. Please finish paying for the slot you already chose, or try again in a few minutes.");
  if (limited) return limited;

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
    where: { id: body.serviceId, active: true, influencer: publicInfluencerWhere },
    include: { influencer: { include: { rules: true } } },
  });
  if (!service) return NextResponse.json({ error: "Service not found" }, { status: 404 });

  const startTime = new Date(body.startTime);

  // The service's booking window (minimum notice, furthest ahead) and intake questions are enforced here, not just
  // in the page, because the page is only a convenience.
  const outside = windowProblem(startTime, { minNoticeHours: service.minNoticeHours, maxAdvanceDays: service.maxAdvanceDays });
  if (outside) return NextResponse.json({ error: outside }, { status: 409 });
  const answered = validateAnswers(parseQuestions(service.intakeQuestions), body.answers);
  if (!answered.ok) {
    return NextResponse.json({ error: "Please answer the highlighted questions.", answerErrors: answered.errors }, { status: 400 });
  }

  // A blocked day cannot be booked even if a rule would otherwise produce slots on it.
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
      refundPolicy: service.refundPolicy,
      intakeAnswers: answered.answers,
      requestApproval: service.requiresApproval,
    });
    if (service.requiresApproval) {
      // A request: nothing to pay yet. The customer gets a receipt email and the influencer an alert.
      await notifyRequestCreated(booking.id);
      return NextResponse.json(
        { bookingId: booking.id, requiresApproval: true, holdExpiresAt: booking.holdExpiresAt, decideWithinHours: REQUEST_TTL_HOURS },
        { status: 201 },
      );
    }
    return NextResponse.json(
      {
        bookingId: booking.id,
        holdExpiresAt: booking.holdExpiresAt,
        holdMinutes: HOLD_MINUTES,
        pollToken: safePollToken(booking.id),
      },
      { status: 201 },
    );
  } catch (e) {
    if (e instanceof SlotUnavailableError || e instanceof DuplicateBookingError) {
      return NextResponse.json({ error: e.message }, { status: 409 });
    }
    throw e;
  }
}
