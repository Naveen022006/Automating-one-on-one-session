import { NextResponse } from "next/server";
import { z } from "zod";
import { BookingNotReschedulableError, cancelBooking } from "@/lib/booking-actions";
import { GoogleReconnectError } from "@/lib/google";

// NOTE: unauthenticated for parity with the existing booking routes. The Phase 6 dashboard adds auth so only
// the influencer (or the booking's customer) can cancel.
const bodySchema = z.object({
  reason: z.string().trim().max(500).optional(),
});

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const parsed = bodySchema.safeParse((await req.json().catch(() => null)) ?? {});
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid request", details: z.flattenError(parsed.error) }, { status: 400 });
  }

  try {
    const outcome = await cancelBooking(id, parsed.data.reason);
    // Both a fresh cancel and an idempotent re-run leave the booking CANCELLED.
    return NextResponse.json({ status: "CANCELLED", outcome }, { status: 200 });
  } catch (e) {
    if (e instanceof BookingNotReschedulableError) {
      return NextResponse.json({ error: e.message }, { status: 404 });
    }
    // Dead Google grant while deleting the event: the booking is already CANCELLED in the DB -> 409.
    if (e instanceof GoogleReconnectError) {
      return NextResponse.json({ error: e.message }, { status: 409 });
    }
    throw e;
  }
}
