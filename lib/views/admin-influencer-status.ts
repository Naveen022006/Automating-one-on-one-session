import { accountStatusOf, type AccountStatus } from "@/lib/admin/data";
import { prisma } from "@/lib/db";
import { platformEmailEnabled } from "@/lib/email/providers";
import { approvalRequired } from "@/lib/readiness";

/**
 * The moderation panel on the admin console's Influencer page. Served by GET and POST /api/admin/influencers/:id/status.
 * The caller has already passed the admin gate (`requireAdminMfa()`).
 *
 * Built field by field. The administrator who suspended is shown to administrators only; the influencer's own dashboard
 * (lib/readiness.ts) carries the reason and nothing else.
 */
export interface AdminInfluencerStatusView {
  status: AccountStatus;
  suspension: { at: Date; reason: string; byEmail: string } | null;
  approval: { required: boolean; at: Date | null; byEmail: string | null };
  /** Shown in the confirm dialog: what a suspension does NOT touch. */
  impact: { upcomingPaidBookings: number; pendingPayouts: number };
  /** False when the platform sends no e-mail (EMAIL_PROVIDER=none): the panel must not say the influencer "is emailed". */
  emailEnabled: boolean;
}

/** Null when there is no such influencer (the caller answers 404). */
export async function loadInfluencerStatusView(id: string, now = new Date()): Promise<AdminInfluencerStatusView | null> {
  const row = await prisma.influencer.findUnique({
    where: { id },
    select: { onboardedAt: true, suspendedAt: true, suspendedReason: true, suspendedByEmail: true, approvedAt: true, approvedByEmail: true },
  });
  if (!row) return null;
  const [upcomingPaidBookings, pendingPayouts] = await Promise.all([
    prisma.booking.count({
      where: { status: { in: ["PAID", "SCHEDULED"] }, session: { startTime: { gt: now }, service: { influencerId: id } } },
    }),
    prisma.payout.count({ where: { influencerId: id, status: "PENDING" } }),
  ]);
  const required = approvalRequired();
  return {
    status: accountStatusOf(row, required),
    suspension: row.suspendedAt ? { at: row.suspendedAt, reason: row.suspendedReason ?? "", byEmail: row.suspendedByEmail ?? "" } : null,
    approval: { required, at: row.approvedAt, byEmail: row.approvedByEmail },
    impact: { upcomingPaidBookings, pendingPayouts },
    emailEnabled: platformEmailEnabled(),
  };
}
