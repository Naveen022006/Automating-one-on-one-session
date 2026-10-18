import type { PrismaClient } from "@/generated/prisma/client";
import { totpAad } from "@/lib/admin/totp-aad";
import { googleClientAad } from "@/lib/google-credentials";
import { googleTokenAad } from "@/lib/google-tokens";
import type { EncryptedColumn, RotationDb, RotationTx } from "@/lib/key-rotation";
import { payoutAad } from "@/lib/payout-account";
import { waWebAad } from "@/lib/whatsapp-web/auth-state";
import { whatsappLegacyPinAad, whatsappPinAad, whatsappTokenAad } from "@/lib/whatsapp-connection";

/**
 * Every database column that holds a TOKEN_ENCRYPTION_KEY ciphertext, with the AAD each is encrypted with. The
 * AAD functions are imported from the modules that write the values, so they cannot drift.
 *
 * ADDING A COLUMN. tests/key-rotation.test.ts discovers every `*_enc` / `*Enc` column in prisma/schema.prisma and FAILS
 * if one is missing here (and if an entry names a table or column that does not exist). Describe any table with:
 *   table / column   the SQL names (the Prisma @@map / @map)
 *   ownerColumn      the column the AAD is derived from: "influencer_id" for rows that hang off an influencer, or "id"
 *                    where the AAD is built from the row's own id
 *   idColumn         the primary key, only if it is not "id"
 *   aad              (ownerId) => the exact AAD string the writing module uses; export it from that module and import it here
 * The admin 2FA secret below is the example of a row that is its own owner (ownerColumn "id").
 */
export const ENCRYPTED_COLUMNS: EncryptedColumn[] = [
  { name: "google_tokens.refresh_token_enc", table: "google_tokens", column: "refresh_token_enc", ownerColumn: "influencer_id", aad: googleTokenAad },
  { name: "influencer_google_clients.client_secret_enc", table: "influencer_google_clients", column: "client_secret_enc", ownerColumn: "influencer_id", aad: googleClientAad },
  { name: "payout_accounts.account_number_enc", table: "payout_accounts", column: "account_number_enc", ownerColumn: "influencer_id", aad: (id) => payoutAad(id, "account") },
  { name: "payout_accounts.upi_id_enc", table: "payout_accounts", column: "upi_id_enc", ownerColumn: "influencer_id", aad: (id) => payoutAad(id, "upi") },
  { name: "whatsapp_connections.token_enc", table: "whatsapp_connections", column: "token_enc", ownerColumn: "influencer_id", aad: whatsappTokenAad },
  // Superseded by the next entry; any value still in it is read once and moved (getRegistrationPin), but until then it must rotate.
  { name: "whatsapp_connections.registration_pin_enc", table: "whatsapp_connections", column: "registration_pin_enc", ownerColumn: "influencer_id", aad: whatsappLegacyPinAad },
  // The login of an influencer's QR-linked WhatsApp device (credentials + Signal keys, one blob), see lib/whatsapp-web/auth-state.ts.
  { name: "whatsapp_web_sessions.auth_state_enc", table: "whatsapp_web_sessions", column: "auth_state_enc", ownerColumn: "influencer_id", aad: waWebAad },
  // The PIN belongs to the phone number: that is both its primary key and what its AAD is derived from.
  { name: "whatsapp_registration_pins.pin_enc", table: "whatsapp_registration_pins", column: "pin_enc", ownerColumn: "phone_number_id", idColumn: "phone_number_id", aad: whatsappPinAad },
  { name: "admin_users.totp_secret_enc", table: "admin_users", column: "totp_secret_enc", ownerColumn: "id", aad: totpAad },
];

const IDENT = /^[a-z][a-z_]*$/;

/** Table and column names are interpolated into SQL, so they must be plain identifiers (they come from the list above). */
function ident(name: string): string {
  if (!IDENT.test(name)) throw new Error(`Unsafe SQL identifier: ${name}`);
  return `"${name}"`;
}

const idOf = (col: EncryptedColumn) => ident(col.idColumn ?? "id");

/**
 * Prisma-backed database access for the rotation core. `ownerIds` restricts the run to rows whose owner column holds
 * one of those ids (a canary run, or a test that must not touch other people's data).
 *
 * Writes use raw SQL on purpose: Prisma would bump `updated_at`, and rotating a key is not an edit the owner (or the
 * admin console's "last updated") should see.
 */
export function prismaRotationDb(prisma: PrismaClient, opts: { ownerIds?: string[] } = {}): RotationDb {
  return {
    async listIds(col) {
      const t = ident(col.table);
      const c = ident(col.column);
      const id = idOf(col);
      const rows = opts.ownerIds
        ? await prisma.$queryRawUnsafe<{ id: string }[]>(
            `SELECT ${id} AS "id" FROM ${t} WHERE ${c} IS NOT NULL AND ${ident(col.ownerColumn)} = ANY($1::text[]) ORDER BY ${id}`,
            opts.ownerIds,
          )
        : await prisma.$queryRawUnsafe<{ id: string }[]>(`SELECT ${id} AS "id" FROM ${t} WHERE ${c} IS NOT NULL ORDER BY ${id}`);
      return rows.map((r) => r.id);
    },

    transaction(fn) {
      return prisma.$transaction(
        async (client) => {
          const tx: RotationTx = {
            async read(col, id, lock) {
              const rows = await client.$queryRawUnsafe<{ ownerId: string; value: string | null }[]>(
                `SELECT ${ident(col.ownerColumn)} AS "ownerId", ${ident(col.column)} AS "value" FROM ${ident(col.table)} WHERE ${idOf(col)} = $1${lock ? " FOR UPDATE" : ""}`,
                id,
              );
              const row = rows[0];
              return row && row.value ? { ownerId: row.ownerId, value: row.value } : null;
            },
            async write(col, id, value) {
              await client.$executeRawUnsafe(`UPDATE ${ident(col.table)} SET ${ident(col.column)} = $2 WHERE ${idOf(col)} = $1`, id, value);
            },
          };
          return fn(tx);
        },
        { timeout: 15_000, maxWait: 10_000 },
      );
    },
  };
}
