import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { decryptSecret, encryptSecret, keyFingerprint, tryDecryptSecret } from "../lib/crypto";
import {
  parseRotateArgs,
  parseVerifyArgs,
  resolveKeys,
  runRotateCli,
  runVerifyCli,
  UsageError,
  type CliIo,
  type EnvLike,
} from "../lib/key-rotation-cli";
import { COL_A, COL_B, FakeDb, seed } from "./helpers/fake-rotation-db";

// Pure tests: fake database, injected environment and output. Nothing reads process.env or touches a real database.

const b64 = (k: Buffer) => k.toString("base64");

/** An environment as the SERVICES have it during a rotation: current = new key, previous = old key. */
function rotationEnv(oldKey: Buffer, newKey: Buffer): EnvLike {
  return { TOKEN_ENCRYPTION_KEY: b64(newKey), TOKEN_ENCRYPTION_KEY_PREVIOUS: b64(oldKey), DATABASE_URL: "postgresql://unused" };
}

function makeIo(argv: string[], env: EnvLike, db: FakeDb) {
  const out: string[] = [];
  const err: string[] = [];
  const state = { connects: 0, closed: 0, ownerIds: undefined as string[] | undefined };
  const io: CliIo = {
    argv,
    env,
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    async connect({ ownerIds }) {
      state.connects++;
      state.ownerIds = ownerIds;
      return { db, columns: [COL_A, COL_B], close: async () => void state.closed++ };
    },
  };
  return { io, out, err, state, text: () => [...out, ...err].join("\n") };
}

/** The output of a command must carry no key material (base64, hex, or the raw bytes) and no plaintext. */
function assertNoSecrets(text: string, keys: Buffer[], plaintexts: string[] = ["A-ONE", "A-TWO", "B-ONE"]) {
  for (const k of keys) {
    for (const form of [b64(k), k.toString("hex"), k.toString("base64url"), k.toString("base64").replace(/=+$/, "")]) {
      assert.ok(!text.includes(form), "output must not contain key material");
    }
  }
  for (const p of plaintexts) assert.ok(!text.includes(p), "output must not contain plaintext");
}

/* ---------- fingerprints ---------- */

test("a key fingerprint is 8 hex characters, stable, distinct per key, and reveals nothing usable", () => {
  const a = randomBytes(32);
  const b = randomBytes(32);
  assert.match(keyFingerprint(a), /^[0-9a-f]{8}$/);
  assert.equal(keyFingerprint(a), keyFingerprint(Buffer.from(a)));
  assert.notEqual(keyFingerprint(a), keyFingerprint(b));
  assert.equal(keyFingerprint(a).length, 8);
});

/* ---------- argument parsing ---------- */

test("rotate arguments: dry run is the default; --apply and --dry-run conflict; unknown flags are rejected", () => {
  assert.deepEqual(parseRotateArgs([]), { apply: false, confirmFingerprint: undefined, onlyOwners: undefined });
  assert.equal(parseRotateArgs(["--dry-run"]).apply, false);
  assert.equal(parseRotateArgs(["--apply"]).apply, true);
  assert.throws(() => parseRotateArgs(["--apply", "--dry-run"]), (e: unknown) => e instanceof UsageError && /either --dry-run or --apply/.test(e.message));
  assert.throws(() => parseRotateArgs(["--dry-run", "--apply"]), UsageError);
  for (const bad of [["--force"], ["apply"], ["--apply", "--yes"], ["-a"], ["--TOKEN_ENCRYPTION_KEY_NEW=x"]]) {
    assert.throws(() => parseRotateArgs(bad), (e: unknown) => e instanceof UsageError && /Unknown argument/.test(e.message), bad.join(" "));
  }
});

test("rotate arguments: --confirm-new-fingerprint takes 8 hex characters in either spelling", () => {
  assert.equal(parseRotateArgs(["--apply", "--confirm-new-fingerprint=0a1b2c3d"]).confirmFingerprint, "0a1b2c3d");
  assert.equal(parseRotateArgs(["--apply", "--confirm-new-fingerprint", "0A1B2C3D"]).confirmFingerprint, "0a1b2c3d", "case-insensitive");
  for (const bad of ["abc", "0a1b2c3", "0a1b2c3d4", "zzzzzzzz", ""]) {
    assert.throws(() => parseRotateArgs([`--confirm-new-fingerprint=${bad}`]), UsageError, bad);
  }
  assert.throws(() => parseRotateArgs(["--confirm-new-fingerprint"]), /needs a value/);
  assert.throws(() => parseRotateArgs(["--confirm-new-fingerprint", "--apply"]), /needs a value/);
});

test("--only-owner can be repeated and takes both spellings", () => {
  assert.deepEqual(parseRotateArgs(["--only-owner", "a", "--only-owner=b"]).onlyOwners, ["a", "b"]);
  assert.deepEqual(parseVerifyArgs(["--only-owner=z"]).onlyOwners, ["z"]);
  assert.throws(() => parseRotateArgs(["--only-owner"]), /needs a value/);
});

test("verify arguments: --allow-previous and --only-owner only", () => {
  assert.deepEqual(parseVerifyArgs([]), { allowPrevious: false, onlyOwners: undefined });
  assert.equal(parseVerifyArgs(["--allow-previous"]).allowPrevious, true);
  assert.throws(() => parseVerifyArgs(["--apply"]), UsageError);
  assert.throws(() => parseVerifyArgs(["--bogus"]), /Unknown argument/);
});

/* ---------- keys come from the app's own variables ---------- */

test("the tools read the app's variables: TOKEN_ENCRYPTION_KEY is the new key, TOKEN_ENCRYPTION_KEY_PREVIOUS the old one", () => {
  const oldKey = randomBytes(32);
  const newKey = randomBytes(32);
  const k = resolveKeys(rotationEnv(oldKey, newKey), true);
  assert.ok(k.current.equals(newKey));
  assert.ok(k.previous?.equals(oldKey));
});

test("a leftover TOKEN_ENCRYPTION_KEY_NEW is not used for anything", () => {
  const key = randomBytes(32);
  assert.throws(() => resolveKeys({ TOKEN_ENCRYPTION_KEY: b64(key), TOKEN_ENCRYPTION_KEY_NEW: b64(randomBytes(32)) }, true), /TOKEN_ENCRYPTION_KEY_PREVIOUS .* must be set/);
  const only = resolveKeys({ TOKEN_ENCRYPTION_KEY: b64(key), TOKEN_ENCRYPTION_KEY_NEW: b64(randomBytes(32)) }, false);
  assert.ok(only.current.equals(key));
  assert.equal(only.previous, undefined);
});

test("bad or missing keys are usage errors that name the variable, never print it", () => {
  const key = b64(randomBytes(32));
  assert.throws(() => resolveKeys({}, false), /TOKEN_ENCRYPTION_KEY .*must be set/);
  assert.throws(() => resolveKeys({ TOKEN_ENCRYPTION_KEY: "SENTINEL-not-a-key" }, false), (e: unknown) => e instanceof UsageError && !e.message.includes("SENTINEL"));
  assert.throws(() => resolveKeys({ TOKEN_ENCRYPTION_KEY: key, TOKEN_ENCRYPTION_KEY_PREVIOUS: "SENTINEL-short" }, false), (e: unknown) => e instanceof UsageError && /PREVIOUS must be 32 bytes/.test(e.message) && !e.message.includes("SENTINEL"));
  assert.throws(() => resolveKeys({ TOKEN_ENCRYPTION_KEY: key, TOKEN_ENCRYPTION_KEY_PREVIOUS: key }, true), /same key/);
  assert.throws(() => resolveKeys({ TOKEN_ENCRYPTION_KEY: key }, true), /TOKEN_ENCRYPTION_KEY_PREVIOUS/);
});

/* ---------- keys:rotate ---------- */

test("rotate defaults to a dry run: reports what would change, writes nothing, takes no locks", async () => {
  const oldKey = randomBytes(32);
  const newKey = randomBytes(32);
  const db = seed(oldKey);
  const run = makeIo([], rotationEnv(oldKey, newKey), db);
  assert.equal(await runRotateCli(run.io), 0);
  assert.equal(db.writes, 0);
  assert.equal(db.locks, 0);
  assert.match(run.text(), /DRY RUN/);
  assert.match(run.text(), /would rotate\s+2/);
  assert.equal(tryDecryptSecret(db.get(COL_A, "a1")!, "a:inf1", oldKey), "A-ONE", "still on the old key");
  assert.equal(run.state.closed, 1);
});

test("rotate prints both key fingerprints at the start of every run, and no key material or plaintext anywhere", async () => {
  const oldKey = randomBytes(32);
  const newKey = randomBytes(32);
  for (const argv of [[], ["--apply", `--confirm-new-fingerprint=${keyFingerprint(newKey)}`]]) {
    const run = makeIo(argv, rotationEnv(oldKey, newKey), seed(oldKey));
    await runRotateCli(run.io);
    const lines = run.out;
    assert.match(lines[0], /fingerprints only/);
    assert.ok(lines[1].includes("TOKEN_ENCRYPTION_KEY") && lines[1].includes(keyFingerprint(newKey)), "new key fingerprint comes first");
    assert.ok(lines[2].includes("TOKEN_ENCRYPTION_KEY_PREVIOUS") && lines[2].includes(keyFingerprint(oldKey)));
    assertNoSecrets(run.text(), [oldKey, newKey]);
  }
});

test("--apply without a fingerprint confirmation does nothing at all, not even a connection", async () => {
  const oldKey = randomBytes(32);
  const newKey = randomBytes(32);
  const db = seed(oldKey);
  const run = makeIo(["--apply"], rotationEnv(oldKey, newKey), db);
  assert.equal(await runRotateCli(run.io), 2);
  assert.equal(run.state.connects, 0, "never opened the database");
  assert.ok(db.untouched());
  assert.match(run.err.join("\n"), /--confirm-new-fingerprint/);
  assert.equal(tryDecryptSecret(db.get(COL_A, "a1")!, "a:inf1", oldKey), "A-ONE");
  assertNoSecrets(run.text(), [oldKey, newKey]);
});

test("--apply with a fingerprint that does not match the new key does nothing", async () => {
  const oldKey = randomBytes(32);
  const newKey = randomBytes(32);
  const otherKey = randomBytes(32);
  for (const wrong of [keyFingerprint(otherKey), keyFingerprint(oldKey)]) {
    const db = seed(oldKey);
    const run = makeIo(["--apply", `--confirm-new-fingerprint=${wrong}`], rotationEnv(oldKey, newKey), db);
    assert.equal(await runRotateCli(run.io), 2);
    assert.equal(run.state.connects, 0);
    assert.ok(db.untouched());
    assert.match(run.err.join("\n"), /does not match the NEW key/);
  }
});

test("the wrong-key scenario: services run with key A, the operator's shell holds key B, so --apply with A's fingerprint is refused", async () => {
  const oldKey = randomBytes(32);
  const keyA = randomBytes(32); // deployed on the services; its fingerprint is in their start-up log
  const keyB = randomBytes(32); // what ended up in the operator's environment by mistake
  const db = seed(oldKey);
  const fingerprintFromServiceLog = keyFingerprint(keyA);
  const run = makeIo(["--apply", `--confirm-new-fingerprint=${fingerprintFromServiceLog}`], rotationEnv(oldKey, keyB), db);
  assert.equal(await runRotateCli(run.io), 2);
  assert.ok(db.untouched(), "no row moved to a key the services cannot read");
  // The mistake is visible in the first lines of the output: the fingerprint printed is B's, not the one the services logged.
  assert.ok(run.out.join("\n").includes(keyFingerprint(keyB)));
  assert.ok(!run.out.join("\n").includes(fingerprintFromServiceLog));
});

test("the reversed environment (current = old, previous = new) is refused when the new key's fingerprint is confirmed", async () => {
  const oldKey = randomBytes(32);
  const newKey = randomBytes(32);
  const db = seed(oldKey);
  const run = makeIo(["--apply", `--confirm-new-fingerprint=${keyFingerprint(newKey)}`], rotationEnv(newKey, oldKey), db);
  assert.equal(await runRotateCli(run.io), 2);
  assert.ok(db.untouched());
});

test("a dry run with a mismatching --confirm-new-fingerprint also stops, so a wrong environment is found before --apply", async () => {
  const oldKey = randomBytes(32);
  const newKey = randomBytes(32);
  const db = seed(oldKey);
  const run = makeIo([`--confirm-new-fingerprint=${keyFingerprint(randomBytes(32))}`], rotationEnv(oldKey, newKey), db);
  assert.equal(await runRotateCli(run.io), 2);
  assert.ok(db.untouched());
});

test("--apply with the matching fingerprint rotates every row onto TOKEN_ENCRYPTION_KEY (the app's current key)", async () => {
  const oldKey = randomBytes(32);
  const newKey = randomBytes(32);
  const db = seed(oldKey);
  const run = makeIo(["--apply", `--confirm-new-fingerprint=${keyFingerprint(newKey)}`], rotationEnv(oldKey, newKey), db);
  assert.equal(await runRotateCli(run.io), 0);
  assert.match(run.text(), /APPLY/);
  assert.equal(db.writes, 3);
  assert.equal(decryptSecret(db.get(COL_A, "a1")!, "a:inf1", newKey), "A-ONE");
  assert.equal(decryptSecret(db.get(COL_B, "b1")!, "inf1", newKey), "B-ONE");
  assert.equal(tryDecryptSecret(db.get(COL_A, "a1")!, "a:inf1", oldKey), null);
  assertNoSecrets(run.text(), [oldKey, newKey]);

  // The services' own decrypt path (current key, then previous key) reads every row, which is the definition of "done".
  const verify = makeIo([], rotationEnv(oldKey, newKey), db);
  assert.equal(await runVerifyCli(verify.io), 0);
});

test("--only-owner is passed to the database layer", async () => {
  const oldKey = randomBytes(32);
  const newKey = randomBytes(32);
  const run = makeIo(["--only-owner", "inf1", "--only-owner=inf2"], rotationEnv(oldKey, newKey), seed(oldKey));
  await runRotateCli(run.io);
  assert.deepEqual(run.state.ownerIds, ["inf1", "inf2"]);
});

test("rotate exits 1 when a row cannot be read, leaving it unchanged", async () => {
  const oldKey = randomBytes(32);
  const newKey = randomBytes(32);
  const db = seed(oldKey);
  const stray = encryptSecret("Z", "a:inf9", randomBytes(32));
  db.set(COL_A, "a9", "inf9", stray);
  const run = makeIo(["--apply", `--confirm-new-fingerprint=${keyFingerprint(newKey)}`], rotationEnv(oldKey, newKey), db);
  assert.equal(await runRotateCli(run.io), 1);
  assert.equal(db.get(COL_A, "a9"), stray);
  assert.match(run.err.join("\n"), /FAILED a\.secret_enc row a9/);
});

test("rotate needs the old key: without TOKEN_ENCRYPTION_KEY_PREVIOUS it stops before connecting", async () => {
  const run = makeIo([], { TOKEN_ENCRYPTION_KEY: b64(randomBytes(32)) }, new FakeDb());
  assert.equal(await runRotateCli(run.io), 2);
  assert.equal(run.state.connects, 0);
  assert.match(run.err.join("\n"), /TOKEN_ENCRYPTION_KEY_PREVIOUS/);
});

test("usage errors stop before connecting and return 2", async () => {
  const oldKey = randomBytes(32);
  const newKey = randomBytes(32);
  for (const argv of [["--bogus"], ["--apply", "--dry-run"]]) {
    const run = makeIo(argv, rotationEnv(oldKey, newKey), seed(oldKey));
    assert.equal(await runRotateCli(run.io), 2);
    assert.equal(run.state.connects, 0);
  }
});

/* ---------- keys:verify ---------- */

test("verify reports how many values decrypt with the current key, and fails unless all do", async () => {
  const oldKey = randomBytes(32);
  const newKey = randomBytes(32);
  const db = seed(oldKey);
  db.set(COL_A, "a3", "inf3", encryptSecret("X", "a:inf3", newKey));

  // Mid-rotation: 1 of 4 on the current key, 3 still on the previous one.
  const mid = makeIo([], rotationEnv(oldKey, newKey), db);
  assert.equal(await runVerifyCli(mid.io), 1);
  assert.match(mid.out.join("\n"), /1 of 4 encrypted value\(s\) decrypt with the current key/);
  assert.match(mid.err.join("\n"), /3 value\(s\) decrypt only with the previous key/);
  assert.equal(db.writes, 0, "decrypt-only");
  assert.equal(db.locks, 0);

  // The restore-drill mode accepts previous-key rows.
  const allowed = makeIo(["--allow-previous"], rotationEnv(oldKey, newKey), db);
  assert.equal(await runVerifyCli(allowed.io), 0);
  assert.match(allowed.out.join("\n"), /3 value\(s\) decrypt only with the previous key \(allowed/);

  // After the rotation everything is on the current key.
  await runRotateCli(makeIo(["--apply", `--confirm-new-fingerprint=${keyFingerprint(newKey)}`], rotationEnv(oldKey, newKey), db).io);
  const done = makeIo([], rotationEnv(oldKey, newKey), db);
  assert.equal(await runVerifyCli(done.io), 0);
  assert.match(done.out.join("\n"), /4 of 4 encrypted value\(s\) decrypt with the current key/);
  assert.match(done.out.join("\n"), /OK\./);
  assertNoSecrets(done.text(), [oldKey, newKey]);
});

test("verify fails (even with --allow-previous) for values neither key can read, and says which row", async () => {
  const oldKey = randomBytes(32);
  const newKey = randomBytes(32);
  const db = seed(newKey);
  db.set(COL_B, "b7", "inf7", encryptSecret("lost", "inf7", randomBytes(32)));
  const run = makeIo(["--allow-previous"], { TOKEN_ENCRYPTION_KEY: b64(newKey), TOKEN_ENCRYPTION_KEY_PREVIOUS: b64(oldKey) }, db);
  assert.equal(await runVerifyCli(run.io), 1);
  assert.match(run.err.join("\n"), /UNREADABLE b\.token_enc row b7/);
  assert.match(run.out.join("\n"), /3 of 4/);
});

test("verify with the wrong current key fails every row: the operator sees it before trusting a restore or a rotation", async () => {
  const realKey = randomBytes(32);
  const db = seed(realKey);
  const run = makeIo([], { TOKEN_ENCRYPTION_KEY: b64(randomBytes(32)) }, db);
  assert.equal(await runVerifyCli(run.io), 1);
  assert.match(run.out.join("\n"), /0 of 3 encrypted value\(s\) decrypt with the current key/);
});

test("verify prints key fingerprints first and only needs the current key", async () => {
  const key = randomBytes(32);
  const run = makeIo([], { TOKEN_ENCRYPTION_KEY: b64(key) }, seed(key));
  assert.equal(await runVerifyCli(run.io), 0);
  assert.ok(run.out[1].includes(keyFingerprint(key)));
  assert.match(run.out[2], /TOKEN_ENCRYPTION_KEY_PREVIOUS\s+not set/);
  assertNoSecrets(run.text(), [key]);
});

test("verify usage errors return 2 without connecting", async () => {
  for (const [argv, env] of [
    [["--apply"], { TOKEN_ENCRYPTION_KEY: b64(randomBytes(32)) }],
    [[], {}],
  ] as [string[], EnvLike][]) {
    const run = makeIo(argv, env, new FakeDb());
    assert.equal(await runVerifyCli(run.io), 2);
    assert.equal(run.state.connects, 0);
  }
});
