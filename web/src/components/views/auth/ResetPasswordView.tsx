import Link from "next/link";
import { ResetForm } from "@/components/auth/AuthForms";
import { FocusedLayout } from "@/components/site/SiteChrome";
import { Alert } from "@/components/ui/primitives";

/** `token` is the raw `?token=` value; without one the link is incomplete. */
export function ResetPasswordView({ token }: { token?: string }) {
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
