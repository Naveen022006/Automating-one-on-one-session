import { createHash } from "node:crypto";
import { z } from "zod";
import { parseJson } from "@/lib/http";
import { eraseManagedBooking, resolveManageBooking } from "@/lib/manage-data";
import { enforce, IDENTITY_RULES } from "@/lib/rate-limit";
import { jsonView } from "@/lib/views/http";

export const dynamic = "force-dynamic";

const schema = z.object({ confirm: z.literal(true) });

// "Erase this booking's data" from the manage page (doc/15, 4.12): erases the ONE booking the signed manage link belongs to (lib/privacy.ts
// rules: an upcoming live session is kept until cancelled or over; payment records stay for accounting), never the address's other bookings
// or other hosts', and only on a platform that sends no e-mail (404 otherwise). `erased` and `blocked` count that booking only.
// 403 for an invalid or expired link, 404 for a booking that is gone (so a repeat after the erasure is a clean 404). Limited per IP
// (proxy) and per booking (here).
export async function POST(req: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const access = await resolveManageBooking(token);
  if (access.state === "expired") return jsonView({ state: "expired" }, { status: 403 });
  if (access.state === "gone") return jsonView({ state: "gone" }, { status: 404 });
  const limited = await enforce(IDENTITY_RULES.manageEraseBooking, createHash("sha256").update(access.bookingId).digest("hex"), "Too many requests for this booking. Try again in an hour.");
  if (limited) return limited;
  const parsed = await parseJson(req, schema);
  if (!parsed.ok) return parsed.response;
  const { erased, blocked } = await eraseManagedBooking(access, new Date());
  return jsonView({ ok: true, erased, blocked });
}
