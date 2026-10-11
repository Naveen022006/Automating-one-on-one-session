import type { Metadata } from "next";
import { SettingsView } from "@/components/views/admin/SettingsView";
import { requireAdminPage } from "@/lib/admin/session";

export const metadata: Metadata = { title: "Settings" };

export default async function AdminSettingsPage() {
  const admin = await requireAdminPage("/admin/settings");
  return <SettingsView email={admin.email} />;
}
