import type { Metadata } from "next";
import { HealthView } from "@/components/views/admin/HealthView";
import { requireAdminPage } from "@/lib/admin/session";
import { jsonify } from "@/lib/jsonify";
import { loadAdminHealthView } from "@/lib/views/admin-health";

export const metadata: Metadata = { title: "System health" };
export const dynamic = "force-dynamic";

export default async function AdminHealthPage() {
  await requireAdminPage("/admin/health");
  return <HealthView data={jsonify(await loadAdminHealthView())} />;
}
