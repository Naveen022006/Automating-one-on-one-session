import { loadPayView } from "@/lib/views/booking-pay";
import { jsonView } from "@/lib/views/http";

export const dynamic = "force-dynamic";

/**
 * The state of the booking behind a payment link, for the SPA's /pay/:token page (`loadPayView`)
 * page uses). Always 200: an invalid or expired link, an unknown booking and every booking state are answers the page
 * renders, told apart by `state`. The signed token in the path is the only credential; no customer data is returned.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return jsonView(await loadPayView(token));
}
