import type { Metadata } from "next";
import { AuditView } from "@/components/views/admin/AuditView";
import { requireAdminPage } from "@/lib/admin/session";
import { jsonify } from "@/lib/jsonify";
import { loadAdminAuditView } from "@/lib/views/admin-audit";

export const metadata: Metadata = { title: "Audit log" };

export default async function AdminAuditPage({ searchParams }: { searchParams: Promise<{ page?: string }> }) {
  await requireAdminPage("/admin/audit");
  const sp = await searchParams;
  return <AuditView data={jsonify(await loadAdminAuditView({ page: sp.page }))} />;
}
