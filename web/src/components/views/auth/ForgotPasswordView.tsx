import { AppLink } from "@web/lib/link";
import { ForgotForm } from "@web/components/auth/AuthForms";
import { FocusedLayout } from "@web/components/site/SiteChrome";

export function ForgotPasswordView() {
  return (
    <FocusedLayout>
      <div className="stack stack--lg">
        <div className="stack stack--sm">
          <h1 className="focused__title">Reset your password</h1>
          <p className="muted">Enter the email you signed up with and we will send you a link.</p>
        </div>
        <ForgotForm />
        <p className="muted text-sm">
          Remembered it? <AppLink href="/login">Back to log in</AppLink>
        </p>
      </div>
    </FocusedLayout>
  );
}
