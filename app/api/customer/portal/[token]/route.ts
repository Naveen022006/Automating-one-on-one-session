import { loadCustomerPortalView } from "@/lib/views/customer-portal";
import { jsonView } from "@/lib/views/http";

// The customer portal page's data (`loadCustomerPortalView`): 403 `expired` for a link that is unknown, expired or not a portal
// link (one answer for all of them), 200 with the bookings otherwise. The token in the path is the only credential.
export async function GET(_req: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const view = await loadCustomerPortalView(token);
  return jsonView(view, { status: view.state === "ok" ? 200 : 403 });
}
