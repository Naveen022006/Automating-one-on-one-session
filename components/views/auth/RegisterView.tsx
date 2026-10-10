import Link from "next/link";
import { RegisterForm } from "@/components/auth/AuthForms";
import { FocusedLayout } from "@/components/site/SiteChrome";

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
          Already have an account? <Link href="/login">Log in</Link>
        </p>
      </div>
    </FocusedLayout>
  );
}
