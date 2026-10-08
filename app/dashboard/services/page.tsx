import type { Metadata } from "next";
import { PageHead } from "@/components/app/AppShell";
import { ServicesManager } from "@/components/app/ServicesManager";
import { requirePageAuth } from "@/lib/auth/guards";
import { prisma } from "@/lib/db";

export const metadata: Metadata = { title: "Services" };

export default async function ServicesPage() {
  const auth = await requirePageAuth("/dashboard/services");
  const services = await prisma.service.findMany({ where: { influencerId: auth.influencerId }, orderBy: { createdAt: "asc" } });
  return (
    <div className="stack stack--lg">
      <PageHead title="Services" description="What customers can book. Hidden services stay on existing bookings but cannot be booked." />
      <ServicesManager
        services={services.map((s) => ({
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
        }))}
      />
    </div>
  );
}
