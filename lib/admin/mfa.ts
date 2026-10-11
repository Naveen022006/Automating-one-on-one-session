import type { Prisma } from "@/generated/prisma/client";
import { recordAudit } from "@/lib/admin/audit";
import { notifyAdminSecurity } from "@/lib/admin/security-notices";
import { totpAad } from "@/lib/admin/totp-aad";
import { adminPasswordFingerprint } from "@/lib/admin/session";
import {
  generateRecoveryCodes,
  generateTotpSecret,
  hashRecoveryCode,
  looksLikeRecoveryCode,
  normaliseTotpInput,
  otpauthUri,
  verifyTotp,
} from "@/lib/admin/totp";
import { decryptSecret, encryptSecret } from "@/lib/crypto";
import { prisma } from "@/lib/db";
import { signToken, verifyToken } from "@/lib/signing";

/**
 * Administrator two-factor sign-in, database side (the pure TOTP maths is in lib/admin/totp.ts).
 *
 *   enrollment  startTotpEnrollment -> (authenticator app) -> confirmTotpEnrollment: the secret is stored encrypted
 *               (aad `admin-totp:<id>`) from the start but only counts once a first code is confirmed.
 *   sign-in     password OK -> issueAdminPendingToken (5 min, bound to the admin) -> resolveAdminPending +
 *               verifySecondFactor -> createAdminSession(..., { mfaVerified: true }).
 *   replay      the last accepted time step is stored and moved forward with a conditional UPDATE, so a code (or the
 *               step before it) works exactly once, even for two simultaneous requests.
 *   recovery    10 single-use codes, stored as SHA-256; consumed with a conditional UPDATE.
 *   lockout     every code attempt is counted in the database before it is checked; 10 in a row lock authenticator
 *               codes for 15 min (x4 on repeats, max 24 h). Independent of the rate limiter. Recovery codes still work
 *               while locked, and `npm run admin:create -- --email <admin> --reset-2fa` is the break-glass reset.
 */

export const PENDING_TOKEN_PURPOSE = "admin-2fa-pending";
export const PENDING_TOKEN_TTL_SEC = 300;
export const TOTP_ISSUER = "Session Automation Admin";


export class MfaError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

/* ---------- Pending sign-in token ---------- */

/** Proof that the password step succeeded, to be exchanged for a session together with a valid second factor. */
export function issueAdminPendingToken(adminId: string, passwordFingerprint: string, ttlSec = PENDING_TOKEN_TTL_SEC): string {
  return signToken(PENDING_TOKEN_PURPOSE, { adminId, pw: passwordFingerprint }, ttlSec);
}

/**
 * The admin a pending token belongs to, or null if the token is forged, expired, for a disabled admin or an admin
 * without 2FA, or the password changed since it was issued.
 */
export async function resolveAdminPending(token: string | null | undefined): Promise<{ adminId: string; email: string } | null> {
  const payload = verifyToken<{ adminId?: unknown; pw?: unknown }>(PENDING_TOKEN_PURPOSE, token);
  if (!payload || typeof payload.adminId !== "string" || typeof payload.pw !== "string") return null;
  const admin = await prisma.adminUser.findUnique({
    where: { id: payload.adminId },
    select: { id: true, email: true, passwordHash: true, disabledAt: true, totpEnabledAt: true },
  });
  if (!admin || admin.disabledAt || !admin.totpEnabledAt) return null;
  if (adminPasswordFingerprint(admin.passwordHash) !== payload.pw) return null;
  return { adminId: admin.id, email: admin.email };
}

/* ---------- Checking a code ---------- */

export type CodeFailure = "invalid" | "replayed";

/** Verifies a TOTP code against a stored secret and, only if it is fresh, atomically records its time step. */
async function claimTotpCode(
  adminId: string,
  secretEnc: string,
  lastStep: number | null,
  input: string,
  now: number,
): Promise<{ ok: true; step: number } | { ok: false; reason: CodeFailure }> {
  const result = verifyTotp(decryptSecret(secretEnc, totpAad(adminId)), input, { now, lastStep });
  if (!result.ok) return result;
  // Two requests carrying the same code race here; exactly one moves the marker forward.
  const { count } = await prisma.adminUser.updateMany({
    where: { id: adminId, OR: [{ totpLastStep: null }, { totpLastStep: { lt: result.step } }] },
    data: { totpLastStep: result.step },
  });
  return count === 1 ? result : { ok: false, reason: "replayed" };
}

export type CodeRefusal = { ok: false; reason: CodeFailure | "not-enabled" } | { ok: false; reason: "locked"; lockedUntil: Date | null };

export type SecondFactorResult = { ok: true; method: "totp" | "recovery"; recoveryCodesLeft?: number } | CodeRefusal;

/* ---------- Durable lockout ---------- */

/** Consecutive code attempts (login second step and Security-page checks together) before authenticator codes lock. */
export const MFA_LOCK_THRESHOLD = 10;
/** First lock lasts this long; each repeat is 4x longer (15 min, 1 h, 4 h, 16 h), capped at 24 h. */
export const MFA_LOCK_BASE_MINUTES = 15;
export const MFA_LOCK_MAX_MINUTES = 24 * 60;

type Charge = { locked: true; lockedUntil: Date | null } | { locked: false; lockedNow: boolean; lockedUntil: Date | null };

/**
 * Counts one code attempt BEFORE the code is looked at, in a single conditional UPDATE, and says whether the account
 * is (now) locked. Because the attempt is charged first and atomically, N guesses fired in parallel cannot slip past
 * the lock, and because it lives in the database it holds even when the rate limiter (Redis/Postgres buckets) is down
 * or the guesses come from many IP addresses. The attempt that reaches the threshold sets the lock and resets the
 * counter; while `mfa_locked_until` is in the future the UPDATE matches no row. Time comes from the database.
 */
async function chargeMfaAttempt(adminId: string): Promise<Charge> {
  const rows = await prisma.$queryRaw<{ failed: number; locked_until: Date | null }[]>`
    UPDATE admin_users SET
      mfa_failed_count = CASE WHEN mfa_failed_count + 1 >= ${MFA_LOCK_THRESHOLD} THEN 0 ELSE mfa_failed_count + 1 END,
      mfa_lock_level = CASE WHEN mfa_failed_count + 1 >= ${MFA_LOCK_THRESHOLD} THEN LEAST(mfa_lock_level + 1, 6) ELSE mfa_lock_level END,
      mfa_locked_until = CASE WHEN mfa_failed_count + 1 >= ${MFA_LOCK_THRESHOLD}
        THEN (now() AT TIME ZONE 'UTC') + make_interval(mins => LEAST(${MFA_LOCK_BASE_MINUTES} * power(4, mfa_lock_level), ${MFA_LOCK_MAX_MINUTES})::int)
        ELSE mfa_locked_until END
    WHERE id = ${adminId} AND (mfa_locked_until IS NULL OR mfa_locked_until <= (now() AT TIME ZONE 'UTC'))
    RETURNING mfa_failed_count AS failed, mfa_locked_until AS locked_until`;
  if (rows.length === 0) {
    const row = await prisma.adminUser.findUnique({ where: { id: adminId }, select: { mfaLockedUntil: true } });
    return { locked: true, lockedUntil: row?.mfaLockedUntil ?? null };
  }
  // The counter is only ever 0 right after this UPDATE when this very attempt tripped the lock.
  return { locked: false, lockedNow: rows[0].failed === 0, lockedUntil: rows[0].locked_until };
}

/** A success clears the counter, the lock level and any lock. */
async function resetMfaFailures(adminId: string): Promise<void> {
  await prisma.adminUser.updateMany({
    where: { id: adminId, OR: [{ mfaFailedCount: { gt: 0 } }, { mfaLockLevel: { gt: 0 } }, { mfaLockedUntil: { not: null } }] },
    data: { mfaFailedCount: 0, mfaLockLevel: 0, mfaLockedUntil: null },
  });
}

async function announceLockout(adminId: string, email: string, lockedUntil: Date | null): Promise<void> {
  await recordAudit({ adminId, email }, { action: "admin.mfa_locked", detail: { lockedUntil: lockedUntil?.toISOString() ?? null } }).catch(() => {});
  await notifyAdminSecurity(adminId, "mfa-locked", { lockedUntil });
}

/**
 * Checks what the admin typed at the second step or when confirming a sensitive change: a 6-digit authenticator code
 * or a recovery code. A recovery code is consumed by being accepted.
 *
 * Every code-shaped attempt is charged against the durable lockout first (see chargeMfaAttempt). While locked,
 * authenticator codes are refused without being looked at (so a lock reveals nothing about whether a code was right),
 * but a recovery code is still checked: an attacker who only has the password cannot shut the real admin out, because
 * recovery codes are long random strings that cannot be guessed. The `reset-2fa` command is the break-glass path.
 */
export async function verifySecondFactor(adminId: string, input: string, opts: { now?: number } = {}): Promise<SecondFactorResult> {
  const admin = await prisma.adminUser.findUnique({
    where: { id: adminId },
    select: { email: true, totpSecretEnc: true, totpEnabledAt: true, totpLastStep: true, disabledAt: true },
  });
  if (!admin || admin.disabledAt || !admin.totpEnabledAt || !admin.totpSecretEnc) return { ok: false, reason: "not-enabled" };

  const isTotp = normaliseTotpInput(input) !== null;
  const isRecovery = !isTotp && looksLikeRecoveryCode(input);
  if (!isTotp && !isRecovery) return { ok: false, reason: "invalid" }; // not a guess at either secret; nothing to count

  const charge = await chargeMfaAttempt(adminId);
  if (charge.locked && isTotp) return { ok: false, reason: "locked", lockedUntil: charge.lockedUntil };

  let result: SecondFactorResult;
  if (isTotp) {
    const r = await claimTotpCode(adminId, admin.totpSecretEnc, admin.totpLastStep, input, opts.now ?? Date.now());
    result = r.ok ? { ok: true, method: "totp" } : r;
  } else {
    const { count } = await prisma.adminRecoveryCode.updateMany({
      where: { adminId, codeHash: hashRecoveryCode(adminId, input), usedAt: null },
      data: { usedAt: new Date() },
    });
    result =
      count === 1
        ? { ok: true, method: "recovery", recoveryCodesLeft: await prisma.adminRecoveryCode.count({ where: { adminId, usedAt: null } }) }
        : { ok: false, reason: "invalid" };
  }

  if (result.ok) await resetMfaFailures(adminId);
  else if (!charge.locked && charge.lockedNow) await announceLockout(adminId, admin.email, charge.lockedUntil);
  return result;
}

export function codeFailureMessage(reason: CodeFailure | "not-enabled" | "locked", lockedUntil?: Date | null, now = Date.now()): string {
  if (reason === "replayed") return "That code was already used. Wait for the next code in your authenticator app and try again.";
  if (reason === "not-enabled") return "Two-factor authentication is not turned on for this account.";
  if (reason === "locked") {
    const mins = lockedUntil ? Math.max(1, Math.ceil((lockedUntil.getTime() - now) / 60_000)) : null;
    return `Too many incorrect codes. Authenticator codes are locked${mins ? ` for about ${mins} minute${mins === 1 ? "" : "s"}` : " for a while"}. You can still use a recovery code.`;
  }
  // One sentence for every place a code is typed: while turning two-factor on (no recovery codes exist yet), at sign-in with an
  // authenticator code and at sign-in with a recovery code. It must be true in all three, so it names neither app nor code kind.
  return "That code is not correct. Check it and try again.";
}

/* ---------- Enrollment ---------- */

async function replaceRecoveryCodes(tx: Prisma.TransactionClient, adminId: string): Promise<string[]> {
  const codes = generateRecoveryCodes();
  await tx.adminRecoveryCode.deleteMany({ where: { adminId } });
  await tx.adminRecoveryCode.createMany({ data: codes.map((code) => ({ adminId, codeHash: hashRecoveryCode(adminId, code) })) });
  return codes;
}

export interface TotpEnrollment {
  /** Base32 key for manual entry. */
  secret: string;
  /** `otpauth://` URI for an authenticator app. */
  uri: string;
}

/**
 * Generates a fresh secret and stores it (encrypted) as pending. Calling it again before confirming replaces the
 * pending secret. Refused once 2FA is on: turn it off first.
 */
export async function startTotpEnrollment(adminId: string): Promise<TotpEnrollment> {
  const admin = await prisma.adminUser.findUnique({ where: { id: adminId }, select: { email: true, totpEnabledAt: true } });
  if (!admin) throw new MfaError("Administrator not found", 404);
  if (admin.totpEnabledAt) throw new MfaError("Two-factor authentication is already on. Turn it off first to enrol a different device.", 409);

  const secret = generateTotpSecret();
  const { count } = await prisma.adminUser.updateMany({
    where: { id: adminId, totpEnabledAt: null },
    data: { totpSecretEnc: encryptSecret(secret, totpAad(adminId)), totpLastStep: null },
  });
  if (count !== 1) throw new MfaError("Two-factor authentication is already on.", 409);
  return { secret, uri: otpauthUri({ secret, account: admin.email, issuer: TOTP_ISSUER }) };
}

export type EnrollmentResult = { ok: true; recoveryCodes: string[] } | { ok: false; reason: CodeFailure | "no-pending" };

/**
 * Confirms the first code from the authenticator and turns 2FA on, in one transaction: the secret becomes active, the
 * recovery codes are generated (returned here, shown once), the session that enrolled becomes MFA-verified, and every
 * other session of the admin is signed out (they were created without a second factor).
 */
export async function confirmTotpEnrollment(adminId: string, input: string, sessionId: string | null, now = Date.now()): Promise<EnrollmentResult> {
  const admin = await prisma.adminUser.findUnique({ where: { id: adminId }, select: { totpSecretEnc: true, totpEnabledAt: true } });
  if (!admin?.totpSecretEnc || admin.totpEnabledAt) return { ok: false, reason: "no-pending" };

  const check = verifyTotp(decryptSecret(admin.totpSecretEnc, totpAad(adminId)), input, { now, lastStep: null });
  if (!check.ok) return check;

  return prisma.$transaction(async (tx) => {
    const { count } = await tx.adminUser.updateMany({
      where: { id: adminId, totpEnabledAt: null, totpSecretEnc: admin.totpSecretEnc },
      data: { totpEnabledAt: new Date(now), totpLastStep: check.step },
    });
    if (count !== 1) return { ok: false as const, reason: "no-pending" as const };
    const recoveryCodes = await replaceRecoveryCodes(tx, adminId);
    if (sessionId) {
      await tx.adminSession.updateMany({ where: { id: sessionId, adminId }, data: { mfaVerifiedAt: new Date(now) } });
    }
    await tx.adminSession.deleteMany({ where: { adminId, ...(sessionId ? { id: { not: sessionId } } : {}) } });
    return { ok: true as const, recoveryCodes };
  }, { timeout: 20_000 }); // several round trips; a hosted pooler can be slow
}

export type ChangeResult<T extends object = object> = ({ ok: true } & T) | CodeRefusal;

/** New recovery codes (the old ones stop working). Needs a fresh valid code, so a hijacked session cannot do it. */
export async function regenerateRecoveryCodes(adminId: string, input: string, opts: { now?: number } = {}): Promise<ChangeResult<{ recoveryCodes: string[] }>> {
  const check = await verifySecondFactor(adminId, input, opts);
  if (!check.ok) return check;
  const recoveryCodes = await prisma.$transaction((tx) => replaceRecoveryCodes(tx, adminId), { timeout: 20_000 });
  return { ok: true, recoveryCodes };
}

/**
 * Turns 2FA off. Needs a fresh valid code. Recovery codes are deleted and every session EXCEPT `keepSessionId` (the
 * one making the change) is signed out: otherwise another session of the same admin would be left logged in without
 * a second factor (when 2FA is required, in the "must enrol" state) and could enrol its own authenticator.
 * The surviving session loses its MFA mark.
 */
export async function disableTotp(adminId: string, input: string, opts: { now?: number; keepSessionId?: string | null } = {}): Promise<ChangeResult> {
  const check = await verifySecondFactor(adminId, input, opts);
  if (!check.ok) return check;
  await prisma.$transaction(
    [
      prisma.adminUser.update({
        where: { id: adminId },
        data: { totpSecretEnc: null, totpEnabledAt: null, totpLastStep: null, mfaFailedCount: 0, mfaLockLevel: 0, mfaLockedUntil: null },
      }),
      prisma.adminRecoveryCode.deleteMany({ where: { adminId } }),
      prisma.adminSession.deleteMany({ where: { adminId, ...(opts.keepSessionId ? { id: { not: opts.keepSessionId } } : {}) } }),
      prisma.adminSession.updateMany({ where: { adminId }, data: { mfaVerifiedAt: null } }),
    ],
  );
  return { ok: true };
}

export interface MfaStatus {
  enabled: boolean;
  enabledAt: Date | null;
  recoveryCodesLeft: number;
}

export async function getMfaStatus(adminId: string): Promise<MfaStatus> {
  const [admin, left] = await Promise.all([
    prisma.adminUser.findUnique({ where: { id: adminId }, select: { totpEnabledAt: true } }),
    prisma.adminRecoveryCode.count({ where: { adminId, usedAt: null } }),
  ]);
  const enabledAt = admin?.totpEnabledAt ?? null;
  return { enabled: enabledAt != null, enabledAt, recoveryCodesLeft: enabledAt ? left : 0 };
}
