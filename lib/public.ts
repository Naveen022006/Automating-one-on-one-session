import type { Prisma } from "@/generated/prisma/client";

/**
 * When an influencer's booking page is live: onboarding finished, and the account email verified (profiles that
 * predate accounts have no user and stay live). This stops a freshly registered, unverified account from
 * publishing a page and taking payments.
 */
export const publicInfluencerWhere: Prisma.InfluencerWhereInput = {
  onboardedAt: { not: null },
  OR: [{ user: { is: null } }, { user: { is: { emailVerifiedAt: { not: null } } } }],
};
