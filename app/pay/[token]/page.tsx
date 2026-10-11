import type { Metadata } from "next";
import { PayView } from "@/components/views/booking/PayView";
import { jsonify } from "@/lib/jsonify";
import { loadPayView } from "@/lib/views/booking-pay";

export const metadata: Metadata = { title: "Complete your booking", robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

// The page behind the payment link emailed after an influencer approves a booking request. The signed link only
// identifies the booking; what can be done depends on the booking's state when the page loads (loadPayView).
export default async function PayPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return <PayView data={jsonify(await loadPayView(token))} />;
}
