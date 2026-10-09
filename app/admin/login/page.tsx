import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { AdminLoginForm } from "@/components/admin/AdminForms";
import { FocusedLayout } from "@/components/site/SiteChrome";
import { getAdminAuth } from "@/lib/admin/session";
import { safeNextPath } from "@/lib/http";

export const metadata: Metadata = { title: "Admin sign in", robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

export default async function AdminLoginPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const { next } = await searchParams;
  if (await getAdminAuth()) redirect(safeNextPath(next, "/admin"));
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
