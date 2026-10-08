import { NextResponse } from "next/server";
import { z } from "zod";
import {
  BookingActionError,
  BookingNotReschedulableError,
  rescheduleBooking,
} from "@/lib/booking-actions";
import { prisma } from "@/lib/db";
import { GoogleReconnectError, GoogleRequestError, GoogleTransientError } from "@/lib/google";

// SECURITY / TRUST BOUNDARY (reviewed, deliberately deferred to Phase 6): this route is UNAUTHENTICATED, for
// parity with the existing booking routes (hold/checkout). That means anyone who knows a booking id can move
// it to another slot. This is an accepted, documented gap for Phase 5 (reminders & retries), NOT an oversight:
// the Phase 6 dashboard introduces auth, after which this handler must require the authenticated influencer (or
// the booking's own customer). Do not ship these mutation routes publicly until that auth lands.
const bodySchema = z.object({
  startTime: z.iso.datetime(),
});

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid request", details: z.flattenError(parsed.error) }, { status: 400 });
  }

  try {
    await rescheduleBooking(id, new Date(parsed.data.startTime));
    const booking = await prisma.booking.findUnique({ where: { id }, select: { status: true } });
    return NextResponse.json({ status: booking?.status ?? "SCHEDULED" }, { status: 200 });
  } catch (e) {
    // Bad request (not a real slot / in the past) -> 400.
    if (e instanceof BookingActionError) {
      return NextResponse.json({ error: e.message }, { status: 400 });
    }
    // Wrong state / unavailable seat / dead Google grant -> 409 (conflict with current state).
    if (e instanceof BookingNotReschedulableError || e instanceof GoogleReconnectError) {
      return NextResponse.json({ error: e.message }, { status: 409 });
    }
    // Google rejected the event, or a transient Calendar failure: the booking already moved in the DB, so
    // surface a 409 rather than a 500 and let the dashboard flag (booking.lastError) carry the detail.
    if (e instanceof GoogleRequestError || e instanceof GoogleTransientError) {
      return NextResponse.json({ error: e.message }, { status: 409 });
    }
    throw e;
  }
}
