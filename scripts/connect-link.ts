import "dotenv/config";
import { prisma } from "../lib/db";
import { buildConnectUrl } from "../lib/google-tokens";

// Usage: npm run google:connect-link -- <influencer-slug> [days-valid]
// Prints the signed link an influencer opens to connect (or reconnect) their Google Calendar.
async function main() {
  const [slug, days = "7"] = process.argv.slice(2);
  if (!slug) throw new Error("Usage: npm run google:connect-link -- <influencer-slug> [days-valid]");
  const ttlDays = Number(days);
  if (!Number.isFinite(ttlDays) || ttlDays <= 0) throw new Error("days-valid must be a positive number");

  const influencer = await prisma.influencer.findUnique({ where: { slug }, include: { googleToken: true } });
  if (!influencer) throw new Error(`No influencer with slug "${slug}"`);

  const status = influencer.googleToken ? influencer.googleToken.status : "NOT_CONNECTED";
  console.log(`Influencer: ${influencer.name} (${influencer.slug})   Google status: ${status}`);
  console.log(buildConnectUrl(influencer.id, Math.round(ttlDays * 86_400)));
}

main()
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
