import type { Metadata } from "next";
import { headers } from "next/headers";
import { AdminShell } from "@/components/admin/AdminShell";
import { requireAdminPage } from "@/lib/admin/session";
import { loadAdminShell } from "@/lib/views/admin-shell";

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
  // The same function answers GET /api/admin/shell for the SPA, so this frame and the SPA's cannot disagree.
  const shell = await loadAdminShell(admin);
  return (
    <AdminShell admin={shell.admin} attentionCount={shell.attentionCount} healthCount={shell.healthCount}>
      {children}
    </AdminShell>
  );
}
