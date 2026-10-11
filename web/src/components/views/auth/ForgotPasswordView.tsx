import Link from "next/link";
import { ForgotForm } from "@/components/auth/AuthForms";
import { FocusedLayout } from "@/components/site/SiteChrome";

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
          Remembered it? <Link href="/login">Back to log in</Link>
        </p>
      </div>
    </FocusedLayout>
  );
}
