import type { Metadata } from "next";
import { AdminShell } from "@/components/admin/AdminShell";
import { paymentViewCounts } from "@/lib/admin/data";
import { requireAdminPage } from "@/lib/admin/session";

export const metadata: Metadata = {
  title: { default: "Admin", template: "%s · Admin" },
  robots: { index: false, follow: false },
};
export const dynamic = "force-dynamic";

export default async function AdminConsoleLayout({ children }: { children: React.ReactNode }) {
  const admin = await requireAdminPage();
  const counts = await paymentViewCounts();
  return (
    <AdminShell admin={{ name: admin.name, email: admin.email }} attentionCount={counts.needsRefund + counts.mismatch}>
      {children}
    </AdminShell>
  );
}
