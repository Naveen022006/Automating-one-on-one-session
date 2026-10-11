import type { AuthContext } from "@/lib/auth/session";
import { prisma } from "@/lib/db";

/**
 * Everything the dashboard frame (sidebar, account menu, badge) needs. Served by
 * GET /api/dashboard/shell. The caller has already authenticated (`requireApiAuth`).
 */
export interface DashboardShellView {
  user: { name: string; email: string; slug: string; photoUrl: string | null; emailVerified: boolean; onboarded: boolean };
  /** The number on the Overview nav item: payments to refund, a Google problem, an unverified email. */
  attentionCount: number;
}

export async function loadDashboardShell(auth: AuthContext): Promise<DashboardShellView> {
  const [influencer, attention] = await Promise.all([
    prisma.influencer.findUnique({ where: { id: auth.influencerId }, select: { photoUrl: true, googleToken: { select: { status: true } } } }),
    prisma.payment.count({ where: { needsRefund: true, status: "CAPTURED", booking: { session: { service: { influencerId: auth.influencerId } } } } }),
  ]);
  const googleIssue = !influencer?.googleToken || influencer.googleToken.status !== "ACTIVE" ? 1 : 0;
  return {
    user: {
      name: auth.influencerName,
      email: auth.email,
      slug: auth.influencerSlug,
      photoUrl: influencer?.photoUrl ?? null,
      emailVerified: auth.emailVerified,
      onboarded: auth.onboarded,
    },
    attentionCount: attention + googleIssue + (auth.emailVerified ? 0 : 1),
  };
}
