import { recordAudit, type AuditActor } from "@/lib/admin/audit";
import { createPasswordResetLink } from "@/lib/auth/accounts";
import { prisma } from "@/lib/db";

/**
 * Account help an administrator gives by hand when the platform sends no e-mail (EMAIL_PROVIDER=none, doc/15): without these two actions
 * an influencer who registered could never verify their address, and one who forgot their password could never get back in.
 *
 * Both run in ONE transaction with their audit row (an action never happens without its record), and both are clean 409s when repeated.
 * The audit rows say what was done to which influencer and never carry the link or its token.
 */

export class AccountHelpError extends Error {
  constructor(
    message: string,
    readonly status: 404 | 409,
  ) {
    super(message);
  }
}

const NO_SIGN_IN = "This influencer has no sign-in account, so there is nothing to verify or reset.";

/** Marks the influencer's login address as verified. 404 unknown influencer, 409 no account or already verified. */
export async function adminVerifyEmail(actor: AuditActor, influencerId: string, ip: string | null, now = new Date()): Promise<void> {
  const user = await prisma.user.findUnique({ where: { influencerId }, select: { id: true } });
  if (!user) {
    const exists = await prisma.influencer.findUnique({ where: { id: influencerId }, select: { id: true } });
    throw exists ? new AccountHelpError(NO_SIGN_IN, 409) : new AccountHelpError("Influencer not found", 404);
  }
  await prisma.$transaction(async (tx) => {
    // Conditional, so two administrators clicking at once cannot both win and a repeat writes no second audit row.
    const { count } = await tx.user.updateMany({ where: { id: user.id, emailVerifiedAt: null }, data: { emailVerifiedAt: now } });
    if (count === 0) throw new AccountHelpError("This email address is already verified.", 409);
    // Verification links sent earlier have nothing left to do.
    await tx.emailVerificationToken.updateMany({ where: { userId: user.id, usedAt: null }, data: { usedAt: now } });
    await recordAudit(actor, { action: "influencer.email_verified", targetType: "influencer", targetId: influencerId, ip }, tx);
  });
}

/**
 * Creates a one-time password-reset link for the influencer, to be handed over by the administrator. The FULL link is returned once,
 * to the caller; it is stored only as a hash and is in neither the audit row nor any log. It expires like an e-mailed reset link, and a
 * newer link (or this one being used) cancels the older ones. 404 unknown influencer, 409 no sign-in account.
 */
export async function adminCreateResetLink(actor: AuditActor, influencerId: string, ip: string | null): Promise<{ url: string; expiresAt: Date }> {
  const user = await prisma.user.findUnique({ where: { influencerId }, select: { id: true } });
  if (!user) {
    const exists = await prisma.influencer.findUnique({ where: { id: influencerId }, select: { id: true } });
    throw exists ? new AccountHelpError(NO_SIGN_IN, 409) : new AccountHelpError("Influencer not found", 404);
  }
  return prisma.$transaction(async (tx) => {
    const link = await createPasswordResetLink(user.id, tx);
    await recordAudit(actor, { action: "influencer.reset_link_created", targetType: "influencer", targetId: influencerId, detail: { expiresAt: link.expiresAt.toISOString() }, ip }, tx);
    return link;
  });
}
