import { listAdministrators } from "@/lib/admin/data";
import { getMfaStatus } from "@/lib/admin/mfa";
import { admin2faRequired } from "@/lib/admin/policy";
import { canViewAdminList, type AdminContext } from "@/lib/admin/session";
import { platformEmailEnabled } from "@/lib/email/providers";
import { fourEyesEnabled, fourEyesMinMinor } from "@/lib/payouts";

/**
 * The admin console's Security page: the signed-in administrator's own two-factor state, the payout-approval policy and
 * (only once this session has passed what it must) the list of administrators. Served by
 * GET /api/admin/security. The caller has already passed the gate
 * (`requireAdminMfa({ allowEnrollment: true })`): the one console screen an
 * administrator who still has to enrol two-factor may open, a password-only session of one who has it may not.
 *
 * Never in here: the TOTP secret or the recovery codes (they only ever leave through POST /api/admin/security/2fa, at the
 * moment they are made), password hashes, other administrators' sessions or ids.
 */
export interface AdminSecurityView {
  email: string;
  mfa: { enabled: boolean; recoveryCodesLeft: number };
  /** ADMIN_REQUIRE_2FA: two-factor is mandatory on this deployment. */
  required: boolean;
  /** PAYOUT_FOUR_EYES: a second administrator approves each payout. */
  fourEyes: boolean;
  fourEyesMinMinor: number;
  /** False when the platform sends no e-mail (EMAIL_PROVIDER=none): administrators are then not told by e-mail when their 2FA changes. */
  emailEnabled: boolean;
  /**
   * Who the administrators are, who has two-factor and who signed in when. NULL (not an empty list) for a session that has
   * not passed what it must (a stolen cookie of an administrator who has not enrolled yet could otherwise be used to pick
   * targets): `canViewAdminList`.
   */
  admins: { email: string; name: string; totpEnabled: boolean; lastLoginAt: Date | null; disabled: boolean; isSelf: boolean }[] | null;
}

export async function loadAdminSecurityView(admin: AdminContext): Promise<AdminSecurityView> {
  const showAdmins = canViewAdminList(admin);
  const [status, admins] = await Promise.all([getMfaStatus(admin.adminId), showAdmins ? listAdministrators() : Promise.resolve(null)]);
  return {
    email: admin.email,
    mfa: { enabled: status.enabled, recoveryCodesLeft: status.recoveryCodesLeft },
    required: admin2faRequired(),
    fourEyes: fourEyesEnabled(),
    fourEyesMinMinor: fourEyesMinMinor(),
    emailEnabled: platformEmailEnabled(),
    admins: admins
      ? admins.map((a) => ({ email: a.email, name: a.name, totpEnabled: a.totpEnabled, lastLoginAt: a.lastLoginAt, disabled: a.disabled, isSelf: a.id === admin.adminId }))
      : null,
  };
}
