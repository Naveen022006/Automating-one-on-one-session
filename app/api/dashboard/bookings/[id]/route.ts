import { NextResponse } from "next/server";
import { z } from "zod";
import { requireApiAuth, requireRecentAuth } from "@/lib/auth/session";
import { getBookingDetail } from "@/lib/dashboard-data";
import { prisma } from "@/lib/db";
import {
  BookingNotManageableError,
  ManageBlockedError,
  ManageRejectedError,
  RescheduleNotAllowedError,
  autoRefundOnCancel,
  cancelBooking,
  rescheduleBooking,
  resendBookingLink,
} from "@/lib/manage";

// Influencer manual actions on one booking, gated by the login session. The booking must belong to the logged-in
// influencer (otherwise 404). Named errors from lib/manage.ts map to HTTP status exactly like
// app/api/checkout/route.ts. A cancel from here is an influencer cancel, so the customer is refunded in full.

const bodySchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("resend") }),
  z.object({ action: z.literal("cancel"), reason: z.string().trim().max(500).optional() }),
  z.object({ action: z.literal("reschedule"), startTime: z.iso.datetime() }),
]);

// Booking detail for the sessions drawer (customer, payment, message history per channel, Meet link).
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireApiAuth();
  if (auth instanceof NextResponse) return auth;
  const { id } = await params;
  const detail = await getBookingDetail(auth.influencerId, id);
  if (!detail) return NextResponse.json({ error: "Booking not found" }, { status: 404 });
  return NextResponse.json(detail);
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireApiAuth();
  if (auth instanceof NextResponse) return auth;
  const influencerId = auth.influencerId;
  const { id } = await params;
  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid request", details: z.flattenError(parsed.error) }, { status: 400 });
  }

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
      // With automatic refunds on, a cancel moves money, so it needs the same recent password entry as a refund.
      if (autoRefundOnCancel() && (await hasCapturedPayment(booking.id))) {
        const recent = await requireRecentAuth();
        if (recent instanceof NextResponse) return recent;
      }
      const result = await cancelBooking(booking.id, { actor: "influencer", reason: parsed.data.reason });
      // `warning`: the booking is cancelled (refund path and customer notice ran) but the Calendar event was not updated.
      return NextResponse.json({ ok: true, refund: result.refund, ...(result.warning ? { warning: result.warning } : {}) });
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

async function hasCapturedPayment(bookingId: string): Promise<boolean> {
  return (await prisma.payment.count({ where: { bookingId, status: "CAPTURED" } })) > 0;
}
