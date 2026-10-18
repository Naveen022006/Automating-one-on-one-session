import { AppLink } from "@web/lib/link";
import { ForgotForm } from "@web/components/auth/AuthForms";
import { FocusedLayout } from "@web/components/site/SiteChrome";
import { Alert } from "@web/components/ui/primitives";

/**
 * `emailEnabled` false (doc/15): the platform sends no e-mail, so there is no form that could deliver a link. `loading`: the answer to
 * "does this site send e-mail?" is still on its way, so neither the form nor the explanation is shown yet (a form that then turns into
 * "ask your administrator" would be a promise taken back).
 */
export function ForgotPasswordView({ emailEnabled = true, loading = false }: { emailEnabled?: boolean; loading?: boolean }) {
  return (
    <FocusedLayout>
      <div className="stack stack--lg">
        <div className="stack stack--sm">
          <h1 className="focused__title">Reset your password</h1>
          {emailEnabled && !loading && <p className="muted">Enter the email you signed up with and we will send you a link.</p>}
        </div>
        {loading ? (
          <p className="muted" role="status">
            Loading…
          </p>
        ) : emailEnabled ? (
          <ForgotForm />
        ) : (
          <Alert tone="info" title="Ask your administrator for a reset link">
            This site does not send e-mail, so a reset link cannot be e-mailed to you. Ask your administrator for a password reset link. It works once and for one hour, and opens a page where you choose a new password.
          </Alert>
        )}
        <p className="muted text-sm">
          Remembered it? <AppLink href="/login">Back to log in</AppLink>
        </p>
      </div>
    </FocusedLayout>
  );
}
