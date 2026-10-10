import type { Metadata } from "next";
import { ManageView } from "@/components/views/booking/ManageView";
import { jsonify } from "@/lib/jsonify";
import { loadManageView } from "@/lib/views/booking-manage";

export const metadata: Metadata = { title: "Manage your booking", robots: { index: false }, referrer: "no-referrer" };

// Public customer self-service page. The signed token in the path is verified before any booking is loaded or
// shown; an invalid/expired token renders a friendly notice. A valid token lets the customer reschedule or cancel
// their own booking (loadManageView).
export default async function ManagePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return <ManageView data={jsonify(await loadManageView(token))} />;
}
