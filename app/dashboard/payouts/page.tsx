import type { Metadata } from "next";
import { PayoutsView } from "@/components/views/dashboard/PayoutsView";
import { requirePageAuth } from "@/lib/auth/guards";
import { jsonify } from "@/lib/jsonify";
import { loadPayoutsView } from "@/lib/views/dashboard-payouts";

export const metadata: Metadata = { title: "Payouts" };

export default async function PayoutsPage() {
  const auth = await requirePageAuth("/dashboard/payouts");
  return <PayoutsView data={jsonify(await loadPayoutsView(auth.influencerId))} />;
}
