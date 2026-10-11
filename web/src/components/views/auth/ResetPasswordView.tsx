import { AppLink } from "@web/lib/link";
import { ResetForm } from "@web/components/auth/AuthForms";
import { FocusedLayout } from "@web/components/site/SiteChrome";
import { Alert } from "@web/components/ui/primitives";

/** `token` is the raw `?token=` value; without one the link is incomplete. */
export function ResetPasswordView({ token }: { token?: string }) {
  return (
    <FocusedLayout>
      <div className="stack stack--lg">
        <h1 className="focused__title">Choose a new password</h1>
        {token ? (
          <ResetForm token={token} />
        ) : (
          <Alert tone="danger" title="This link is incomplete" action={<AppLink href="/forgot-password">Request a new link</AppLink>}>
            Open the link from your email again, or request a new one.
          </Alert>
        )}
      </div>
    </FocusedLayout>
  );
}
