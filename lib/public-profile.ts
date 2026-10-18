import { getAuth } from "@/lib/auth/session";
import { prisma } from "@/lib/db";
import { parseQuestions, type IntakeQuestion } from "@/lib/intake";
import { evaluateReadiness, isLiveBlocker, readinessInput } from "@/lib/readiness";
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
  intakeQuestions: IntakeQuestion[];
  prepNotes: string | null;
  requiresApproval: boolean;
  minNoticeHours: number;
  maxAdvanceDays: number;
}

export interface PublicProfile {
  slug: string;
  name: string;
  bio: string | null;
  photoUrl: string | null;
  services: PublicService[];
  /** True when the page is not live yet and only the logged-in owner is previewing it. */
  preview: boolean;
  /** Preview only: what is still missing before the page goes live. */
  blockers: string[];
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
      googleToken: { select: { status: true, scope: true } },
      payoutAccount: { select: { status: true } },
      whatsappConnection: { select: { status: true, templates: true } },
      _count: { select: { rules: true, services: { where: { active: true } } } },
    },
  });
  if (!influencer) return null;
  const emailVerified = !influencer.user || influencer.user.emailVerifiedAt !== null;
  const readiness = evaluateReadiness(readinessInput(influencer, emailVerified));
  // Live needs onboarding finished, a verified email and every REQUIRED connection. (Services and hours are not part
  // of "live": a page with nothing to book simply shows nothing.)
  const connectionBlockers = readiness.blockers.filter((b) => isLiveBlocker(b.key));
  const live = influencer.onboardedAt !== null && connectionBlockers.length === 0;
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
    preview,
    blockers: preview ? readiness.blockers.map((b) => b.label) : [],
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
      intakeQuestions: parseQuestions(s.intakeQuestions),
      prepNotes: s.prepNotes,
      requiresApproval: s.requiresApproval,
      minNoticeHours: s.minNoticeHours,
      maxAdvanceDays: s.maxAdvanceDays,
    })),
  };
}
