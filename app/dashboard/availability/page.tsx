import type { Metadata } from "next";
import { AvailabilityView } from "@/components/views/dashboard/AvailabilityView";
import { requirePageAuth } from "@/lib/auth/guards";
import { jsonify } from "@/lib/jsonify";
import { loadAvailabilityView } from "@/lib/views/dashboard-availability";

export const metadata: Metadata = { title: "Availability" };

export default async function AvailabilityPage() {
  const auth = await requirePageAuth("/dashboard/availability");
  return <AvailabilityView data={jsonify(await loadAvailabilityView(auth.influencerId))} />;
}
