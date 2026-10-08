import { NextResponse } from "next/server";
import { z } from "zod";
import { requireApiAuth } from "@/lib/auth/session";
import { prisma } from "@/lib/db";
import {
  BookingNotManageableError,
  ManageBlockedError,
  ManageRejectedError,
  RescheduleNotAllowedError,
  rescheduleBooking,
} from "@/lib/manage";

// Phase 5 reschedule endpoint, now authenticated (Phase 7): only the owning, logged-in influencer. Delegates to
// lib/manage.ts (availability + blocked-day + capacity checks, calendar patch, reminder replacement, notices).
const bodySchema = z.object({
  startTime: z.iso.datetime(),
});

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireApiAuth();
  if (auth instanceof NextResponse) return auth;
  const { id } = await ctx.params;
  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid request", details: z.flattenError(parsed.error) }, { status: 400 });
  }
  const owned = await prisma.booking.findFirst({
    where: { id, session: { service: { influencerId: auth.influencerId } } },
    select: { id: true },
  });
  if (!owned) return NextResponse.json({ error: "Booking not found" }, { status: 404 });

  try {
    await rescheduleBooking(id, new Date(parsed.data.startTime));
    const booking = await prisma.booking.findUnique({ where: { id }, select: { status: true } });
    return NextResponse.json({ status: booking?.status ?? "SCHEDULED" }, { status: 200 });
  } catch (e) {
    if (e instanceof RescheduleNotAllowedError) return NextResponse.json({ error: e.message }, { status: 400 });
    if (e instanceof BookingNotManageableError) return NextResponse.json({ error: e.message }, { status: 409 });
    if (e instanceof ManageBlockedError) return NextResponse.json({ ok: true, warning: e.message }, { status: 202 });
    if (e instanceof ManageRejectedError) return NextResponse.json({ error: e.message }, { status: 409 });
    throw e;
  }
}
