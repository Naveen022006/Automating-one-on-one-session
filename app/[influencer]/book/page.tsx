import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { BookingFlow } from "./BookingFlow";

export const dynamic = "force-dynamic";

export default async function BookPage({ params }: { params: Promise<{ influencer: string }> }) {
  const { influencer: slug } = await params;
  const influencer = await prisma.influencer.findUnique({
    where: { slug },
    include: { services: { where: { active: true }, orderBy: { createdAt: "asc" } } },
  });
  if (!influencer) notFound();

  return (
    <main>
      <h1>Book a session with {influencer.name}</h1>
      <p className="muted">Pick a service, a time, and tell us where to send your meeting link.</p>
      <BookingFlow
        services={influencer.services.map((s) => ({
          id: s.id,
          title: s.title,
          description: s.description,
          durationMin: s.durationMin,
          priceMinor: s.priceMinor,
          currency: s.currency,
          type: s.type,
          capacity: s.capacity,
        }))}
      />
    </main>
  );
}
