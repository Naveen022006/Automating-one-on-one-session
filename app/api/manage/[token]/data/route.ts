import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import { istDate } from "@/lib/india";
import { exportManagedBooking, resolveManageBooking } from "@/lib/manage-data";
import { enforce, IDENTITY_RULES } from "@/lib/rate-limit";
import { jsonView } from "@/lib/views/http";

export const dynamic = "force-dynamic";

// "Download this booking's data" from the manage page (doc/15, 4.12): the portal export's fields for the ONE booking the signed manage link
// belongs to, never the address's other bookings or other hosts, and only on a platform that sends no e-mail (404 otherwise: the
// "find your bookings" page is the way there). 403 for an invalid or expired link, 404 for a booking that is gone. Limited per IP (proxy)
// and per booking (here), so a leaked link cannot be hammered from many addresses.
export async function GET(_req: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const access = await resolveManageBooking(token);
  if (access.state === "expired") return jsonView({ state: "expired" }, { status: 403 });
  if (access.state === "gone") return jsonView({ state: "gone" }, { status: 404 });
  const limited = await enforce(IDENTITY_RULES.manageDataBooking, createHash("sha256").update(access.bookingId).digest("hex"), "Too many downloads for this booking. Try again in an hour.");
  if (limited) return limited;
  const now = new Date();
  const data = await exportManagedBooking(access, now);
  return new NextResponse(JSON.stringify(data, null, 2), {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename="my-booking-${istDate(now)}.json"`,
      "Cache-Control": "private, no-store",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
