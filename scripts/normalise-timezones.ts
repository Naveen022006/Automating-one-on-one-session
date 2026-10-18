import "dotenv/config";
import { CONFIRM_VALUE, describeAction, parseNormaliseArgs, planInfluencer, type InfluencerPlan } from "../lib/normalise-timezones";

/**
 * Moves weekly availability rules that were saved in another time zone to Indian Standard Time (doc/14-india-localisation.md, section 4).
 *
 *   npm run data:normalise-timezones                                           DRY RUN (default): prints what would change, changes nothing
 *   npm run data:normalise-timezones -- --apply --confirm=NORMALISE-TIMEZONES  write the CONVERT lines, one transaction per influencer
 *
 * A rule is converted only when that is exact: its zone has no daylight saving (the UTC offset is the same all year) and the shifted
 * window stays on the same weekday. Everything else is REFUSED and left alone (lib/slots.ts keeps honouring the stored zone, so
 * customers see the same times as before); the influencer re-enters those hours in IST from the Availability page, which says so.
 * Bookings are instants and never refer to a rule, so no booked session moves. Each update is compare-and-set (it only writes the row if
 * it still holds the values that were planned), so an influencer editing at the same moment is never overwritten. An influencer whose
 * rules are all IST afterwards also gets `timezone = Asia/Kolkata` (a column nothing reads any more).
 * Exit code: 0 ok, 1 failure, 2 bad usage.
 */

const USAGE = `Usage: npm run data:normalise-timezones [-- --apply --confirm=${CONFIRM_VALUE}]\n  (no flags = dry run; nothing is changed)`;

async function main(): Promise<number> {
  const args = parseNormaliseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(USAGE);
    return 0;
  }
  if (args.unknown.length > 0) {
    console.error(`Unknown argument(s): ${args.unknown.join(" ")}\n${USAGE}`);
    return 2;
  }
  if (!args.apply && args.confirm !== null) {
    console.error(`--confirm only goes with --apply.\n${USAGE}`);
    return 2;
  }
  if (args.apply && args.confirm !== CONFIRM_VALUE) {
    console.error(`--apply needs --confirm=${CONFIRM_VALUE}.\n${USAGE}`);
    return 2;
  }
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL is not set.");
    return 2;
  }

  // Imported after the checks, so a usage error never opens a database connection.
  const { prisma } = await import("../lib/db");
  try {
    console.log(args.apply ? "MODE: APPLY (one transaction per influencer)" : "MODE: DRY RUN (nothing is changed)");
    const now = new Date();
    const rows = await prisma.influencer.findMany({
      where: { rules: { some: { timezone: { not: "Asia/Kolkata" } } } },
      select: { id: true, slug: true, timezone: true, rules: { select: { id: true, weekday: true, startTime: true, endTime: true, timezone: true }, orderBy: [{ weekday: "asc" }, { startTime: "asc" }] } },
      orderBy: { slug: "asc" },
    });
    const plans: InfluencerPlan[] = rows.map((r) => planInfluencer(r, now));
    let convert = 0;
    let refuse = 0;
    for (const p of plans) {
      console.log(`\n${p.slug} (${p.influencerId}), profile zone ${p.influencerTimezone}`);
      for (const { rule, action } of p.rules) {
        console.log(`  ${describeAction(rule, action)}`);
        if (action.kind === "convert") convert++;
        if (action.kind === "refuse") refuse++;
      }
    }
    console.log(`\n${plans.length} influencer(s) with rules in another zone; ${convert} rule(s) convertible, ${refuse} refused.`);
    if (!args.apply) {
      console.log(`Dry run only. To write the convertible rules:\n  npm run data:normalise-timezones -- --apply --confirm=${CONFIRM_VALUE}`);
      return 0;
    }

    let written = 0;
    let skipped = 0;
    for (const p of plans) {
      await prisma.$transaction(async (tx) => {
        for (const { rule, action } of p.rules) {
          if (action.kind !== "convert") continue;
          const r = await tx.availabilityRule.updateMany({
            where: { id: rule.id, weekday: rule.weekday, startTime: rule.startTime, endTime: rule.endTime, timezone: rule.timezone },
            data: { startTime: action.startTime, endTime: action.endTime, timezone: "Asia/Kolkata" },
          });
          if (r.count === 1) written++;
          else skipped++;
        }
        if (p.fullyIst && p.influencerTimezone !== "Asia/Kolkata") {
          const stillOther = await tx.availabilityRule.count({ where: { influencerId: p.influencerId, timezone: { not: "Asia/Kolkata" } } });
          if (stillOther === 0) await tx.influencer.update({ where: { id: p.influencerId }, data: { timezone: "Asia/Kolkata" } });
        }
      });
    }
    console.log(`Converted ${written} rule(s)${skipped ? `; ${skipped} changed while this ran and were left alone (run it again)` : ""}.`);
    return 0;
  } catch (e) {
    // Driver error messages can include host names or values: print only the class.
    console.error(`Failed: ${e instanceof Error ? e.name : "error"}`);
    return 1;
  } finally {
    await prisma.$disconnect();
  }
}

main().then(
  (code) => process.exit(code),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
