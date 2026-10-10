import type { Metadata } from "next";
import { PaymentsView } from "@/components/views/admin/PaymentsView";
import { requireAdminPage } from "@/lib/admin/session";
import { jsonify } from "@/lib/jsonify";
import { loadAdminPaymentsView } from "@/lib/views/admin-payments";

export const metadata: Metadata = { title: "Payments" };

export default async function AdminPaymentsPage({ searchParams }: { searchParams: Promise<{ page?: string; view?: string }> }) {
  await requireAdminPage("/admin/payments");
  const sp = await searchParams;
  return <PaymentsView data={jsonify(await loadAdminPaymentsView({ view: sp.view, page: sp.page }))} />;
}
