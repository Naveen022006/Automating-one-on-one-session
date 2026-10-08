import { NextResponse } from "next/server";
import { z } from "zod";
import { verifyDashboardToken } from "@/lib/dashboard";
import { prisma } from "@/lib/db";
import {
  BookingNotManageableError,
  ManageBlockedError,
  ManageRejectedError,
  RescheduleNotAllowedError,
  cancelBooking,
  rescheduleBooking,
  resendBookingLink,
} from "@/lib/manage";

// Influencer manual actions on one booking, gated by the signed dashboard token. The booking must belong to
// the influencer the token authorises (otherwise 404). Named errors from lib/manage.ts map to HTTP status
// exactly like app/api/checkout/route.ts.

const bodySchema = z.discriminatedUnion("action", [
  z.object({ token: z.string().min(1), action: z.literal("resend") }),
  z.object({ token: z.string().min(1), action: z.literal("cancel") }),
  z.object({ token: z.string().min(1), action: z.literal("reschedule"), startTime: z.iso.datetime() }),
]);

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid request", details: z.flattenError(parsed.error) }, { status: 400 });
  }
  const influencerId = verifyDashboardToken(parsed.data.token);
  if (!influencerId) return NextResponse.json({ error: "Invalid or expired dashboard link" }, { status: 403 });

  // Ownership: the booking must sit under one of this influencer's services.
  const booking = await prisma.booking.findFirst({
    where: { id, session: { service: { influencerId } } },
    select: { id: true },
  });
  if (!booking) return NextResponse.json({ error: "Booking not found" }, { status: 404 });

  try {
    if (parsed.data.action === "resend") {
      await resendBookingLink(booking.id);
    } else if (parsed.data.action === "cancel") {
      await cancelBooking(booking.id);
    } else {
      await rescheduleBooking(booking.id, new Date(parsed.data.startTime));
    }
    return NextResponse.json({ ok: true });
  } catch (e) {
    if (e instanceof BookingNotManageableError || e instanceof RescheduleNotAllowedError) {
      return NextResponse.json({ error: e.message }, { status: 409 });
    }
    if (e instanceof ManageRejectedError) return NextResponse.json({ error: e.message }, { status: 502 });
    if (e instanceof ManageBlockedError) {
      // The DB change landed but the calendar could not be updated (influencer must reconnect Google).
      return NextResponse.json({ ok: true, warning: e.message }, { status: 202 });
    }
    console.error("[dashboard:booking-action] failed", e);
    return NextResponse.json({ error: "Action failed" }, { status: 500 });
  }
}
