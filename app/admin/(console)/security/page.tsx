import type { Metadata } from "next";
import { SecurityView } from "@/components/views/admin/SecurityView";
import { requireAdminPage } from "@/lib/admin/session";
import { jsonify } from "@/lib/jsonify";
import { loadAdminSecurityView } from "@/lib/views/admin-security";

export const metadata: Metadata = { title: "Security" };

// The only console page open to an administrator who still has to set up two-factor (ADMIN_REQUIRE_2FA). The administrator
// list is only part of the view once this session has passed what it must (loadAdminSecurityView); it is null before that.
export default async function AdminSecurityPage() {
  const admin = await requireAdminPage("/admin/security");
  return <SecurityView data={jsonify(await loadAdminSecurityView(admin))} />;
}
