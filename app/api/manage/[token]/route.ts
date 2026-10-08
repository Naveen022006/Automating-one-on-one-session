import { NextResponse } from "next/server";
import { z } from "zod";
import {
  BookingNotManageableError,
  ManageBlockedError,
  ManageRejectedError,
  cancelBooking,
  rescheduleBooking,
} from "@/lib/manage";
import { verifySelfServiceToken } from "@/lib/self-service";

// Customer self-service actions on their OWN booking. Gated by the self-service token (NOT the dashboard
// token): the token in the URL path carries the booking id, so there is no ownership lookup to spoof. It
// calls the same cancelBooking / rescheduleBooking domain functions the influencer dashboard uses.

const bodySchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("cancel") }),
  z.object({ action: z.literal("reschedule"), startTime: z.iso.datetime() }),
]);

export async function POST(req: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const bookingId = verifySelfServiceToken(token);
  if (!bookingId) {
    return NextResponse.json({ error: "This management link is invalid or has expired" }, { status: 403 });
  }

  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid request", details: z.flattenError(parsed.error) }, { status: 400 });
  }

  try {
    if (parsed.data.action === "cancel") {
      await cancelBooking(bookingId);
    } else {
      await rescheduleBooking(bookingId, new Date(parsed.data.startTime));
    }
    return NextResponse.json({ ok: true });
  } catch (e) {
    if (e instanceof BookingNotManageableError) return NextResponse.json({ error: e.message }, { status: 409 });
    if (e instanceof ManageRejectedError) return NextResponse.json({ error: e.message }, { status: 502 });
    if (e instanceof ManageBlockedError) return NextResponse.json({ ok: true, warning: e.message }, { status: 202 });
    console.error("[self-service] action failed", e);
    return NextResponse.json({ error: "Action failed" }, { status: 500 });
  }
}
