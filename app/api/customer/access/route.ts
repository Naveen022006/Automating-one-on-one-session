import { after } from "next/server";
import { z } from "zod";
import { requestPortalLink } from "@/lib/customer-portal";
import { parseJson } from "@/lib/http";
import { jsonView } from "@/lib/views/http";

const schema = z.object({ email: z.email().max(200) });

// "Find your bookings": asks for an e-mailed link to the bookings made with an address. PUBLIC, so it answers 202 { ok: true } for
// every well-formed request, whether or not the address has bookings, was asked for before or is over its limit, and it does not wait
// for the lookup and the e-mail (requestPortalLink runs them detached), so the response time says nothing either. Only a malformed
// body is a 400, and that does not depend on the address. The per-IP limit (`customer-access`) is in lib/rate-limit/policies.ts; the
// per-address limit and the global cap are inside requestPortalLink and are silent.
export async function POST(req: Request) {
  const parsed = await parseJson(req, schema);
  if (!parsed.ok) return parsed.response;
  const { done } = requestPortalLink(parsed.data.email);
  // `after` keeps a serverless function alive until the detached work has finished (it never rejects). It throws outside a request
  // (a test calling the handler directly); the work is already running then, so there is nothing more to do.
  try {
    after(done);
  } catch {
    /* not in a request scope */
  }
  return jsonView({ ok: true }, { status: 202 });
}
