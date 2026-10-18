import { z } from "zod";
import { erasePortalData } from "@/lib/customer-portal";
import { parseJson } from "@/lib/http";
import { resolveManageCustomer } from "@/lib/manage-data";
import { jsonView } from "@/lib/views/http";

export const dynamic = "force-dynamic";

const schema = z.object({ confirm: z.literal(true) });

// "Erase my data" from the manage page (doc/15, 4.12): the portal's erasure (lib/customer-portal.ts erasePortalData, which is the host's
// "Erase" button of lib/privacy.ts for every host the address booked with) for the address of the booking the signed manage link belongs
// to. Upcoming sessions are kept until cancelled and payment records stay for accounting; the answer says how many of each.
// 403 for an invalid or expired link, 404 for a booking that is gone (so a repeat after the erasure is a clean 404).
export async function POST(req: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const customer = await resolveManageCustomer(token);
  if (customer.state === "expired") return jsonView({ state: "expired" }, { status: 403 });
  if (customer.state === "gone") return jsonView({ state: "gone" }, { status: 404 });
  const parsed = await parseJson(req, schema);
  if (!parsed.ok) return parsed.response;
  const { erased, blocked } = await erasePortalData(customer.email, new Date());
  return jsonView({ ok: true, erased, blocked });
}
