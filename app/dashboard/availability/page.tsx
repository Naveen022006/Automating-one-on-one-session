import type { Metadata } from "next";
import { PageHead } from "@/components/app/AppShell";
import { BlockedDays, WeeklyHours } from "@/components/app/AvailabilityEditor";
import { requirePageAuth } from "@/lib/auth/guards";
import { prisma } from "@/lib/db";

export const metadata: Metadata = { title: "Availability" };

export default async function AvailabilityPage() {
  const auth = await requirePageAuth("/dashboard/availability");
  const [influencer, rules, blocked] = await Promise.all([
    prisma.influencer.findUniqueOrThrow({ where: { id: auth.influencerId }, select: { timezone: true } }),
    prisma.availabilityRule.findMany({ where: { influencerId: auth.influencerId }, orderBy: [{ weekday: "asc" }, { startTime: "asc" }] }),
    prisma.blockedDate.findMany({ where: { influencerId: auth.influencerId }, orderBy: { date: "asc" } }),
  ]);
  return (
    <div className="stack stack--lg">
      <PageHead title="Availability" description="Your weekly hours and days off. Customers can only book open times inside these hours." />
      <WeeklyHours
        timezone={influencer.timezone}
        rules={rules.map((r) => ({ id: r.id, weekday: r.weekday, startTime: r.startTime, endTime: r.endTime, timezone: r.timezone }))}
      />
      <BlockedDays timezone={influencer.timezone} blocked={blocked.map((b) => ({ id: b.id, date: b.date.toISOString().slice(0, 10), reason: b.reason }))} />
    </div>
  );
}
