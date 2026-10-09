import type { Metadata } from "next";
import { PageHead } from "@/components/app/AppShell";
import { AdminPasswordForm } from "@/components/admin/AdminForms";
import { Card } from "@/components/ui/primitives";
import { requireAdminPage } from "@/lib/admin/session";

export const metadata: Metadata = { title: "Settings" };

export default async function AdminSettingsPage() {
  const admin = await requireAdminPage("/admin/settings");
  return (
    <div className="stack stack--lg">
      <PageHead title="Settings" description={`Signed in as ${admin.email}`} />
      <Card title="Change password">
        <AdminPasswordForm />
      </Card>
    </div>
  );
}
