import { PageHead } from "@web/components/app/AppShell";
import { AdminPasswordForm } from "@web/components/admin/AdminForms";
import { Card } from "@web/components/ui/primitives";

/** The admin console's Settings page (change password). `email` is the signed-in administrator's. */
export function SettingsView({ email }: { email: string }) {
  return (
    <div className="stack stack--lg">
      <PageHead title="Settings" description={`Signed in as ${email}`} />
      <Card title="Change password">
        <AdminPasswordForm />
      </Card>
    </div>
  );
}
