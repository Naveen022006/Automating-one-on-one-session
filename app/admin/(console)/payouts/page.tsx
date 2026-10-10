import type { Metadata } from "next";
import { PayoutsView } from "@/components/views/admin/PayoutsView";
import { requireAdminPage } from "@/lib/admin/session";
import { jsonify } from "@/lib/jsonify";
import { loadAdminPayoutsView } from "@/lib/views/admin-payouts";

export const metadata: Metadata = { title: "Payouts" };

export default async function AdminPayoutsPage({ searchParams }: { searchParams: Promise<{ page?: string; status?: string }> }) {
  const admin = await requireAdminPage("/admin/payouts");
  const sp = await searchParams;
  return <PayoutsView data={jsonify(await loadAdminPayoutsView({ status: sp.status, page: sp.page }, admin.email))} />;
}
