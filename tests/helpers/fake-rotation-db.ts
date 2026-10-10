import { encryptSecret } from "../../lib/crypto";
import type { EncryptedColumn, RotationDb, RotationTx } from "../../lib/key-rotation";

interface FakeRow {
  ownerId: string;
  value: string | null;
}

/** In-memory RotationDb with real transaction semantics (staged writes, committed on success, rolled back on throw). */
export class FakeDb implements RotationDb {
  tables = new Map<string, Map<string, FakeRow>>();
  /** Counts every database touch, so a test can assert that a refused command did not even connect. */
  transactions = 0;
  listings = 0;
  writes = 0;
  locks = 0;
  failWriteFor = new Set<string>();
  onBeforeRead?: (column: EncryptedColumn, id: string) => void;

  table(name: string) {
    let t = this.tables.get(name);
    if (!t) this.tables.set(name, (t = new Map()));
    return t;
  }
  set(col: EncryptedColumn, id: string, ownerId: string, value: string) {
    this.table(col.name).set(id, { ownerId, value });
  }
  get(col: EncryptedColumn, id: string) {
    return this.table(col.name).get(id)?.value ?? null;
  }
  async listIds(col: EncryptedColumn) {
    this.listings++;
    return [...this.table(col.name)].filter(([, r]) => r.value !== null).map(([id]) => id);
  }
  async transaction<T>(fn: (tx: RotationTx) => Promise<T>): Promise<T> {
    this.transactions++;
    const staged: [EncryptedColumn, string, string][] = [];
    const tx: RotationTx = {
      read: async (col, id, lock) => {
        if (lock) this.locks++;
        this.onBeforeRead?.(col, id);
        const row = this.table(col.name).get(id);
        return row && row.value ? { ownerId: row.ownerId, value: row.value } : null;
      },
      write: async (col, id, value) => {
        if (this.failWriteFor.has(id)) throw Object.assign(new Error("deadlock detected"), { code: "40P01" });
        staged.push([col, id, value]);
      },
    };
    const out = await fn(tx);
    for (const [col, id, value] of staged) {
      this.table(col.name).get(id)!.value = value;
      this.writes++;
    }
    return out;
  }
  /** True when nothing at all was read or written. */
  untouched() {
    return this.transactions === 0 && this.listings === 0 && this.writes === 0 && this.locks === 0;
  }
}

/** Two made-up columns: one whose AAD is built from the owner (`a:<id>`), one whose AAD is the owner id itself. */
export const COL_A: EncryptedColumn = { name: "a.secret_enc", table: "a", column: "secret_enc", ownerColumn: "influencer_id", aad: (id) => `a:${id}` };
export const COL_B: EncryptedColumn = { name: "b.token_enc", table: "b", column: "token_enc", ownerColumn: "id", aad: (id) => id };

export function seed(oldKey: Buffer): FakeDb {
  const db = new FakeDb();
  db.set(COL_A, "a1", "inf1", encryptSecret("A-ONE", "a:inf1", oldKey));
  db.set(COL_A, "a2", "inf2", encryptSecret("A-TWO", "a:inf2", oldKey));
  db.set(COL_B, "b1", "inf1", encryptSecret("B-ONE", "inf1", oldKey));
  return db;
}
