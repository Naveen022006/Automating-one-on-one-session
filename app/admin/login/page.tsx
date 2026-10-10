import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { LoginView } from "@/components/views/admin/LoginView";
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
  return <LoginView next={next} />;
}
