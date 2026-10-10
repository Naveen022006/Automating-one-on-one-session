import type { Metadata } from "next";
import { AppShell } from "@/components/app/AppShell";
import { requirePageAuth } from "@/lib/auth/guards";
import { loadDashboardShell } from "@/lib/views/dashboard-shell";

export const metadata: Metadata = { title: { default: "Dashboard", template: "%s · Dashboard" }, robots: { index: false } };

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const auth = await requirePageAuth("/dashboard");
  // The same function answers GET /api/dashboard/shell for the SPA, so this frame and the SPA's cannot disagree.
  const { user, attentionCount } = await loadDashboardShell(auth);
  return (
    <AppShell user={{ name: user.name, email: user.email, slug: user.slug, photoUrl: user.photoUrl }} attentionCount={attentionCount}>
      {children}
    </AppShell>
  );
}
