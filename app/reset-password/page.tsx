import type { Metadata } from "next";
import { ResetPasswordView } from "@/components/views/auth/ResetPasswordView";

export const metadata: Metadata = { title: "Choose a new password", robots: { index: false }, referrer: "no-referrer" };

export default async function ResetPasswordPage({ searchParams }: { searchParams: Promise<{ token?: string }> }) {
  const { token } = await searchParams;
  return <ResetPasswordView token={token} />;
}
