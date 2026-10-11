import { recordAudit, type AuditActor } from "@/lib/admin/audit";
import { appUrl, SUPPORT_EMAIL } from "@/lib/brand";
import { prisma } from "@/lib/db";
import { sendAccountEmail } from "@/lib/email";
import { accountApprovedMessage, accountReinstatedMessage, accountSuspendedMessage } from "@/lib/email/account-status";
import { approvalRequired } from "@/lib/readiness";

/**
 * Platform moderation of an influencer: suspend, reinstate, approve. The change and its audit row are written in ONE
 * transaction (an action never happens without its record). Each change is a conditional update, so two administrators
 * clicking at once cannot both win and a repeated click is a clean 409 instead of a second audit row. The influencer is
 * e-mailed after the commit, best effort (a broken mail provider must not undo a suspension).
 *
 * Suspension is enforced elsewhere: lib/readiness.ts (the page goes offline: `isLiveBlocker`, `buildPublicInfluencerWhere`),
 * lib/checkout.ts, lib/booking-approval.ts and lib/payouts.ts.
 */

export class ModerationError extends Error {
  constructor(
    message: string,
    readonly status: 404 | 409 = 409,
  ) {
    super(message);
  }
}

export type ModerationAction = { action: "suspend"; reason: string } | { action: "reinstate" } | { action: "approve" };

export async function moderateInfluencer(actor: AuditActor, influencerId: string, input: ModerationAction, ip: string | null, now = new Date()): Promise<void> {
  const who = await prisma.influencer.findUnique({ where: { id: influencerId }, select: { name: true, email: true, slug: true } });
  if (!who) throw new ModerationError("Influencer not found", 404);

  await prisma.$transaction(async (tx) => {
    let count: number;
    let auditAction: string;
    let detail: { reason: string } | undefined;
    if (input.action === "suspend") {
      ({ count } = await tx.influencer.updateMany({
        where: { id: influencerId, suspendedAt: null },
        data: { suspendedAt: now, suspendedReason: input.reason, suspendedByEmail: actor.email },
      }));
      if (count === 0) throw new ModerationError("This influencer is already suspended.");
      auditAction = "influencer.suspended";
      detail = { reason: input.reason };
    } else if (input.action === "reinstate") {
      ({ count } = await tx.influencer.updateMany({
        where: { id: influencerId, suspendedAt: { not: null } },
        data: { suspendedAt: null, suspendedReason: null, suspendedByEmail: null },
      }));
      if (count === 0) throw new ModerationError("This influencer is not suspended.");
      auditAction = "influencer.reinstated";
    } else {
      // Approval only means something while the gate (READINESS_REQUIRED=...,approval) is on.
      if (!approvalRequired()) throw new ModerationError("Approval is not required: READINESS_REQUIRED does not include \"approval\".");
      ({ count } = await tx.influencer.updateMany({
        where: { id: influencerId, approvedAt: null },
        data: { approvedAt: now, approvedByEmail: actor.email },
      }));
      if (count === 0) throw new ModerationError("This page is already approved.");
      auditAction = "influencer.approved";
    }
    await recordAudit(actor, { action: auditAction, targetType: "influencer", targetId: influencerId, detail, ip }, tx);
  });

  // After the commit, best effort (sendAccountEmail never throws).
  const to = { email: who.email, name: who.name };
  const pageUrl = `${appUrl()}/${who.slug}`;
  if (input.action === "suspend") await sendAccountEmail(to, accountSuspendedMessage(who.name, input.reason, SUPPORT_EMAIL), "account-status");
  else if (input.action === "reinstate") await sendAccountEmail(to, accountReinstatedMessage(who.name, pageUrl), "account-status");
  else await sendAccountEmail(to, accountApprovedMessage(who.name, pageUrl), "account-status");
}
