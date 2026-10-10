import "dotenv/config";
import { runVerifyCli, UsageError } from "../lib/key-rotation-cli";

/**
 * Decrypt-only check: how many stored encrypted values can be read with the CURRENT key (TOKEN_ENCRYPTION_KEY)?
 * Writes nothing. Exits non-zero unless every value decrypts with the current key.
 *
 *   npm run keys:verify                    after a rotation: every value must be on the current key
 *   npm run keys:verify -- --allow-previous   restore drill: values on TOKEN_ENCRYPTION_KEY_PREVIOUS are acceptable too
 *   npm run keys:verify -- --only-owner <id> [...]
 *
 * Run it with the same environment as your services. It prints a fingerprint of each key (never the key).
 * Exit code: 0 ok, 1 something is unreadable or not yet rotated, 2 bad usage or configuration. Logic: lib/key-rotation-cli.ts.
 */

runVerifyCli({
  argv: process.argv.slice(2),
  env: process.env,
  out: (line) => console.log(line),
  err: (line) => console.error(line),
  async connect({ ownerIds }) {
    if (!process.env.DATABASE_URL) throw new UsageError("DATABASE_URL is not set");
    const { prisma } = await import("../lib/db");
    const { ENCRYPTED_COLUMNS, prismaRotationDb } = await import("../lib/key-rotation-db");
    return { db: prismaRotationDb(prisma, { ownerIds }), columns: ENCRYPTED_COLUMNS, close: () => prisma.$disconnect() };
  },
})
  .then((code) => process.exit(code))
  .catch((e) => {
    console.error(`Key verification aborted: ${e instanceof Error ? e.name : "error"}`);
    process.exit(1);
  });
