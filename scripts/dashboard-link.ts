import "dotenv/config";
import { prisma } from "../lib/db";
import { buildDashboardUrl } from "../lib/dashboard";

// Usage: npm run dashboard:link -- <influencer-slug> [days-valid]
// Prints the signed link an influencer opens to view their dashboard (upcoming/past sessions, earnings).
async function main() {
  const [slug, days = "7"] = process.argv.slice(2);
  if (!slug) throw new Error("Usage: npm run dashboard:link -- <influencer-slug> [days-valid]");
  const ttlDays = Number(days);
  if (!Number.isFinite(ttlDays) || ttlDays <= 0) throw new Error("days-valid must be a positive number");

  const influencer = await prisma.influencer.findUnique({ where: { slug } });
  if (!influencer) throw new Error(`No influencer with slug "${slug}"`);

  console.log(`Influencer: ${influencer.name} (${influencer.slug})`);
  console.log(buildDashboardUrl(influencer.id, Math.round(ttlDays * 86_400)));
}

main()
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
