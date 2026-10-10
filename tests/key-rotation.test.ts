import "dotenv/config";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { decryptSecret, encryptSecret, parseKeyBytes, tryDecryptSecret } from "../lib/crypto";
import { prisma } from "../lib/db";
import { getRefreshToken, googleTokenAad, saveGoogleToken } from "../lib/google-tokens";
import { checkColumnCoverage, discoverEncryptedColumns, rotateEncryptedColumns, rotateValue, verifyEncryptedColumns } from "../lib/key-rotation";
import { ENCRYPTED_COLUMNS, prismaRotationDb } from "../lib/key-rotation-db";
import type { EncryptedColumn } from "../lib/key-rotation";
import { payoutAad, payoutInputSchema, revealPayoutAccount, savePayoutAccount } from "../lib/payout-account";
import { resolveSendCredentials, whatsappTokenAad } from "../lib/whatsapp-connection";
import { COL_A, COL_B, FakeDb, seed } from "./helpers/fake-rotation-db";

/** An empty environment for resolveSendCredentials (no MESSAGING_DRY_RUN, no platform fallback). */
const NO_ENV = {} as NodeJS.ProcessEnv;
const newKeyB64 = () => randomBytes(32).toString("base64");

/** Runs `fn` with the given encryption-key env vars, restoring the originals afterwards. */
async function withKeys<T>(keys: { current?: string; previous?: string }, fn: () => T | Promise<T>): Promise<T> {
  const saved = { c: process.env.TOKEN_ENCRYPTION_KEY, p: process.env.TOKEN_ENCRYPTION_KEY_PREVIOUS };
  const set = (name: string, v: string | undefined) => (v === undefined ? delete process.env[name] : (process.env[name] = v));
  set("TOKEN_ENCRYPTION_KEY", keys.current);
  set("TOKEN_ENCRYPTION_KEY_PREVIOUS", keys.previous);
  try {
    return await fn();
  } finally {
    set("TOKEN_ENCRYPTION_KEY", saved.c);
    set("TOKEN_ENCRYPTION_KEY_PREVIOUS", saved.p);
  }
}

/* ---------- crypto: current key, then the previous key ---------- */

test("parseKeyBytes accepts exactly 32 bytes of base64", () => {
  assert.equal(parseKeyBytes(newKeyB64())?.length, 32);
  assert.equal(parseKeyBytes(randomBytes(16).toString("base64")), null);
  assert.equal(parseKeyBytes(randomBytes(33).toString("base64")), null);
  assert.equal(parseKeyBytes(""), null);
  assert.equal(parseKeyBytes(undefined), null);
  assert.equal(parseKeyBytes(`${newKeyB64()}\n`)?.length, 32, "same lenient decoding the app has always used (a trailing newline is skipped)");
});

test("encryption always uses the current key, never the previous one", async () => {
  const oldKey = newKeyB64();
  const newKey = newKeyB64();
  await withKeys({ current: newKey, previous: oldKey }, () => {
    const payload = encryptSecret("secret-value", "row-1");
    assert.equal(tryDecryptSecret(payload, "row-1", parseKeyBytes(newKey)!), "secret-value");
    assert.equal(tryDecryptSecret(payload, "row-1", parseKeyBytes(oldKey)!), null, "must not be readable with the previous key");
  });
});

test("decryption tries the current key, then the previous key", async () => {
  const oldKey = newKeyB64();
  const newKey = newKeyB64();
  const oldPayload = await withKeys({ current: oldKey }, () => encryptSecret("written-with-old", "row-1"));
  const newPayload = await withKeys({ current: newKey }, () => encryptSecret("written-with-new", "row-1"));

  // Mid-rotation: current = new, previous = old. Both generations of rows are readable.
  await withKeys({ current: newKey, previous: oldKey }, () => {
    assert.equal(decryptSecret(newPayload, "row-1"), "written-with-new");
    assert.equal(decryptSecret(oldPayload, "row-1"), "written-with-old");
  });
  // Before the previous key is configured the old rows are unreadable, which is what the fallback is for.
  await withKeys({ current: newKey }, () => assert.throws(() => decryptSecret(oldPayload, "row-1")));
  // An instance that has not been updated yet (current = old, no previous) still reads old rows.
  await withKeys({ current: oldKey }, () => assert.equal(decryptSecret(oldPayload, "row-1"), "written-with-old"));
});

test("the fallback never weakens the AAD binding or accepts garbage", async () => {
  const oldKey = newKeyB64();
  const newKey = newKeyB64();
  const stranger = newKeyB64();
  const oldPayload = await withKeys({ current: oldKey }, () => encryptSecret("value", "row-1"));
  await withKeys({ current: newKey, previous: oldKey }, () => {
    assert.throws(() => decryptSecret(oldPayload, "row-2"), "a ciphertext moved to another row must still fail");
    assert.throws(() => decryptSecret("not-a-payload", "row-1"), /Unrecognised encrypted payload format/);
    assert.throws(() => decryptSecret("v2.a.b.c", "row-1"), /Unrecognised/);
  });
  // A key that is neither current nor previous reads nothing.
  await withKeys({ current: stranger, previous: newKey }, () => assert.throws(() => decryptSecret(oldPayload, "row-1")));
  // An explicit key is used on its own, with no fallback.
  await withKeys({ current: newKey, previous: oldKey }, () => assert.throws(() => decryptSecret(oldPayload, "row-1", parseKeyBytes(newKey)!)));
});

test("a malformed previous key is reported only when it is needed", async () => {
  const oldKey = newKeyB64();
  const newKey = newKeyB64();
  const newPayload = await withKeys({ current: newKey }, () => encryptSecret("value", "row-1"));
  const oldPayload = await withKeys({ current: oldKey }, () => encryptSecret("value", "row-1"));
  await withKeys({ current: newKey, previous: "garbage" }, () => {
    assert.equal(decryptSecret(newPayload, "row-1"), "value", "current-key rows keep working");
    assert.throws(() => decryptSecret(oldPayload, "row-1"), /TOKEN_ENCRYPTION_KEY_PREVIOUS must be 32 bytes/);
  });
});

/* ---------- rotation: the pure per-value logic ---------- */

test("rotateValue re-encrypts, skips what is already on the new key, and fails what neither key can read", () => {
  const oldKey = randomBytes(32);
  const newKey = randomBytes(32);
  const other = randomBytes(32);
  const old = encryptSecret("plaintext-123", "aad-1", oldKey);

  const r = rotateValue(old, "aad-1", oldKey, newKey);
  assert.equal(r.outcome, "rotated");
  if (r.outcome !== "rotated") return;
  assert.equal(decryptSecret(r.next, "aad-1", newKey), "plaintext-123");
  assert.equal(tryDecryptSecret(r.next, "aad-1", oldKey), null, "the new ciphertext is not readable with the old key");
  assert.notEqual(r.next, old);

  assert.deepEqual(rotateValue(r.next, "aad-1", oldKey, newKey), { outcome: "skipped" }, "idempotent: running again changes nothing");

  const unreadable = rotateValue(encryptSecret("x", "aad-1", other), "aad-1", oldKey, newKey);
  assert.equal(unreadable.outcome, "failed");
  assert.equal(rotateValue(old, "wrong-aad", oldKey, newKey).outcome, "failed", "the AAD must match");
  assert.equal(rotateValue("garbage", "aad-1", oldKey, newKey).outcome, "failed");
  for (const f of [unreadable, rotateValue("garbage", "aad-1", oldKey, newKey)]) {
    if (f.outcome === "failed") assert.ok(!f.reason.includes("plaintext") && !f.reason.includes(oldKey.toString("base64")), "reasons carry no secrets");
  }
});

/* ---------- rotation: the runner, against an in-memory fake database ---------- */

test("dry run reads and verifies everything but writes nothing and takes no locks", async () => {
  const oldKey = randomBytes(32);
  const newKey = randomBytes(32);
  const db = seed(oldKey);
  const before = [db.get(COL_A, "a1"), db.get(COL_A, "a2"), db.get(COL_B, "b1")];
  const report = await rotateEncryptedColumns({ db, columns: [COL_A, COL_B], oldKey, newKey });
  assert.equal(report.apply, false);
  assert.deepEqual(report.totals, { scanned: 3, rotated: 3, skipped: 0, failed: 0 });
  assert.deepEqual(report.columns["a.secret_enc"], { scanned: 2, rotated: 2, skipped: 0, failed: 0 });
  assert.equal(db.writes, 0);
  assert.equal(db.locks, 0);
  assert.deepEqual([db.get(COL_A, "a1"), db.get(COL_A, "a2"), db.get(COL_B, "b1")], before);
});

test("apply rotates every row in its own locked transaction, with the right AAD per column", async () => {
  const oldKey = randomBytes(32);
  const newKey = randomBytes(32);
  const db = seed(oldKey);
  const report = await rotateEncryptedColumns({ db, columns: [COL_A, COL_B], oldKey, newKey, apply: true });
  assert.deepEqual(report.totals, { scanned: 3, rotated: 3, skipped: 0, failed: 0 });
  assert.equal(db.transactions, 3, "one transaction per row");
  assert.equal(db.locks, 3);
  assert.equal(db.writes, 3);
  assert.equal(decryptSecret(db.get(COL_A, "a1")!, "a:inf1", newKey), "A-ONE");
  assert.equal(decryptSecret(db.get(COL_A, "a2")!, "a:inf2", newKey), "A-TWO");
  assert.equal(decryptSecret(db.get(COL_B, "b1")!, "inf1", newKey), "B-ONE");
  assert.equal(tryDecryptSecret(db.get(COL_A, "a1")!, "a:inf1", oldKey), null);
});

test("a second run is a no-op (idempotent), and an interrupted run resumes where it stopped", async () => {
  const oldKey = randomBytes(32);
  const newKey = randomBytes(32);
  const db = seed(oldKey);
  // Simulate an interrupted run: only a1 got rotated.
  db.set(COL_A, "a1", "inf1", rotateValueNext(db.get(COL_A, "a1")!, "a:inf1", oldKey, newKey));

  const resumed = await rotateEncryptedColumns({ db, columns: [COL_A, COL_B], oldKey, newKey, apply: true });
  assert.deepEqual(resumed.totals, { scanned: 3, rotated: 2, skipped: 1, failed: 0 });

  const again = await rotateEncryptedColumns({ db, columns: [COL_A, COL_B], oldKey, newKey, apply: true });
  assert.deepEqual(again.totals, { scanned: 3, rotated: 0, skipped: 3, failed: 0 });
});

function rotateValueNext(payload: string, aad: string, oldKey: Buffer, newKey: Buffer): string {
  const r = rotateValue(payload, aad, oldKey, newKey);
  assert.equal(r.outcome, "rotated");
  return r.outcome === "rotated" ? r.next : "";
}

test("a row that cannot be read is left untouched and counted; the rest still rotate", async () => {
  const oldKey = randomBytes(32);
  const newKey = randomBytes(32);
  const db = seed(oldKey);
  const poisoned = encryptSecret("from-a-third-key", "a:inf3", randomBytes(32));
  db.set(COL_A, "a3", "inf3", poisoned);

  const report = await rotateEncryptedColumns({ db, columns: [COL_A, COL_B], oldKey, newKey, apply: true });
  assert.deepEqual(report.totals, { scanned: 4, rotated: 3, skipped: 0, failed: 1 });
  assert.equal(db.get(COL_A, "a3"), poisoned, "the unreadable row is not modified");
  assert.deepEqual(report.failures.map((f) => [f.column, f.rowId]), [["a.secret_enc", "a3"]]);
  const printed = JSON.stringify(report);
  for (const secret of ["A-ONE", "B-ONE", oldKey.toString("base64"), newKey.toString("base64")]) assert.ok(!printed.includes(secret), "the report holds no plaintext or key");
});

test("a database error on one row fails that row only, rolls it back, and does not stop the run", async () => {
  const oldKey = randomBytes(32);
  const newKey = randomBytes(32);
  const db = seed(oldKey);
  db.failWriteFor.add("a2");
  const original = db.get(COL_A, "a2");
  const report = await rotateEncryptedColumns({ db, columns: [COL_A, COL_B], oldKey, newKey, apply: true });
  assert.deepEqual(report.totals, { scanned: 3, rotated: 2, skipped: 0, failed: 1 });
  assert.equal(db.get(COL_A, "a2"), original, "rolled back");
  assert.match(report.failures[0].reason, /database error \(40P01\)/);
  assert.ok(!report.failures[0].reason.includes("deadlock"), "driver messages are not echoed");
  // Once the fault is gone, a re-run finishes the job.
  db.failWriteFor.clear();
  const rerun = await rotateEncryptedColumns({ db, columns: [COL_A, COL_B], oldKey, newKey, apply: true });
  assert.deepEqual(rerun.totals, { scanned: 3, rotated: 1, skipped: 2, failed: 0 });
});

test("the row is re-read under the lock: a value the app rewrote meanwhile is not overwritten with stale data", async () => {
  const oldKey = randomBytes(32);
  const newKey = randomBytes(32);
  const db = seed(oldKey);
  // After the scan, the app saves a new value for a1 (encrypted with the new key by an already-updated instance).
  const appWrote = encryptSecret("A-ONE-EDITED", "a:inf1", newKey);
  db.onBeforeRead = (col, id) => {
    if (col === COL_A && id === "a1") db.table(col.name).get(id)!.value = appWrote;
  };
  const report = await rotateEncryptedColumns({ db, columns: [COL_A], oldKey, newKey, apply: true });
  assert.equal(db.get(COL_A, "a1"), appWrote);
  assert.deepEqual(report.columns["a.secret_enc"], { scanned: 2, rotated: 1, skipped: 1, failed: 0 });
});

test("a row deleted between the scan and the read is skipped, not an error", async () => {
  const oldKey = randomBytes(32);
  const newKey = randomBytes(32);
  const db = seed(oldKey);
  db.onBeforeRead = (col, id) => {
    if (id === "a2") db.table(col.name).delete(id);
  };
  const report = await rotateEncryptedColumns({ db, columns: [COL_A], oldKey, newKey, apply: true });
  assert.deepEqual(report.totals, { scanned: 2, rotated: 1, skipped: 1, failed: 0 });
});

test("identical or malformed keys are refused before anything is read", async () => {
  const key = randomBytes(32);
  const db = seed(key);
  await assert.rejects(rotateEncryptedColumns({ db, columns: [COL_A], oldKey: key, newKey: Buffer.from(key) }), /identical/);
  await assert.rejects(rotateEncryptedColumns({ db, columns: [COL_A], oldKey: key, newKey: randomBytes(16) }), /32 bytes/);
  assert.equal(db.transactions, 0);
});

/* ---------- the column list must cover every encrypted column in the schema ---------- */

const schemaText = () => readFileSync(join(process.cwd(), "prisma", "schema.prisma"), "utf8");

test("every *_enc / *Enc column in prisma/schema.prisma is covered by the rotation list (auto-discovered)", () => {
  const discovered = discoverEncryptedColumns(schemaText());
  assert.ok(discovered.length >= 4, "the schema scan found the known encrypted columns");
  const problems = checkColumnCoverage(schemaText(), ENCRYPTED_COLUMNS);
  // If this fails: a column that holds a TOKEN_ENCRYPTION_KEY ciphertext is not in ENCRYPTED_COLUMNS
  // (lib/key-rotation-db.ts), so a key rotation would leave its values stranded on the old key. Add an entry.
  assert.deepEqual(problems.missing, [], "encrypted columns in the schema that the rotation tool does not know about");
  assert.deepEqual(problems.unknown, [], "rotation entries that are not encrypted columns of the schema");
  assert.deepEqual(problems.badColumns, [], "rotation entries naming a column that does not exist");
  for (const c of ENCRYPTED_COLUMNS) assert.equal(c.name, `${c.table}.${c.column}`);
  assert.deepEqual([...discovered], ENCRYPTED_COLUMNS.map((c) => c.name).sort());
});

test("the coverage check really notices a new encrypted column (in a camelCase and a snake_case spelling)", () => {
  // The admin 2FA secret is a real, listed column now, so this uses a made-up model to prove the check still notices
  // the NEXT encrypted column someone adds and forgets to list.
  const schema =
    schemaText() +
    `
model Widget {
  id             String  @id
  secretEnc      String? @map("secret_enc")
  other_enc      String?
  name           String
  @@map("widgets")
}
`;
  const discovered = discoverEncryptedColumns(schema);
  assert.ok(discovered.includes("widgets.secret_enc"), "@map'd camelCase field");
  assert.ok(discovered.includes("widgets.other_enc"), "snake_case field without @map");

  const problems = checkColumnCoverage(schema, ENCRYPTED_COLUMNS);
  assert.deepEqual(problems.missing, ["widgets.other_enc", "widgets.secret_enc"]);

  // The real schema: every encrypted column is listed, including the admin 2FA secret (an own-id owner column).
  const real = checkColumnCoverage(schemaText(), ENCRYPTED_COLUMNS);
  assert.deepEqual(real.missing, []);
  assert.deepEqual(real.badColumns, []);
  assert.deepEqual(real.unknown, []);
  assert.ok(ENCRYPTED_COLUMNS.some((c) => c.name === "admin_users.totp_secret_enc" && c.ownerColumn === "id"), "admin 2FA secret is rotated");
  assert.equal(ENCRYPTED_COLUMNS.find((c) => c.name === "admin_users.totp_secret_enc")!.aad("admin1"), "admin-totp:admin1");

  // Describing the new column through the generalised fields covers it, and a typo in the owner column is caught.
  const widget: EncryptedColumn = { name: "widgets.secret_enc", table: "widgets", column: "secret_enc", ownerColumn: "id", aad: (id) => `widget:${id}` };
  const covered = checkColumnCoverage(schema, [...ENCRYPTED_COLUMNS, widget]);
  assert.deepEqual(covered.missing, ["widgets.other_enc"]);
  assert.deepEqual(covered.badColumns, []);
  const typo = checkColumnCoverage(schema, [...ENCRYPTED_COLUMNS, { ...widget, ownerColumn: "widget_id" }]);
  assert.match(typo.badColumns.join("\n"), /ownerColumn "widget_id" is not a column of widgets/);
  // A listed column that is not in the schema is reported as unknown.
  assert.deepEqual(checkColumnCoverage(schemaText(), [...ENCRYPTED_COLUMNS, widget]).unknown, ["widgets.secret_enc"]);
});

test("a column whose AAD is its own row id rotates and verifies like any other (ownerColumn = id)", async () => {
  const oldKey = randomBytes(32);
  const newKey = randomBytes(32);
  const db = new FakeDb();
  const admin: EncryptedColumn = { name: "admin_users.totp_secret_enc", table: "admin_users", column: "totp_secret_enc", ownerColumn: "id", aad: (id) => `admin-totp:${id}` };
  db.set(admin, "admin1", "admin1", encryptSecret("TOTP-SECRET", "admin-totp:admin1", oldKey));
  const report = await rotateEncryptedColumns({ db, columns: [admin], oldKey, newKey, apply: true });
  assert.deepEqual(report.totals, { scanned: 1, rotated: 1, skipped: 0, failed: 0 });
  assert.equal(decryptSecret(db.get(admin, "admin1")!, "admin-totp:admin1", newKey), "TOTP-SECRET");
  const verified = await verifyEncryptedColumns({ db, columns: [admin], currentKey: newKey, previousKey: oldKey });
  assert.deepEqual(verified.totals, { scanned: 1, current: 1, previousOnly: 0, unreadable: 0 });
});

/* ---------- verification (decrypt only) ---------- */

test("verifyEncryptedColumns counts what the current key reads, what only the previous key reads, and what nothing reads", async () => {
  const oldKey = randomBytes(32);
  const newKey = randomBytes(32);
  const db = seed(oldKey);
  db.set(COL_A, "a3", "inf3", encryptSecret("X", "a:inf3", newKey)); // already on the new key
  db.set(COL_A, "a4", "inf4", encryptSecret("Y", "a:inf4", randomBytes(32))); // a third key: unreadable

  const before = JSON.stringify([...db.tables].map(([k, v]) => [k, [...v]]));
  const r = await verifyEncryptedColumns({ db, columns: [COL_A, COL_B], currentKey: newKey, previousKey: oldKey });
  assert.deepEqual(r.columns["a.secret_enc"], { scanned: 4, current: 1, previousOnly: 2, unreadable: 1 });
  assert.deepEqual(r.columns["b.token_enc"], { scanned: 1, current: 0, previousOnly: 1, unreadable: 0 });
  assert.deepEqual(r.totals, { scanned: 5, current: 1, previousOnly: 3, unreadable: 1 });
  assert.deepEqual(r.failures.map((f) => f.rowId), ["a4"]);
  assert.equal(db.writes, 0);
  assert.equal(db.locks, 0, "no row locks");
  assert.equal(JSON.stringify([...db.tables].map(([k, v]) => [k, [...v]])), before, "nothing changed");

  // Without a previous key, old rows are simply unreadable.
  const noPrev = await verifyEncryptedColumns({ db, columns: [COL_A], currentKey: newKey });
  assert.deepEqual(noPrev.totals, { scanned: 4, current: 1, previousOnly: 0, unreadable: 3 });
  assert.ok(!JSON.stringify(r).includes("A-ONE") && !JSON.stringify(r).includes(newKey.toString("base64")));
});

/* ---------- integration: the real tables, the real modules, rows of our own ---------- */

const realKey = process.env.TOKEN_ENCRYPTION_KEY;
const skip = process.env.DATABASE_URL && realKey ? false : "DATABASE_URL / TOKEN_ENCRYPTION_KEY not set";
const run = Date.now();
const ids: string[] = [];
let a = "";
let b = "";
const newKey = newKeyB64();

const bank = payoutInputSchema.parse({
  method: "BANK",
  accountHolderName: "Asha Rao",
  bankName: "HDFC Bank",
  ifsc: "HDFC0001234",
  accountNumber: "123456789012",
  confirmAccountNumber: "123456789012",
});
const upi = payoutInputSchema.parse({ method: "UPI", accountHolderName: "Ravi Kumar", upiId: "ravi@okhdfcbank" });

before(async () => {
  if (skip) return;
  a = (await prisma.influencer.create({ data: { slug: `kr-a-${run}`, name: "A", email: `kr-a-${run}@example.com` } })).id;
  b = (await prisma.influencer.create({ data: { slug: `kr-b-${run}`, name: "B", email: `kr-b-${run}@example.com` } })).id;
  ids.push(a, b);
  // Written exactly as the app writes them, with the real (old) key.
  await saveGoogleToken(a, "google-refresh-A", "calendar");
  await saveGoogleToken(b, "google-refresh-B", "calendar");
  await savePayoutAccount(a, bank);
  await savePayoutAccount(b, upi);
  await prisma.whatsAppConnection.create({
    data: { influencerId: a, wabaId: "111111", phoneNumberId: `9${run}`, tokenEnc: encryptSecret("wa-token-A", whatsappTokenAad(a)) },
  });
});

after(async () => {
  if (!skip) await prisma.influencer.deleteMany({ where: { id: { in: ids } } }); // cascades to the rows above
  await prisma.$disconnect();
});

test("integration: dry run counts our rows, changes nothing, and proves every AAD matches the app's", { skip }, async () => {
  const oldKey = parseKeyBytes(realKey)!;
  const payoutBefore = await prisma.payoutAccount.findUnique({ where: { influencerId: a } });
  const report = await rotateEncryptedColumns({
    db: prismaRotationDb(prisma, { ownerIds: ids }),
    columns: ENCRYPTED_COLUMNS,
    oldKey,
    newKey: parseKeyBytes(newKey)!,
  });
  // google x2, bank account number x1, upi x1, whatsapp x1: exactly our rows, so the influencer filter works.
  assert.deepEqual(report.totals, { scanned: 5, rotated: 5, skipped: 0, failed: 0 }, JSON.stringify(report.failures));
  assert.deepEqual(await prisma.payoutAccount.findUnique({ where: { influencerId: a } }), payoutBefore);
});

test("integration: during a rolling deploy (current = new, previous = old) un-rotated rows are still readable", { skip }, async () => {
  await withKeys({ current: newKey, previous: realKey }, async () => {
    assert.deepEqual(await getRefreshToken(a), { state: "ok", refreshToken: "google-refresh-A" });
    assert.equal((await revealPayoutAccount(a))?.accountNumber, "123456789012");
    assert.equal((await revealPayoutAccount(b))?.upiId, "ravi@okhdfcbank");
    assert.equal((await resolveSendCredentials(a, NO_ENV))?.token, "wa-token-A");
  });
  // Without the fallback the same instance cannot read them.
  await withKeys({ current: newKey }, async () => {
    await assert.rejects(revealPayoutAccount(a));
  });
});

test("integration: apply rotates our rows to the new key, keeps updated_at, and is idempotent", { skip }, async () => {
  const oldKey = parseKeyBytes(realKey)!;
  const nk = parseKeyBytes(newKey)!;
  const payoutBefore = await prisma.payoutAccount.findUnique({ where: { influencerId: a } });
  const googleBefore = await prisma.googleToken.findUnique({ where: { influencerId: a } });
  const opts = { db: prismaRotationDb(prisma, { ownerIds: ids }), columns: ENCRYPTED_COLUMNS, oldKey, newKey: nk, apply: true };

  const first = await rotateEncryptedColumns(opts);
  assert.deepEqual(first.totals, { scanned: 5, rotated: 5, skipped: 0, failed: 0 }, JSON.stringify(first.failures));

  // Stored values now decrypt with the new key and the app's own AAD, and no longer with the old key.
  const g = await prisma.googleToken.findUniqueOrThrow({ where: { influencerId: a } });
  assert.equal(decryptSecret(g.refreshTokenEnc, googleTokenAad(a), nk), "google-refresh-A");
  assert.equal(tryDecryptSecret(g.refreshTokenEnc, googleTokenAad(a), oldKey), null);
  const p = await prisma.payoutAccount.findUniqueOrThrow({ where: { influencerId: a } });
  assert.equal(decryptSecret(p.accountNumberEnc!, payoutAad(a, "account"), nk), "123456789012");
  const pb = await prisma.payoutAccount.findUniqueOrThrow({ where: { influencerId: b } });
  assert.equal(decryptSecret(pb.upiIdEnc!, payoutAad(b, "upi"), nk), "ravi@okhdfcbank");
  const w = await prisma.whatsAppConnection.findUniqueOrThrow({ where: { influencerId: a } });
  assert.equal(decryptSecret(w.tokenEnc, whatsappTokenAad(a), nk), "wa-token-A");

  // Rotating a key is not an edit: updated_at is untouched, and nothing but the ciphertext changed.
  assert.equal(p.updatedAt.getTime(), payoutBefore!.updatedAt.getTime());
  assert.equal(g.updatedAt.getTime(), googleBefore!.updatedAt.getTime());
  assert.equal(p.status, payoutBefore!.status);
  assert.equal(g.scope, googleBefore!.scope);

  // The app, running with the new key as current and the old as previous, reads everything.
  await withKeys({ current: newKey, previous: realKey }, async () => {
    assert.deepEqual(await getRefreshToken(b), { state: "ok", refreshToken: "google-refresh-B" });
    assert.equal((await revealPayoutAccount(a))?.accountNumber, "123456789012");
    assert.equal((await resolveSendCredentials(a, NO_ENV))?.token, "wa-token-A");
  });
  // ...and with the old key retired (current = new only) too: nothing depends on it any more.
  await withKeys({ current: newKey }, async () => {
    assert.equal((await revealPayoutAccount(b))?.upiId, "ravi@okhdfcbank");
  });

  const second = await rotateEncryptedColumns(opts);
  assert.deepEqual(second.totals, { scanned: 5, rotated: 0, skipped: 5, failed: 0 });
});
