import type { Metadata } from "next";
import { PageHead } from "@/components/app/AppShell";
import { TwoFactorPanel } from "@/components/admin/TwoFactorPanel";
import { Badge, Card } from "@/components/ui/primitives";
import { listAdministrators } from "@/lib/admin/data";
import { getMfaStatus } from "@/lib/admin/mfa";
import { admin2faRequired } from "@/lib/admin/policy";
import { requireAdminPage } from "@/lib/admin/session";
import { fourEyesEnabled, fourEyesMinMinor } from "@/lib/payouts";

export const metadata: Metadata = { title: "Security" };

// The only console page open to an administrator who still has to set up two-factor (ADMIN_REQUIRE_2FA).
export default async function AdminSecurityPage() {
  const admin = await requireAdminPage("/admin/security");
  const [status, admins] = await Promise.all([getMfaStatus(admin.adminId), listAdministrators()]);
  const required = admin2faRequired();
  const fourEyes = fourEyesEnabled();
  const minMinor = fourEyesMinMinor();

  return (
    <div className="stack stack--lg">
      <PageHead
        title="Security"
        description={`Two-factor sign-in for ${admin.email}. ${required ? "It is required for every administrator." : "It is optional on this deployment, but strongly recommended."}`}
      />
      <Card title="Two-factor authentication">
        <TwoFactorPanel enabled={status.enabled} recoveryCodesLeft={status.recoveryCodesLeft} required={required} />
      </Card>

      <Card title="Payout approval">
        <p className="muted">
          {fourEyes
            ? `A second administrator has to approve each payout before it can be marked as paid${minMinor > 0 ? ` (for net amounts of ${minMinor} minor units and above)` : ""}.`
            : "Payout approval by a second administrator is off (PAYOUT_FOUR_EYES=false). One administrator can create and pay a payout."}
        </p>
      </Card>

      <Card title={`Administrators (${admins.length})`}>
        <div className="table-wrap">
          <table className="table table--stack">
            <caption className="sr-only">Administrators</caption>
            <thead>
              <tr>
                <th scope="col">Email</th>
                <th scope="col">Name</th>
                <th scope="col">Two-factor</th>
                <th scope="col">Last sign-in</th>
                <th scope="col">Status</th>
              </tr>
            </thead>
            <tbody>
              {admins.map((a) => (
                <tr key={a.id}>
                  <td data-label="Email">
                    {a.email}
                    {a.id === admin.adminId && <span className="subtle"> (you)</span>}
                  </td>
                  <td data-label="Name">{a.name}</td>
                  <td data-label="Two-factor">{a.totpEnabled ? <Badge tone="success">On</Badge> : <Badge tone={required ? "danger" : "neutral"}>Off</Badge>}</td>
                  <td data-label="Last sign-in">{a.lastLoginAt ? a.lastLoginAt.toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" }) : "Never"}</td>
                  <td data-label="Status">{a.disabled ? <Badge tone="danger">Disabled</Badge> : <Badge tone="success">Active</Badge>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="subtle">Administrators are created from the command line: <code>npm run admin:create</code>.</p>
      </Card>
    </div>
  );
}
