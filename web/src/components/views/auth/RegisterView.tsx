import { AppLink } from "@web/lib/link";
import { RegisterForm } from "@web/components/auth/AuthForms";
import { FocusedLayout } from "@web/components/site/SiteChrome";

export function RegisterView() {
  return (
    <FocusedLayout>
      <div className="stack stack--lg">
        <div className="stack stack--sm">
          <h1 className="focused__title">Create your booking page</h1>
          <p className="muted">It takes a few minutes. Your customers will never need an account.</p>
        </div>
        <RegisterForm />
        <p className="muted text-sm">
          Already have an account? <AppLink href="/login">Log in</AppLink>
        </p>
      </div>
    </FocusedLayout>
  );
}
