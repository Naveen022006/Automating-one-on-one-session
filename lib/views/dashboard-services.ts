import type { ServiceAdmin } from "@/components/app/ServicesManager";
import { prisma } from "@/lib/db";
import { parseQuestions } from "@/lib/intake";

/**
 * The Services page and the onboarding wizard's first-service step. One function, three callers: the old Next page
 * (app/dashboard/services/page.tsx), GET /api/dashboard/services for the SPA, and loadOnboardingView, so they cannot
 * disagree. The DTO is the editor's own prop type (`ServiceAdmin`), so a field the editor starts to need is a compile
 * error here instead of an `undefined` in production.
 */
export type ServiceView = ServiceAdmin;

export interface DashboardServicesView {
  services: ServiceView[];
}

/** The influencer's services, oldest first. Hidden (inactive) ones are included: the editor lists them too. */
export async function listServiceViews(influencerId: string): Promise<ServiceView[]> {
  const services = await prisma.service.findMany({
    where: { influencerId },
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      title: true,
      description: true,
      durationMin: true,
      priceMinor: true,
      currency: true,
      type: true,
      capacity: true,
      active: true,
      refundPolicy: true,
      intakeQuestions: true,
      minNoticeHours: true,
      maxAdvanceDays: true,
      prepNotes: true,
      requiresApproval: true,
    },
  });
  return services.map((s) => ({
    id: s.id,
    title: s.title,
    description: s.description,
    durationMin: s.durationMin,
    priceMinor: s.priceMinor,
    currency: s.currency,
    type: s.type,
    capacity: s.capacity,
    active: s.active,
    refundPolicy: s.refundPolicy,
    intakeQuestions: parseQuestions(s.intakeQuestions),
    minNoticeHours: s.minNoticeHours,
    maxAdvanceDays: s.maxAdvanceDays,
    prepNotes: s.prepNotes,
    requiresApproval: s.requiresApproval,
  }));
}

export async function loadServicesView(influencerId: string): Promise<DashboardServicesView> {
  return { services: await listServiceViews(influencerId) };
}
