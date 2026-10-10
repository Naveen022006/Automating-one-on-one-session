import { encryptSecret, tryDecryptSecret } from "./crypto";

/**
 * Encryption key rotation, database-agnostic core. The CLI is scripts/rotate-encryption-key.ts; the Prisma-backed
 * database access is lib/key-rotation-db.ts. Everything here takes its database access as an argument, so it is
 * tested with fakes and never touches real data.
 *
 * Guarantees, per row:
 *   - the row is locked (apply mode) and re-read inside its own transaction, so a concurrent write by the app is
 *     never overwritten with stale ciphertext;
 *   - the new ciphertext is decrypted again with the new key and compared with the plaintext BEFORE it is written,
 *     so a bad key or a bug can only ever fail a row, never corrupt it;
 *   - a row that already decrypts with the new key is skipped, which makes a run resumable and idempotent;
 *   - a row that decrypts with neither key is left untouched and counted as failed.
 * Nothing here returns or logs plaintext or key material.
 */

export interface EncryptedColumn {
  /** `table.column`, as shown in the report. */
  name: string;
  table: string;
  column: string;
  /** The AAD this column's values are encrypted with, derived from the owning influencer's id. */
  aad: (influencerId: string) => string;
}

export type RowOutcome = { outcome: "skipped" } | { outcome: "rotated"; next: string } | { outcome: "failed"; reason: string };

/** Pure per-value logic: what should happen to one stored ciphertext. */
export function rotateValue(payload: string, aad: string, oldKey: Buffer, newKey: Buffer): RowOutcome {
  if (tryDecryptSecret(payload, aad, newKey) !== null) return { outcome: "skipped" };
  const plaintext = tryDecryptSecret(payload, aad, oldKey);
  if (plaintext === null) return { outcome: "failed", reason: "cannot be decrypted with the old or the new key" };
  const next = encryptSecret(plaintext, aad, newKey);
  if (tryDecryptSecret(next, aad, newKey) !== plaintext) return { outcome: "failed", reason: "re-encrypted value did not verify" };
  return { outcome: "rotated", next };
}

export interface RotationTx {
  /** Reads one row's value (and owner). With `lock`, holds a row lock until the transaction ends. Null if the row is gone. */
  read(column: EncryptedColumn, id: string, lock: boolean): Promise<{ influencerId: string; value: string } | null>;
  write(column: EncryptedColumn, id: string, value: string): Promise<void>;
}

export interface RotationDb {
  /** Ids of every row whose column is not null. */
  listIds(column: EncryptedColumn): Promise<string[]>;
  /** Runs `fn` in its own transaction (committed if it returns, rolled back if it throws). */
  transaction<T>(fn: (tx: RotationTx) => Promise<T>): Promise<T>;
}

export interface RotationCounts {
  scanned: number;
  /** Rotated (apply) or that would be rotated (dry run). */
  rotated: number;
  /** Already decryptable with the new key, or deleted since the scan. */
  skipped: number;
  failed: number;
}

export interface RotationFailure {
  column: string;
  rowId: string;
  reason: string;
}

export interface RotationReport {
  apply: boolean;
  columns: Record<string, RotationCounts>;
  totals: RotationCounts;
  failures: RotationFailure[];
}

const empty = (): RotationCounts => ({ scanned: 0, rotated: 0, skipped: 0, failed: 0 });

export async function rotateEncryptedColumns(opts: {
  db: RotationDb;
  columns: EncryptedColumn[];
  oldKey: Buffer;
  newKey: Buffer;
  /** false (the default) = dry run: reads and verifies everything, writes nothing, takes no row locks. */
  apply?: boolean;
}): Promise<RotationReport> {
  const apply = opts.apply === true;
  if (opts.oldKey.length !== 32 || opts.newKey.length !== 32) throw new Error("Both keys must be 32 bytes");
  if (opts.oldKey.equals(opts.newKey)) throw new Error("The old and new keys are identical; nothing to rotate");

  const report: RotationReport = { apply, columns: {}, totals: empty(), failures: [] };

  for (const column of opts.columns) {
    const counts = (report.columns[column.name] = empty());
    const ids = await opts.db.listIds(column);
    for (const id of ids) {
      counts.scanned++;
      try {
        const outcome = await opts.db.transaction(async (tx): Promise<RowOutcome | "gone"> => {
          const row = await tx.read(column, id, apply);
          if (!row) return "gone";
          const result = rotateValue(row.value, column.aad(row.influencerId), opts.oldKey, opts.newKey);
          if (result.outcome === "rotated" && apply) await tx.write(column, id, result.next);
          return result;
        });
        if (outcome === "gone" || outcome.outcome === "skipped") counts.skipped++;
        else if (outcome.outcome === "rotated") counts.rotated++;
        else {
          counts.failed++;
          report.failures.push({ column: column.name, rowId: id, reason: outcome.reason });
        }
      } catch (e) {
        // A database error on this row (timeout, deadlock, connection loss): count it and carry on with the rest.
        counts.failed++;
        report.failures.push({ column: column.name, rowId: id, reason: `database error (${errorCode(e)})` });
      }
    }
    for (const k of Object.keys(counts) as (keyof RotationCounts)[]) report.totals[k] += counts[k];
  }
  return report;
}

function errorCode(e: unknown): string {
  const code = (e as { code?: unknown } | null)?.code;
  if (typeof code === "string" && /^[A-Za-z0-9_.-]{1,40}$/.test(code)) return code;
  return e instanceof Error && /^[A-Za-z0-9_.-]{1,60}$/.test(e.name) ? e.name : "error";
}
