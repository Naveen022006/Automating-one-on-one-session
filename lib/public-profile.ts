import { getAuth } from "@/lib/auth/session";
import { prisma } from "@/lib/db";
import { describeRefundPolicy, type RefundPolicy } from "@/lib/refund-policy";

export interface PublicService {
  id: string;
  title: string;
  description: string | null;
  durationMin: number;
  priceMinor: number;
  currency: string;
  type: "ONE_TO_ONE" | "GROUP";
  capacity: number;
  refundPolicy: RefundPolicy;
  refundText: string;
}

export interface PublicProfile {
  slug: string;
  name: string;
  bio: string | null;
  photoUrl: string | null;
  timezone: string;
  services: PublicService[];
  /** True when the page is not live yet and only the logged-in owner is previewing it. */
  preview: boolean;
}

/**
 * Loads an influencer's public page. A page that is not live yet (onboarding unfinished or email unverified) is
 * visible only to its logged-in owner, as a preview; everyone else gets null (404).
 */
export async function loadPublicProfile(slug: string): Promise<PublicProfile | null> {
  const influencer = await prisma.influencer.findUnique({
    where: { slug },
    include: {
      services: { where: { active: true }, orderBy: { createdAt: "asc" } },
      user: { select: { emailVerifiedAt: true } },
    },
  });
  if (!influencer) return null;
  const live = influencer.onboardedAt !== null && (!influencer.user || influencer.user.emailVerifiedAt !== null);
  let preview = false;
  if (!live) {
    const auth = await getAuth();
    if (auth?.influencerId !== influencer.id) return null;
    preview = true;
  }
  return {
    slug: influencer.slug,
    name: influencer.name,
    bio: influencer.bio,
    photoUrl: influencer.photoUrl,
    timezone: influencer.timezone,
    preview,
    services: influencer.services.map((s) => ({
      id: s.id,
      title: s.title,
      description: s.description,
      durationMin: s.durationMin,
      priceMinor: s.priceMinor,
      currency: s.currency,
      type: s.type,
      capacity: s.capacity,
      refundPolicy: s.refundPolicy,
      refundText: describeRefundPolicy(s.refundPolicy),
    })),
  };
}
