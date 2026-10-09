import type { Metadata } from "next";
import Link from "next/link";
import { ResetForm } from "@/components/auth/AuthForms";
import { FocusedLayout } from "@/components/site/SiteChrome";
import { Alert } from "@/components/ui/primitives";

export const metadata: Metadata = { title: "Choose a new password", robots: { index: false }, referrer: "no-referrer" };

export default async function ResetPasswordPage({ searchParams }: { searchParams: Promise<{ token?: string }> }) {
  const { token } = await searchParams;
  return (
    <FocusedLayout>
      <div className="stack stack--lg">
        <h1 className="focused__title">Choose a new password</h1>
        {token ? (
          <ResetForm token={token} />
        ) : (
          <Alert tone="danger" title="This link is incomplete" action={<Link href="/forgot-password">Request a new link</Link>}>
            Open the link from your email again, or request a new one.
          </Alert>
        )}
      </div>
    </FocusedLayout>
  );
}
