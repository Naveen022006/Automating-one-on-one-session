import Link from "next/link";
import { LoginForm } from "@/components/auth/AuthForms";
import { FocusedLayout } from "@/components/site/SiteChrome";

/**
 * The login screen. `next` and `reset` are the raw `?next=` and `?reset=` query values (the form sends `next` to the API,
 * which validates it; any non-empty `reset` shows the "password changed" notice).
 */
export function LoginView({ next, reset }: { next?: string; reset?: string }) {
  return (
    <FocusedLayout>
      <div className="stack stack--lg">
        <div className="stack stack--sm">
          <h1 className="focused__title">Welcome back</h1>
          <p className="muted">Log in to manage your sessions and booking page.</p>
        </div>
        <LoginForm next={next} notice={reset ? "Your password was changed. Please log in." : undefined} />
        <p className="muted text-sm">
          New here? <Link href="/register">Create an account</Link>
        </p>
      </div>
    </FocusedLayout>
  );
}
