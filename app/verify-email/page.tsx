import type { Metadata } from "next";
import Link from "next/link";
import { ResendVerification, VerifyEmail } from "@/components/auth/AuthForms";
import { FocusedLayout } from "@/components/site/SiteChrome";
import { Alert } from "@/components/ui/primitives";
import { getAuth } from "@/lib/auth/session";

export const metadata: Metadata = { title: "Confirm your email", robots: { index: false }, referrer: "no-referrer" };

export default async function VerifyEmailPage({ searchParams }: { searchParams: Promise<{ token?: string }> }) {
  const { token } = await searchParams;
  const auth = await getAuth();
  return (
    <FocusedLayout>
      <div className="stack stack--lg">
        <h1 className="focused__title">Confirm your email</h1>
        {token ? (
          <VerifyEmail token={token} loggedIn={Boolean(auth)} />
        ) : auth && !auth.emailVerified ? (
          <Alert tone="info" title={`We sent a link to ${auth.email}`}>
            Open it to confirm your address. Can't find it? Check spam, or <ResendVerification />
          </Alert>
        ) : (
          <Alert tone="info">
            Open the link from your email. <Link href="/login">Log in</Link>
          </Alert>
        )}
      </div>
    </FocusedLayout>
  );
}
