import type { Metadata } from "next";
import { VerifyEmailView } from "@/components/views/auth/VerifyEmailView";
import { getAuth } from "@/lib/auth/session";

export const metadata: Metadata = { title: "Confirm your email", robots: { index: false }, referrer: "no-referrer" };

export default async function VerifyEmailPage({ searchParams }: { searchParams: Promise<{ token?: string }> }) {
  const { token } = await searchParams;
  const auth = await getAuth();
  return <VerifyEmailView token={token} user={auth ? { email: auth.email, emailVerified: auth.emailVerified } : null} />;
}
