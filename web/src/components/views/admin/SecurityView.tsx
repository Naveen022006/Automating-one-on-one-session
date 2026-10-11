import { PageHead } from "@web/components/app/AppShell";
import { TwoFactorPanel } from "@web/components/admin/TwoFactorPanel";
import { Badge, Card } from "@web/components/ui/primitives";
import type { Jsonify } from "@/lib/jsonify";
import type { AdminSecurityView } from "@/lib/views/admin-security";

/**
 * The admin console's Security page: the only console screen open to an administrator who still has to set up two-factor
 * (ADMIN_REQUIRE_2FA). `data.admins` is null for a session that has not passed what it must; then the list is not even sent.
 */
export function SecurityView({ data }: { data: Jsonify<AdminSecurityView> }) {
  const { admins, required, fourEyes, fourEyesMinMinor: minMinor } = data;

  return (
    <div className="stack stack--lg">
      <PageHead
        title="Security"
        description={`Two-factor sign-in for ${data.email}. ${required ? "It is required for every administrator." : "It is optional on this deployment, but strongly recommended."}`}
      />
      <Card title="Two-factor authentication">
        <TwoFactorPanel enabled={data.mfa.enabled} recoveryCodesLeft={data.mfa.recoveryCodesLeft} required={required} />
      </Card>

      <Card title="Payout approval">
        <p className="muted">
          {fourEyes
            ? `A second administrator has to approve each payout before it can be marked as paid${minMinor > 0 ? ` (when the payout plus that influencer's other unapproved payouts of the last 24 hours reach ${minMinor} minor units of its currency)` : ""}.`
            : "Payout approval by a second administrator is off (PAYOUT_FOUR_EYES=false). One administrator can create and pay a payout."}
        </p>
      </Card>

      {!admins ? (
        <Card title="Administrators">
          <p className="muted">The list of administrators is shown after you have set up two-factor authentication and signed in with it.</p>
        </Card>
      ) : (
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
                <tr key={a.email}>
                  <td data-label="Email">
                    {a.email}
                    {a.isSelf && <span className="subtle"> (you)</span>}
                  </td>
                  <td data-label="Name">{a.name}</td>
                  <td data-label="Two-factor">{a.totpEnabled ? <Badge tone="success">On</Badge> : <Badge tone={required ? "danger" : "neutral"}>Off</Badge>}</td>
                  <td data-label="Last sign-in">{a.lastLoginAt ? new Date(a.lastLoginAt).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" }) : "Never"}</td>
                  <td data-label="Status">{a.disabled ? <Badge tone="danger">Disabled</Badge> : <Badge tone="success">Active</Badge>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="subtle">Administrators are created from the command line: <code>npm run admin:create</code>.</p>
      </Card>
      )}
    </div>
  );
}
