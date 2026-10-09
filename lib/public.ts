import type { Prisma } from "@/generated/prisma/client";
import { buildPublicInfluencerWhere } from "@/lib/readiness";

/**
 * When an influencer's booking page is live: onboarding finished, the account email verified (profiles that predate
 * accounts have no user and stay live), and every connection required by READINESS_REQUIRED in place (by default Google
 * Calendar and payout details). This stops an account that cannot create Meet links or be paid from taking
 * bookings and payments. The dashboard checklist (lib/readiness.ts) is built from the same rules.
 */
export const publicInfluencerWhere: Prisma.InfluencerWhereInput = buildPublicInfluencerWhere();
