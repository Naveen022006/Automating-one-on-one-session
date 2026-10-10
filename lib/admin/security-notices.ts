import { prisma } from "@/lib/db";
import { sendAccountEmail } from "@/lib/email";
import { adminSecurityMessage, type AdminSecurityEvent } from "@/lib/email/templates";
import { reportNotice } from "@/lib/observability";

/**
 * Tells an administrator, by email, that something changed about their own sign-in security (2FA turned on or off,
 * recovery codes regenerated, authenticator codes locked after repeated failures), so a takeover cannot go unnoticed.
 * A lockout is also reported through the operator channel (reportNotice, ERROR_WEBHOOK_URL). Best-effort: it never
 * throws, because a broken mail provider must not undo or block the security action itself.
 */
export async function notifyAdminSecurity(
  adminId: string,
  event: AdminSecurityEvent,
  detail: { ip?: string | null; lockedUntil?: Date | null } = {},
): Promise<void> {
  try {
    const admin = await prisma.adminUser.findUnique({ where: { id: adminId }, select: { email: true, name: true } });
    if (!admin) return;
    if (event === "mfa-locked") {
      reportNotice("warn", `Administrator ${admin.email}: authenticator codes locked after repeated failures`, {
        where: "admin-mfa",
        adminId,
        lockedUntil: detail.lockedUntil?.toISOString() ?? null,
      });
    }
    await sendAccountEmail({ email: admin.email, name: admin.name }, adminSecurityMessage(admin.name, event, { at: new Date(), ...detail }), "admin-security");
  } catch (e) {
    console.error(`[admin-security:${event}] notification failed`, e instanceof Error ? e.message : e);
  }
}
