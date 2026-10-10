import type { Metadata } from "next";
import { ServicesView } from "@/components/views/dashboard/ServicesView";
import { requirePageAuth } from "@/lib/auth/guards";
import { jsonify } from "@/lib/jsonify";
import { loadServicesView } from "@/lib/views/dashboard-services";

export const metadata: Metadata = { title: "Services" };

export default async function ServicesPage() {
  const auth = await requirePageAuth("/dashboard/services");
  return <ServicesView data={jsonify(await loadServicesView(auth.influencerId))} />;
}
