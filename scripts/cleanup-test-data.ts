import "dotenv/config";
import { applyProblems, CONFIRM_VALUE, formatCounts, formatPlan, parseCleanupArgs } from "../lib/test-data-cleanup";

/**
 * Removes dummy rows that tests and QA runs left in a development database (test administrators and influencers with
 * everything that belongs to them). Which rows count as test data, and what is always kept, is documented at the top of
 * lib/test-data-cleanup.ts.
 *
 *   npm run data:cleanup-test                                          DRY RUN (default): prints what would be deleted, deletes nothing
 *   npm run data:cleanup-test -- --apply --confirm=DELETE-TEST-DATA    delete, inside one transaction
 *
 * --apply is refused unless NODE_ENV is not production, APP_URL is a local address and the typed confirmation is given.
 * Never touched: the demo influencer, the administrators admin@/admin1@/admin2@example.com, admin_audit_logs, queues and
 * Redis, and every row that is not positively identified as test data. Exit code: 0 ok, 1 failure, 2 bad usage or refused.
 */

const USAGE = `Usage: npm run data:cleanup-test [-- --apply --confirm=${CONFIRM_VALUE}]\n  (no flags = dry run; nothing is deleted)`;

async function main(): Promise<number> {
  const args = parseCleanupArgs(process.argv.slice(2));
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
  if (args.apply) {
    const problems = applyProblems(process.env, args.confirm);
    if (problems.length > 0) {
      console.error(`Refusing to delete:\n${problems.map((p) => `  - ${p}`).join("\n")}\nNothing was changed.`);
      return 2;
    }
  }
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL is not set.");
    return 2;
  }

  // Imported after the checks, so a usage error never opens a database connection.
  const { prisma } = await import("../lib/db");
  const { applyCleanup, planCleanup } = await import("../lib/test-data-cleanup");
  try {
    console.log(args.apply ? "MODE: APPLY (deleting inside one transaction)" : "MODE: DRY RUN (nothing is deleted)");
    console.log("");
    if (!args.apply) {
      const plan = await planCleanup(prisma);
      for (const line of formatPlan(plan)) console.log(line);
      console.log("");
      console.log("Dry run only. Review the lists above, then to delete exactly this:");
      console.log(`  npm run data:cleanup-test -- --apply --confirm=${CONFIRM_VALUE}`);
      return 0;
    }
    const { plan, deleted } = await applyCleanup(prisma, { env: process.env, confirm: args.confirm });
    console.log(`Deleted influencers: ${plan.influencers.map((i) => i.slug).join(", ") || "(none)"}`);
    console.log(`Deleted administrators: ${plan.admins.map((a) => a.email).join(", ") || "(none)"}`);
    console.log("");
    for (const line of formatCounts("Rows deleted (per table):", deleted)) console.log(line);
    console.log("");
    console.log("Done. To confirm nothing test-like remains (the 'would be deleted' counts should all be 0), run the dry run again:");
    console.log("  npm run data:cleanup-test");
    return 0;
  } finally {
    await prisma.$disconnect();
  }
}

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    // Driver error messages can include host names or values; print only the class and, for our own errors, the message.
    const own = e instanceof Error && /^(Rolled back|Refusing)/.test(e.message);
    console.error(`Test-data cleanup aborted: ${own ? (e as Error).message : e instanceof Error ? e.name : "error"}`);
    process.exit(1);
  });
