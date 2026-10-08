import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/prisma/client";

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) });

async function main() {
  const tz = "Asia/Kolkata";
  const influencer = await prisma.influencer.upsert({
    where: { slug: "demo" },
    update: {},
    create: { slug: "demo", name: "Demo Creator", email: "demo@example.com", timezone: tz },
  });
  await prisma.availabilityRule.deleteMany({ where: { influencerId: influencer.id } });
  await prisma.availabilityRule.createMany({
    data: [1, 2, 3, 4, 5].map((weekday) => ({
      influencerId: influencer.id,
      weekday,
      startTime: "10:00",
      endTime: "17:00",
      timezone: tz,
    })),
  });
  const existing = await prisma.service.count({ where: { influencerId: influencer.id } });
  if (existing === 0) {
    await prisma.service.createMany({
      data: [
        { influencerId: influencer.id, title: "1:1 Career Call", description: "30 minutes, just you and me.", durationMin: 30, priceMinor: 49900, type: "ONE_TO_ONE", capacity: 1 },
        { influencerId: influencer.id, title: "Small Group Workshop", description: "Up to 5 people, 60 minutes.", durationMin: 60, priceMinor: 19900, type: "GROUP", capacity: 5 },
      ],
    });
  }
  console.log("Seeded: open /demo/book");
}

main().finally(() => prisma.$disconnect());
