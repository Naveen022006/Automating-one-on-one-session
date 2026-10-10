import "dotenv/config";
import { runRotateCli, UsageError } from "../lib/key-rotation-cli";

/**
 * Re-encrypts every value protected by TOKEN_ENCRYPTION_KEY (Google refresh tokens, payout account numbers and UPI
 * ids, WhatsApp access tokens, ...) from the OLD key to the NEW key. Procedure and rollback: doc/08-deployment.md.
 *
 *   npm run keys:rotate                                   dry run (default): reads and verifies, writes nothing
 *   npm run keys:rotate -- --apply --confirm-new-fingerprint=<8 hex>     rotate for real
 *   npm run keys:rotate -- --only-owner <id> [...]        restrict to some owners (canary)
 *
 * Run it with the SAME environment as your services during the rotation, because it reads the app's own variables:
 *   TOKEN_ENCRYPTION_KEY            the new key (what the services now write with)
 *   TOKEN_ENCRYPTION_KEY_PREVIOUS   the old key (what the rows are on today)
 * It prints a fingerprint of each key (never the key). --apply is refused unless --confirm-new-fingerprint equals the
 * new key's fingerprint, which you take from the start-up log of the running services. All logic: lib/key-rotation-cli.ts.
 * Exit code: 0 ok, 1 a row failed, 2 bad usage or configuration.
 */

runRotateCli({
  argv: process.argv.slice(2),
  env: process.env,
  out: (line) => console.log(line),
  err: (line) => console.error(line),
  async connect({ ownerIds }) {
    if (!process.env.DATABASE_URL) throw new UsageError("DATABASE_URL is not set");
    // Imported here, after the checks, so a usage error never opens a database connection.
    const { prisma } = await import("../lib/db");
    const { ENCRYPTED_COLUMNS, prismaRotationDb } = await import("../lib/key-rotation-db");
    return { db: prismaRotationDb(prisma, { ownerIds }), columns: ENCRYPTED_COLUMNS, close: () => prisma.$disconnect() };
  },
})
  .then((code) => process.exit(code))
  .catch((e) => {
    // Driver error messages can include host names; print only the class.
    console.error(`Key rotation aborted: ${e instanceof Error ? e.name : "error"}`);
    process.exit(1);
  });
