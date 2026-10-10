import { encryptSecret, tryDecryptSecret } from "./crypto";

/**
 * Encryption key rotation and verification, database-agnostic core. The commands are scripts/rotate-encryption-key.ts
 * (npm run keys:rotate) and scripts/verify-encryption-keys.ts (npm run keys:verify), driven by lib/key-rotation-cli.ts;
 * the Prisma-backed database access is lib/key-rotation-db.ts. Everything here takes its database access as an argument,
 * so it is tested with fakes and never touches real data.
 *
 * What the tools are given: the app's OWN variables, exactly as the running services have them during a rotation:
 * TOKEN_ENCRYPTION_KEY is the key rows must end up on (the NEW key) and TOKEN_ENCRYPTION_KEY_PREVIOUS is the key they
 * are on today (the OLD key).
 *
 * Guarantees, per row (rotate):
 *   - the row is locked (apply mode) and re-read inside its own transaction, so a concurrent write by the app is
 *     never overwritten with stale ciphertext;
 *   - the new ciphertext is decrypted again and compared with the plaintext BEFORE it is written. This catches a bug
 *     in encryption or a truncated value. It can NOT tell whether the new key is the key your services use: encrypting
 *     and decrypting with the same wrong key round-trips perfectly. That is the operator's check, which is why every
 *     run prints key fingerprints and `--apply` requires `--confirm-new-fingerprint` (lib/key-rotation-cli.ts);
 *   - a row that already decrypts with the new key is skipped, which makes a run resumable and idempotent;
 *   - a row that decrypts with neither key is left untouched and counted as failed.
 * Nothing here returns or logs plaintext or key material.
 */

export interface EncryptedColumn {
  /** `table.column`, as shown in the report. */
  name: string;
  /** SQL table name (the Prisma `@@map`). */
  table: string;
  /** SQL column name holding the ciphertext (the Prisma `@map`). */
  column: string;
  /**
   * SQL column holding the id the AAD is derived from, i.e. the owner of the value: `influencer_id` for tables that
   * hang off an influencer, or the table's own `id` where the AAD is built from the row's own id (admin 2FA secret).
   */
  ownerColumn: string;
  /** SQL primary-key column. Default `id`. */
  idColumn?: string;
  /** The AAD this column's values are encrypted with, derived from the owner id. */
  aad: (ownerId: string) => string;
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
  /** Reads one row's value (and owner id). With `lock`, holds a row lock until the transaction ends. Null if the row is gone. */
  read(column: EncryptedColumn, id: string, lock: boolean): Promise<{ ownerId: string; value: string } | null>;
  write(column: EncryptedColumn, id: string, value: string): Promise<void>;
}

export interface RotationDb {
  /** Primary keys of every row whose column is not null. */
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
          const result = rotateValue(row.value, column.aad(row.ownerId), opts.oldKey, opts.newKey);
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

/* ---------- verification: decrypt only ---------- */

export interface VerifyCounts {
  scanned: number;
  /** Decrypt with the current key (TOKEN_ENCRYPTION_KEY): what the app needs. */
  current: number;
  /** Decrypt only with the previous key: not yet rotated. */
  previousOnly: number;
  /** Decrypt with neither key (or the row could not be read). */
  unreadable: number;
}

export interface VerifyReport {
  columns: Record<string, VerifyCounts>;
  totals: VerifyCounts;
  failures: RotationFailure[];
}

const emptyVerify = (): VerifyCounts => ({ scanned: 0, current: 0, previousOnly: 0, unreadable: 0 });

/**
 * Reads every encrypted value and reports which key it decrypts with. Strictly decrypt-only: no writes, no row locks,
 * nothing logged but counts and row ids.
 */
export async function verifyEncryptedColumns(opts: {
  db: RotationDb;
  columns: EncryptedColumn[];
  currentKey: Buffer;
  previousKey?: Buffer;
}): Promise<VerifyReport> {
  const report: VerifyReport = { columns: {}, totals: emptyVerify(), failures: [] };
  for (const column of opts.columns) {
    const counts = (report.columns[column.name] = emptyVerify());
    for (const id of await opts.db.listIds(column)) {
      counts.scanned++;
      try {
        const row = await opts.db.transaction((tx) => tx.read(column, id, false));
        if (!row) {
          counts.scanned--; // deleted since the scan
          continue;
        }
        const aad = column.aad(row.ownerId);
        if (tryDecryptSecret(row.value, aad, opts.currentKey) !== null) counts.current++;
        else if (opts.previousKey && tryDecryptSecret(row.value, aad, opts.previousKey) !== null) counts.previousOnly++;
        else {
          counts.unreadable++;
          report.failures.push({ column: column.name, rowId: id, reason: "cannot be decrypted with the current or the previous key" });
        }
      } catch (e) {
        counts.unreadable++;
        report.failures.push({ column: column.name, rowId: id, reason: `database error (${errorCode(e)})` });
      }
    }
    for (const k of Object.keys(counts) as (keyof VerifyCounts)[]) report.totals[k] += counts[k];
  }
  return report;
}

function errorCode(e: unknown): string {
  const code = (e as { code?: unknown } | null)?.code;
  if (typeof code === "string" && /^[A-Za-z0-9_.-]{1,40}$/.test(code)) return code;
  return e instanceof Error && /^[A-Za-z0-9_.-]{1,60}$/.test(e.name) ? e.name : "error";
}

/* ---------- schema coverage ---------- */

interface SchemaField {
  table: string;
  /** SQL column name (the `@map`, or the field name when there is none). */
  column: string;
  fieldName: string;
}

function schemaFields(schema: string): SchemaField[] {
  const out: SchemaField[] = [];
  let model: string | null = null;
  let fields: { name: string; column: string }[] = [];
  let table: string | null = null;
  for (const raw of schema.split(/\r?\n/)) {
    const line = raw.trim();
    const open = line.match(/^model\s+(\w+)\s*\{/);
    if (open) {
      model = open[1];
      fields = [];
      table = null;
      continue;
    }
    if (!model) continue;
    if (line === "}") {
      for (const f of fields) out.push({ table: table ?? model, column: f.column, fieldName: f.name });
      model = null;
      continue;
    }
    const tableMap = line.match(/^@@map\("([^"]+)"\)/);
    if (tableMap) table = tableMap[1];
    if (!line || line.startsWith("//") || line.startsWith("@@")) continue;
    const field = line.match(/^(\w+)\s+[\w.]+(?:\[\]|\?)?\s*(.*)$/);
    if (!field) continue;
    const map = field[2].match(/@map\("([^"]+)"\)/)?.[1];
    fields.push({ name: field[1], column: map ?? field[1] });
  }
  return out;
}

/** Every `*_enc` / `*Enc` column declared in a Prisma schema, as `table.column`. */
export function discoverEncryptedColumns(schema: string): string[] {
  const found = schemaFields(schema)
    .filter((f) => /(_enc|Enc)$/.test(f.column) || /(_enc|Enc)$/.test(f.fieldName))
    .map((f) => `${f.table}.${f.column}`);
  return [...new Set(found)].sort();
}

export interface CoverageProblems {
  /** In the schema but not in the rotation list: its values would be stranded on the old key. */
  missing: string[];
  /** In the rotation list but not in the schema. */
  unknown: string[];
  /** Listed columns whose owner or id column does not exist in that table. */
  badColumns: string[];
}

/** Compares the schema with the rotation list. All three arrays must be empty. */
export function checkColumnCoverage(schema: string, columns: EncryptedColumn[]): CoverageProblems {
  const discovered = discoverEncryptedColumns(schema);
  const listed = columns.map((c) => c.name);
  const byTable = new Map<string, Set<string>>();
  for (const f of schemaFields(schema)) {
    if (!byTable.has(f.table)) byTable.set(f.table, new Set());
    byTable.get(f.table)!.add(f.column);
  }
  const badColumns: string[] = [];
  for (const c of columns) {
    const have = byTable.get(c.table);
    for (const [label, col] of [["column", c.column], ["ownerColumn", c.ownerColumn], ["idColumn", c.idColumn ?? "id"]] as const) {
      if (!have?.has(col)) badColumns.push(`${c.name}: ${label} "${col}" is not a column of ${c.table}`);
    }
  }
  return {
    missing: discovered.filter((d) => !listed.includes(d)),
    unknown: listed.filter((l) => !discovered.includes(l)),
    badColumns,
  };
}
