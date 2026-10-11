import { prisma } from "@/lib/db";
import type { BlockedRow, RuleRow } from "@/lib/views/dashboard-types";

/**
 * The Availability page and the onboarding wizard's hours step. Shared by GET /api/dashboard/availability and
 * loadOnboardingView. `timezone` is the influencer's own (the editor's default for new
 * hours); each rule carries the zone it was entered in.
 */
export interface DashboardAvailabilityView {
  timezone: string;
  rules: RuleRow[];
  /** `date` is the calendar day as YYYY-MM-DD. */
  blocked: BlockedRow[];
}

export async function listRuleViews(influencerId: string): Promise<RuleRow[]> {
  const rules = await prisma.availabilityRule.findMany({
    where: { influencerId },
    orderBy: [{ weekday: "asc" }, { startTime: "asc" }],
    select: { id: true, weekday: true, startTime: true, endTime: true, timezone: true },
  });
  return rules.map((r) => ({ id: r.id, weekday: r.weekday, startTime: r.startTime, endTime: r.endTime, timezone: r.timezone }));
}

export async function listBlockedViews(influencerId: string): Promise<BlockedRow[]> {
  const blocked = await prisma.blockedDate.findMany({ where: { influencerId }, orderBy: { date: "asc" }, select: { id: true, date: true, reason: true } });
  return blocked.map((b) => ({ id: b.id, date: b.date.toISOString().slice(0, 10), reason: b.reason }));
}

export async function loadAvailabilityView(influencerId: string): Promise<DashboardAvailabilityView> {
  const [influencer, rules, blocked] = await Promise.all([
    prisma.influencer.findUniqueOrThrow({ where: { id: influencerId }, select: { timezone: true } }),
    listRuleViews(influencerId),
    listBlockedViews(influencerId),
  ]);
  return { timezone: influencer.timezone, rules, blocked };
}
