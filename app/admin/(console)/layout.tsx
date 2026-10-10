import type { Metadata } from "next";
import { headers } from "next/headers";
import { AdminShell } from "@/components/admin/AdminShell";
import { paymentViewCounts } from "@/lib/admin/data";
import { requireAdminPage } from "@/lib/admin/session";

export const metadata: Metadata = {
  title: { default: "Admin", template: "%s · Admin" },
  robots: { index: false, follow: false },
};
export const dynamic = "force-dynamic";

export default async function AdminConsoleLayout({ children }: { children: React.ReactNode }) {
  // proxy.ts passes the pathname so an admin who must enrol two-factor is sent to /admin/security from any page. Each
  // page also calls requireAdminPage with its own path; without the header the layout does not guess.
  const path = (await headers()).get("x-pathname");
  const admin = await requireAdminPage(path ?? "/admin", { mfaGate: path !== null });
  const counts = await paymentViewCounts();
  return (
    <AdminShell admin={{ name: admin.name, email: admin.email }} attentionCount={counts.needsRefund + counts.mismatch}>
      {children}
    </AdminShell>
  );
}
