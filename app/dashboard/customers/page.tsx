import type { Metadata } from "next";
import { CustomersView } from "@/components/views/dashboard/CustomersView";
import { requirePageAuth } from "@/lib/auth/guards";
import { jsonify } from "@/lib/jsonify";
import { loadCustomersView } from "@/lib/views/dashboard-customers";

export const metadata: Metadata = { title: "Customers" };

export default async function CustomersPage({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const auth = await requirePageAuth("/dashboard/customers");
  const { q } = await searchParams;
  return <CustomersView data={jsonify(await loadCustomersView(auth.influencerId, q))} />;
}
