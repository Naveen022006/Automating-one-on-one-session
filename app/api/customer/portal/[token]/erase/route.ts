import { z } from "zod";
import { erasePortalData, resolvePortalToken } from "@/lib/customer-portal";
import { parseJson } from "@/lib/http";
import { jsonView } from "@/lib/views/http";

const schema = z.object({ confirm: z.literal(true) });

// "Erase my data": the same erasure the host's Customers page offers (lib/privacy.ts eraseCustomerData), for every host the address
// booked with. Upcoming sessions are kept until they are cancelled, payment records stay for accounting; the answer says how many of each.
export async function POST(req: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const now = new Date();
  const access = await resolvePortalToken(token, now);
  if (!access) return jsonView({ state: "expired" }, { status: 403 });
  const parsed = await parseJson(req, schema);
  if (!parsed.ok) return parsed.response;
  const { erased, blocked } = await erasePortalData(access.email, now);
  return jsonView({ ok: true, erased, blocked });
}
