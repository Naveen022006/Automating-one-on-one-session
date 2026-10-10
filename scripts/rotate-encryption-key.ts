import "dotenv/config";
import { parseKeyBytes } from "../lib/crypto";
import { rotateEncryptedColumns, type RotationReport } from "../lib/key-rotation";

/**
 * Re-encrypts every value protected by TOKEN_ENCRYPTION_KEY (Google refresh tokens, payout account numbers and UPI
 * ids, WhatsApp access tokens) from the OLD key to a NEW key. Procedure and rollback: doc/08-deployment.md.
 *
 *   npm run keys:rotate                         dry run (default): reads and verifies everything, writes nothing
 *   npm run keys:rotate -- --apply              rotate for real
 *   npm run keys:rotate -- --apply --only-influencer <id> [--only-influencer <id> ...]   canary run
 *
 * Keys come from the environment, never from arguments (they would end up in shell history):
 *   TOKEN_ENCRYPTION_KEY       the OLD key, the one the rows are encrypted with today
 *   TOKEN_ENCRYPTION_KEY_NEW   the NEW key (openssl rand -base64 32)
 *
 * Safe to stop and re-run: rows already readable with the new key are skipped. Each row is rotated in its own
 * transaction and verified before it is written. Output is counts and row ids only, never plaintext or keys.
 * Exit code: 0 all good, 1 at least one row failed, 2 bad usage or configuration.
 */

function usage(message: string): never {
  console.error(`${message}\nUsage: npm run keys:rotate -- [--dry-run | --apply] [--only-influencer <id>]...`);
  process.exit(2);
}

function parseArgs(argv: string[]) {
  let apply = false;
  let dry = false;
  const only: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--apply") apply = true;
    else if (a === "--dry-run") dry = true;
    else if (a === "--only-influencer") {
      const id = argv[++i];
      if (!id || id.startsWith("--")) usage("--only-influencer needs an influencer id");
      only.push(id);
    } else usage(`Unknown argument: ${a}`);
  }
  if (apply && dry) usage("Choose either --dry-run or --apply, not both");
  return { apply, only: only.length ? only : undefined };
}

function print(report: RotationReport) {
  const verb = report.apply ? "rotated" : "would rotate";
  console.log(report.apply ? "Mode: APPLY (rows are being re-encrypted)" : "Mode: DRY RUN (nothing is written; use --apply to rotate)");
  const width = Math.max(...Object.keys(report.columns).map((n) => n.length), 10);
  const line = (name: string, c: RotationReport["totals"]) =>
    `  ${name.padEnd(width)}  scanned ${String(c.scanned).padStart(4)}  ${verb} ${String(c.rotated).padStart(4)}  already on new key ${String(c.skipped).padStart(4)}  failed ${String(c.failed).padStart(4)}`;
  for (const [name, counts] of Object.entries(report.columns)) console.log(line(name, counts));
  console.log(line("TOTAL", report.totals));
  for (const f of report.failures) console.error(`  FAILED ${f.column} row ${f.rowId}: ${f.reason}`);
}

async function main() {
  const { apply, only } = parseArgs(process.argv.slice(2));

  const oldKey = parseKeyBytes(process.env.TOKEN_ENCRYPTION_KEY);
  const newKey = parseKeyBytes(process.env.TOKEN_ENCRYPTION_KEY_NEW);
  if (!oldKey) usage("TOKEN_ENCRYPTION_KEY (the OLD key) must be set and be 32 bytes, base64 encoded");
  if (!newKey) usage("TOKEN_ENCRYPTION_KEY_NEW (the NEW key) must be set and be 32 bytes, base64 encoded (openssl rand -base64 32)");
  if (oldKey.equals(newKey)) usage("TOKEN_ENCRYPTION_KEY and TOKEN_ENCRYPTION_KEY_NEW are the same key");
  if (!process.env.DATABASE_URL) usage("DATABASE_URL is not set");

  // Imported here, after the checks, so a usage error never opens a database connection.
  const { prisma } = await import("../lib/db");
  const { ENCRYPTED_COLUMNS, prismaRotationDb } = await import("../lib/key-rotation-db");
  try {
    if (only) console.log(`Restricted to ${only.length} influencer id(s).`);
    const report = await rotateEncryptedColumns({
      db: prismaRotationDb(prisma, { influencerIds: only }),
      columns: ENCRYPTED_COLUMNS,
      oldKey,
      newKey,
      apply,
    });
    print(report);
    if (report.totals.failed > 0) {
      console.error(`${report.totals.failed} row(s) failed and were left unchanged. Fix the cause and run again; finished rows are skipped.`);
      process.exitCode = 1;
    } else if (apply) {
      console.log("Done. Every row is on the new key. Next: see 'Finish' in doc/08-deployment.md (key rotation).");
    } else {
      console.log("Dry run complete: every row can be rotated. Re-run with --apply.");
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  // Error messages from the database driver can include host names; print only the class and code.
  const code = (e as { code?: string } | null)?.code;
  console.error(`Key rotation aborted: ${e instanceof Error ? e.name : "error"}${code ? ` (${code})` : ""}`);
  process.exit(1);
});
