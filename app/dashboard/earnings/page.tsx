import type { Metadata } from "next";
import { EarningsView } from "@/components/views/dashboard/EarningsView";
import { requirePageAuth } from "@/lib/auth/guards";
import { jsonify } from "@/lib/jsonify";
import { loadEarningsView } from "@/lib/views/dashboard-earnings";

export const metadata: Metadata = { title: "Earnings" };

export default async function EarningsPage({ searchParams }: { searchParams: Promise<{ from?: string; to?: string }> }) {
  const auth = await requirePageAuth("/dashboard/earnings");
  const sp = await searchParams;
  return <EarningsView data={jsonify(await loadEarningsView(auth.influencerId, { from: sp.from, to: sp.to }))} />;
}
