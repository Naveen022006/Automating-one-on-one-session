import { z } from "zod";
import { requestPortalLink } from "@/lib/customer-portal";
import { parseJson } from "@/lib/http";
import { jsonView } from "@/lib/views/http";

const schema = z.object({ email: z.email().max(200) });

// "Find your bookings": asks for an e-mailed link to the bookings made with an address. PUBLIC, so it answers 202 { ok: true } for
// every well-formed request, whether or not the address has bookings, was asked for before or is over its limit, and it does not wait
// for the lookup and the e-mail (requestPortalLink runs them detached), so the response time says nothing either. Only a malformed
// body is a 400, and that does not depend on the address. The per-IP limit (`customer-access`) is in lib/rate-limit/policies.ts; the
// per-address limit is inside requestPortalLink and is silent.
export async function POST(req: Request) {
  const parsed = await parseJson(req, schema);
  if (!parsed.ok) return parsed.response;
  void requestPortalLink(parsed.data.email);
  return jsonView({ ok: true }, { status: 202 });
}
