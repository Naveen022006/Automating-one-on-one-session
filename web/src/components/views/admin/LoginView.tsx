import { AdminLoginForm } from "@/components/admin/AdminForms";
import { FocusedLayout } from "@/components/site/SiteChrome";

/** The administrator sign-in screen. `next` is the raw `?next=` of the URL; the login API validates it before redirecting. */
export function LoginView({ next }: { next?: string }) {
  return (
    <FocusedLayout footer={<span>Authorised administrators only. Activity is logged.</span>}>
      <div className="stack stack--lg">
        <div className="stack stack--sm">
          <h1 className="focused__title">Admin console</h1>
          <p className="muted">Sign in with your administrator account.</p>
        </div>
        <AdminLoginForm next={next} />
      </div>
    </FocusedLayout>
  );
}
