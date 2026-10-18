import { NextResponse } from "next/server";
import { buildPortalExport } from "@/lib/customer-portal";
import { istDate } from "@/lib/india";
import { resolveManageCustomer } from "@/lib/manage-data";
import { jsonView } from "@/lib/views/http";

export const dynamic = "force-dynamic";

// "Download my data" from the manage page (doc/15, 4.12): the same export as the customer portal (lib/customer-portal.ts buildPortalExport),
// for the address of the booking the signed manage link belongs to. 403 for an invalid or expired link, 404 for a booking that is gone.
export async function GET(_req: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const customer = await resolveManageCustomer(token);
  if (customer.state === "expired") return jsonView({ state: "expired" }, { status: 403 });
  if (customer.state === "gone") return jsonView({ state: "gone" }, { status: 404 });
  const now = new Date();
  const data = await buildPortalExport(customer.email, now);
  return new NextResponse(JSON.stringify(data, null, 2), {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename="my-bookings-${istDate(now)}.json"`,
      "Cache-Control": "private, no-store",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
