import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/prisma/client";
import { hashPassword } from "../lib/auth/password";

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) });

// Local demo login. Never seeded in production.
const DEMO_EMAIL = "demo@example.com";
const DEMO_PASSWORD = process.env.SEED_DEMO_PASSWORD || "demo-sessions-2026";

async function main() {
  const tz = "Asia/Kolkata";
  const influencer = await prisma.influencer.upsert({
    where: { slug: "demo" },
    update: { onboardedAt: new Date() },
    create: {
      slug: "demo",
      name: "Demo Creator",
      email: DEMO_EMAIL,
      timezone: tz,
      bio: "Career coach for early-stage engineers. I help you plan your next move, prepare for interviews and negotiate offers.",
      onboardedAt: new Date(),
    },
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
        { influencerId: influencer.id, title: "1:1 Career Call", description: "30 minutes, just you and me.", durationMin: 30, priceMinor: 49900, type: "ONE_TO_ONE", capacity: 1, refundPolicy: "NOTICE_24H" },
        { influencerId: influencer.id, title: "Small Group Workshop", description: "Up to 5 people, 60 minutes.", durationMin: 60, priceMinor: 19900, type: "GROUP", capacity: 5, refundPolicy: "FULL" },
      ],
    });
  }

  if (process.env.NODE_ENV !== "production") {
    const passwordHash = await hashPassword(DEMO_PASSWORD);
    await prisma.user.upsert({
      where: { email: DEMO_EMAIL },
      update: {},
      create: {
        email: DEMO_EMAIL,
        passwordHash,
        emailVerifiedAt: new Date(),
        termsAcceptedAt: new Date(),
        influencerId: influencer.id,
      },
    });
    console.log(`Seeded. Booking page: /demo  ·  Dashboard login: ${DEMO_EMAIL} / ${DEMO_PASSWORD}`);
  } else {
    console.log("Seeded: open /demo");
  }
}

main().finally(() => prisma.$disconnect());
