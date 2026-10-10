import type { PrismaClient } from "@/generated/prisma/client";
import { googleTokenAad } from "@/lib/google-tokens";
import type { EncryptedColumn, RotationDb, RotationTx } from "@/lib/key-rotation";
import { payoutAad } from "@/lib/payout-account";
import { whatsappTokenAad } from "@/lib/whatsapp-connection";

/**
 * Every database column that holds a TOKEN_ENCRYPTION_KEY ciphertext, with the AAD each is encrypted with. The
 * AAD functions are imported from the modules that write the values, so they cannot drift. A test
 * (tests/key-rotation.test.ts) fails if prisma/schema.prisma gains an `*_enc` column that is not listed here.
 */
export const ENCRYPTED_COLUMNS: EncryptedColumn[] = [
  { name: "google_tokens.refresh_token_enc", table: "google_tokens", column: "refresh_token_enc", aad: googleTokenAad },
  { name: "payout_accounts.account_number_enc", table: "payout_accounts", column: "account_number_enc", aad: (id) => payoutAad(id, "account") },
  { name: "payout_accounts.upi_id_enc", table: "payout_accounts", column: "upi_id_enc", aad: (id) => payoutAad(id, "upi") },
  { name: "whatsapp_connections.token_enc", table: "whatsapp_connections", column: "token_enc", aad: whatsappTokenAad },
];

const IDENT = /^[a-z][a-z_]*$/;

/** Table and column names are interpolated into SQL, so they must be plain identifiers (they come from the list above). */
function ident(name: string): string {
  if (!IDENT.test(name)) throw new Error(`Unsafe SQL identifier: ${name}`);
  return `"${name}"`;
}

/**
 * Prisma-backed database access for the rotation core. `influencerIds` restricts the run to those influencers'
 * rows (a canary run, or a test that must not touch other people's data).
 *
 * Writes use raw SQL on purpose: Prisma would bump `updated_at`, and rotating a key is not an edit the owner (or the
 * admin console's "last updated") should see.
 */
export function prismaRotationDb(prisma: PrismaClient, opts: { influencerIds?: string[] } = {}): RotationDb {
  return {
    async listIds(col) {
      const t = ident(col.table);
      const c = ident(col.column);
      const rows = opts.influencerIds
        ? await prisma.$queryRawUnsafe<{ id: string }[]>(
            `SELECT "id" FROM ${t} WHERE ${c} IS NOT NULL AND "influencer_id" = ANY($1::text[]) ORDER BY "id"`,
            opts.influencerIds,
          )
        : await prisma.$queryRawUnsafe<{ id: string }[]>(`SELECT "id" FROM ${t} WHERE ${c} IS NOT NULL ORDER BY "id"`);
      return rows.map((r) => r.id);
    },

    transaction(fn) {
      return prisma.$transaction(
        async (client) => {
          const tx: RotationTx = {
            async read(col, id, lock) {
              const rows = await client.$queryRawUnsafe<{ influencerId: string; value: string | null }[]>(
                `SELECT "influencer_id" AS "influencerId", ${ident(col.column)} AS "value" FROM ${ident(col.table)} WHERE "id" = $1${lock ? " FOR UPDATE" : ""}`,
                id,
              );
              const row = rows[0];
              return row && row.value ? { influencerId: row.influencerId, value: row.value } : null;
            },
            async write(col, id, value) {
              await client.$executeRawUnsafe(`UPDATE ${ident(col.table)} SET ${ident(col.column)} = $2 WHERE "id" = $1`, id, value);
            },
          };
          return fn(tx);
        },
        { timeout: 15_000, maxWait: 10_000 },
      );
    },
  };
}
