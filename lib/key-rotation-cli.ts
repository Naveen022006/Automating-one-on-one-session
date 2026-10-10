import { keyFingerprint, parseKeyBytes } from "./crypto";
import {
  rotateEncryptedColumns,
  verifyEncryptedColumns,
  type EncryptedColumn,
  type RotationDb,
  type RotationReport,
  type VerifyReport,
} from "./key-rotation";

/**
 * The command-line layer of `npm run keys:rotate` and `npm run keys:verify`, kept out of the scripts so it can be
 * tested: argument parsing, key resolution, the fingerprint safeguard and the output are pure or take injected
 * dependencies (environment, database, output). The scripts in scripts/ only wire in the real ones.
 *
 * KEYS COME FROM THE APP'S OWN VARIABLES, exactly as the running services have them while a rotation is under way:
 *   TOKEN_ENCRYPTION_KEY            the key every value must end up on (the NEW key)
 *   TOKEN_ENCRYPTION_KEY_PREVIOUS   the key the values are on today (the OLD key)
 * so run the tools with the same environment as the services, never with hand-assembled keys.
 *
 * The tool cannot know which key is "right": a wrong key encrypts and decrypts consistently. So each run prints
 * the fingerprint (8 hex characters of a hash, never the key) of both keys, the services log the current key's
 * fingerprint at start-up, and `--apply` refuses to write unless `--confirm-new-fingerprint=<fingerprint>` matches
 * the NEW key in this environment. Exit codes: 0 ok, 1 a value failed or is unreadable, 2 usage or configuration.
 */

export class UsageError extends Error {}

export type EnvLike = Record<string, string | undefined>;

const FINGERPRINT = /^[0-9a-f]{8}$/;

/** Reads `--flag value` or `--flag=value`. Returns the value and the index of the last argument consumed. */
function flagValue(argv: string[], i: number, flag: string): [string, number] {
  const a = argv[i];
  if (a.startsWith(`${flag}=`)) return [a.slice(flag.length + 1), i];
  const next = argv[i + 1];
  if (next === undefined || next.startsWith("--")) throw new UsageError(`${flag} needs a value`);
  return [next, i + 1];
}

export interface RotateArgs {
  apply: boolean;
  confirmFingerprint?: string;
  onlyOwners?: string[];
}

/** Dry run is the default. `--apply` and `--dry-run` together, and any unknown argument, are errors. */
export function parseRotateArgs(argv: string[]): RotateArgs {
  let apply = false;
  let dry = false;
  let confirmFingerprint: string | undefined;
  const only: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--apply") apply = true;
    else if (a === "--dry-run") dry = true;
    else if (a === "--confirm-new-fingerprint" || a.startsWith("--confirm-new-fingerprint=")) {
      const [v, next] = flagValue(argv, i, "--confirm-new-fingerprint");
      i = next;
      confirmFingerprint = v.trim().toLowerCase();
      if (!FINGERPRINT.test(confirmFingerprint)) throw new UsageError("--confirm-new-fingerprint must be exactly 8 hex characters (the fingerprint of the new key)");
    } else if (a === "--only-owner" || a.startsWith("--only-owner=")) {
      const [v, next] = flagValue(argv, i, "--only-owner");
      i = next;
      only.push(v);
    } else throw new UsageError(`Unknown argument: ${a}`);
  }
  if (apply && dry) throw new UsageError("Choose either --dry-run or --apply, not both");
  return { apply, confirmFingerprint, onlyOwners: only.length ? only : undefined };
}

export interface VerifyArgs {
  /** Rows that decrypt only with the previous key are acceptable (checking that a restored backup is readable). */
  allowPrevious: boolean;
  onlyOwners?: string[];
}

export function parseVerifyArgs(argv: string[]): VerifyArgs {
  let allowPrevious = false;
  const only: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--allow-previous") allowPrevious = true;
    else if (a === "--only-owner" || a.startsWith("--only-owner=")) {
      const [v, next] = flagValue(argv, i, "--only-owner");
      i = next;
      only.push(v);
    } else throw new UsageError(`Unknown argument: ${a}`);
  }
  return { allowPrevious, onlyOwners: only.length ? only : undefined };
}

export interface ResolvedKeys {
  /** TOKEN_ENCRYPTION_KEY: the current / new key. */
  current: Buffer;
  /** TOKEN_ENCRYPTION_KEY_PREVIOUS: the old key, if configured. */
  previous?: Buffer;
}

/** Reads the app's own variables. `requirePrevious` is for rotation, which has nothing to do without an old key. */
export function resolveKeys(env: EnvLike, requirePrevious: boolean): ResolvedKeys {
  const current = parseKeyBytes(env.TOKEN_ENCRYPTION_KEY);
  if (!current) throw new UsageError("TOKEN_ENCRYPTION_KEY (the key values must be on after the rotation) must be set and be 32 bytes, base64 encoded");
  let previous: Buffer | undefined;
  if (env.TOKEN_ENCRYPTION_KEY_PREVIOUS) {
    previous = parseKeyBytes(env.TOKEN_ENCRYPTION_KEY_PREVIOUS) ?? undefined;
    if (!previous) throw new UsageError("TOKEN_ENCRYPTION_KEY_PREVIOUS must be 32 bytes, base64 encoded");
    if (previous.equals(current)) throw new UsageError("TOKEN_ENCRYPTION_KEY and TOKEN_ENCRYPTION_KEY_PREVIOUS are the same key; there is nothing to rotate");
  } else if (requirePrevious) {
    throw new UsageError(
      "TOKEN_ENCRYPTION_KEY_PREVIOUS (the key the values are on today) must be set. Run this with the same environment as your services during a rotation: TOKEN_ENCRYPTION_KEY = the new key, TOKEN_ENCRYPTION_KEY_PREVIOUS = the old key",
    );
  }
  return { current, previous };
}

/** What the CLI needs from the outside world. */
export interface CliIo {
  argv: string[];
  env: EnvLike;
  /** Opens the database lazily, after the arguments and keys have been checked, so a usage error never connects. */
  connect: (opts: { ownerIds?: string[] }) => Promise<{ db: RotationDb; columns: EncryptedColumn[]; close: () => Promise<void> }>;
  out: (line: string) => void;
  err: (line: string) => void;
}

function describeKeys(io: CliIo, keys: ResolvedKeys): void {
  io.out("Keys in this environment (fingerprints only; compare them with what your services logged at start-up):");
  io.out(`  TOKEN_ENCRYPTION_KEY           fingerprint ${keyFingerprint(keys.current)}`);
  io.out(`  TOKEN_ENCRYPTION_KEY_PREVIOUS  ${keys.previous ? `fingerprint ${keyFingerprint(keys.previous)}` : "not set"}`);
}

function errorLabel(e: unknown): string {
  const code = (e as { code?: unknown } | null)?.code;
  return `${e instanceof Error ? e.name : "error"}${typeof code === "string" && /^[A-Za-z0-9_.-]{1,40}$/.test(code) ? ` (${code})` : ""}`;
}

function printRotation(io: CliIo, report: RotationReport): void {
  const verb = report.apply ? "rotated" : "would rotate";
  io.out(report.apply ? "Mode: APPLY (rows are being re-encrypted)" : "Mode: DRY RUN (nothing is written)");
  const width = Math.max(...Object.keys(report.columns).map((n) => n.length), 10);
  const line = (name: string, c: RotationReport["totals"]) =>
    `  ${name.padEnd(width)}  scanned ${String(c.scanned).padStart(4)}  ${verb} ${String(c.rotated).padStart(4)}  already on new key ${String(c.skipped).padStart(4)}  failed ${String(c.failed).padStart(4)}`;
  for (const [name, counts] of Object.entries(report.columns)) io.out(line(name, counts));
  io.out(line("TOTAL", report.totals));
  for (const f of report.failures) io.err(`  FAILED ${f.column} row ${f.rowId}: ${f.reason}`);
}

function printVerify(io: CliIo, report: VerifyReport): void {
  const width = Math.max(...Object.keys(report.columns).map((n) => n.length), 10);
  const line = (name: string, c: VerifyReport["totals"]) =>
    `  ${name.padEnd(width)}  scanned ${String(c.scanned).padStart(4)}  current key ${String(c.current).padStart(4)}  previous key only ${String(c.previousOnly).padStart(4)}  unreadable ${String(c.unreadable).padStart(4)}`;
  for (const [name, counts] of Object.entries(report.columns)) io.out(line(name, counts));
  io.out(line("TOTAL", report.totals));
  for (const f of report.failures) io.err(`  UNREADABLE ${f.column} row ${f.rowId}: ${f.reason}`);
}

/** `npm run keys:rotate`. Returns the process exit code. */
export async function runRotateCli(io: CliIo): Promise<number> {
  let args: RotateArgs;
  let keys: ResolvedKeys;
  try {
    args = parseRotateArgs(io.argv);
    keys = resolveKeys(io.env, true);
  } catch (e) {
    if (!(e instanceof UsageError)) throw e;
    io.err(`${e.message}\nUsage: npm run keys:rotate -- [--dry-run | --apply --confirm-new-fingerprint=<8 hex>] [--only-owner <id>]...`);
    return 2;
  }

  describeKeys(io, keys);
  const newFingerprint = keyFingerprint(keys.current);
  if (args.confirmFingerprint && args.confirmFingerprint !== newFingerprint) {
    io.err(
      "The fingerprint you confirmed does not match the NEW key (TOKEN_ENCRYPTION_KEY) in this environment. This is not the environment your services run with. Nothing was read or written.",
    );
    return 2;
  }
  if (args.apply && !args.confirmFingerprint) {
    io.err(
      "Refusing to write. --apply needs --confirm-new-fingerprint=<8 hex> so a wrong environment cannot be applied by accident: " +
        "compare the TOKEN_ENCRYPTION_KEY fingerprint above with the one your running services log at start-up, " +
        "and pass the value your services logged. Nothing was read or written.",
    );
    return 2;
  }

  let conn: Awaited<ReturnType<CliIo["connect"]>>;
  try {
    conn = await io.connect({ ownerIds: args.onlyOwners });
  } catch (e) {
    if (e instanceof UsageError) {
      io.err(e.message);
      return 2;
    }
    io.err(`Key rotation aborted: could not open the database: ${errorLabel(e)}`);
    return 1;
  }

  try {
    if (args.onlyOwners) io.out(`Restricted to ${args.onlyOwners.length} owner id(s).`);
    const report = await rotateEncryptedColumns({ db: conn.db, columns: conn.columns, oldKey: keys.previous!, newKey: keys.current, apply: args.apply });
    printRotation(io, report);
    if (report.totals.failed > 0) {
      io.err(`${report.totals.failed} row(s) failed and were left unchanged. Fix the cause and run again; finished rows are skipped.`);
      return 1;
    }
    io.out(
      args.apply
        ? "Done. Every row is on the new key. Next: npm run keys:verify, then the 'Finish' step in doc/08-deployment.md."
        : "Dry run complete: every row can be rotated. Re-run with --apply --confirm-new-fingerprint=<fingerprint your services logged>.",
    );
    return 0;
  } catch (e) {
    io.err(`Key rotation aborted: ${errorLabel(e)}`);
    return 1;
  } finally {
    await conn.close().catch(() => {});
  }
}

/** `npm run keys:verify`: decrypt-only check that stored values are readable with the CURRENT key. */
export async function runVerifyCli(io: CliIo): Promise<number> {
  let args: VerifyArgs;
  let keys: ResolvedKeys;
  try {
    args = parseVerifyArgs(io.argv);
    keys = resolveKeys(io.env, false);
  } catch (e) {
    if (!(e instanceof UsageError)) throw e;
    io.err(`${e.message}\nUsage: npm run keys:verify -- [--allow-previous] [--only-owner <id>]...`);
    return 2;
  }

  describeKeys(io, keys);
  let conn: Awaited<ReturnType<CliIo["connect"]>>;
  try {
    conn = await io.connect({ ownerIds: args.onlyOwners });
  } catch (e) {
    if (e instanceof UsageError) {
      io.err(e.message);
      return 2;
    }
    io.err(`Key verification aborted: could not open the database: ${errorLabel(e)}`);
    return 1;
  }

  try {
    const report = await verifyEncryptedColumns({ db: conn.db, columns: conn.columns, currentKey: keys.current, previousKey: keys.previous });
    printVerify(io, report);
    const t = report.totals;
    io.out(`${t.current} of ${t.scanned} encrypted value(s) decrypt with the current key.`);
    if (t.unreadable > 0) {
      io.err(`${t.unreadable} value(s) cannot be decrypted with the current${keys.previous ? " or the previous" : ""} key: this is not the key those values were encrypted with (or the data is damaged).`);
      return 1;
    }
    if (t.previousOnly > 0) {
      if (args.allowPrevious) {
        io.out(`${t.previousOnly} value(s) decrypt only with the previous key (allowed by --allow-previous). Run keys:rotate to move them.`);
        return 0;
      }
      io.err(`${t.previousOnly} value(s) decrypt only with the previous key: run keys:rotate. (Pass --allow-previous when you are only checking that a restored backup is readable.)`);
      return 1;
    }
    io.out("OK.");
    return 0;
  } catch (e) {
    io.err(`Key verification aborted: ${errorLabel(e)}`);
    return 1;
  } finally {
    await conn.close().catch(() => {});
  }
}
