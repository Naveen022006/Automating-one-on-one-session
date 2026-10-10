import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { AdminLoginForm } from "@/components/admin/AdminForms";
import { FocusedLayout } from "@/components/site/SiteChrome";
import { getAdminAuth, mfaGateStatus } from "@/lib/admin/session";
import { safeNextPath } from "@/lib/http";

export const metadata: Metadata = { title: "Admin sign in", robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

export default async function AdminLoginPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const { next } = await searchParams;
  // A password-only session of an admin who has 2FA ("verify") is not signed in: show the form instead of bouncing
  // between here and the console.
  const current = await getAdminAuth();
  if (current && mfaGateStatus(current) !== "verify") redirect(safeNextPath(next, "/admin"));
  return (
    <FocusedLayout footer={<span>Authorised administrators only. Activity is logged.</span>}>
      <div className="stack stack--lg">
        <div className="stack stack--sm">
          <h1 className="focused__title">Admin console</h1>
          <p className="muted">Sign in with your administrator account.</p>
        </div>
        <AdminLoginForm next={next} />
      </div>
    </FocusedLayout>
  );
}
