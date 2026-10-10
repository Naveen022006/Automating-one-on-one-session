import type { Prisma } from "@/generated/prisma/client";
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
 */

export const PENDING_TOKEN_PURPOSE = "admin-2fa-pending";
export const PENDING_TOKEN_TTL_SEC = 300;
export const TOTP_ISSUER = "Session Automation Admin";

const totpAad = (adminId: string) => `admin-totp:${adminId}`;

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

export type SecondFactorResult =
  | { ok: true; method: "totp" | "recovery"; recoveryCodesLeft?: number }
  | { ok: false; reason: CodeFailure | "not-enabled" };

/**
 * Checks what the admin typed at the second step or when confirming a sensitive change: a 6-digit authenticator code
 * or a recovery code. A recovery code is consumed by being accepted.
 */
export async function verifySecondFactor(adminId: string, input: string, opts: { now?: number } = {}): Promise<SecondFactorResult> {
  const admin = await prisma.adminUser.findUnique({
    where: { id: adminId },
    select: { totpSecretEnc: true, totpEnabledAt: true, totpLastStep: true, disabledAt: true },
  });
  if (!admin || admin.disabledAt || !admin.totpEnabledAt || !admin.totpSecretEnc) return { ok: false, reason: "not-enabled" };

  if (normaliseTotpInput(input)) {
    const r = await claimTotpCode(adminId, admin.totpSecretEnc, admin.totpLastStep, input, opts.now ?? Date.now());
    return r.ok ? { ok: true, method: "totp" } : r;
  }
  if (looksLikeRecoveryCode(input)) {
    const { count } = await prisma.adminRecoveryCode.updateMany({
      where: { adminId, codeHash: hashRecoveryCode(adminId, input), usedAt: null },
      data: { usedAt: new Date() },
    });
    if (count !== 1) return { ok: false, reason: "invalid" };
    return { ok: true, method: "recovery", recoveryCodesLeft: await prisma.adminRecoveryCode.count({ where: { adminId, usedAt: null } }) };
  }
  return { ok: false, reason: "invalid" };
}

export function codeFailureMessage(reason: CodeFailure | "not-enabled"): string {
  if (reason === "replayed") return "That code was already used. Wait for the next code in your authenticator app and try again.";
  if (reason === "not-enabled") return "Two-factor authentication is not turned on for this account.";
  return "That code is not correct. Check the code in your authenticator app, or use a recovery code.";
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
  });
}

export type ChangeResult<T extends object = object> = ({ ok: true } & T) | { ok: false; reason: CodeFailure | "not-enabled" };

/** New recovery codes (the old ones stop working). Needs a fresh valid code, so a hijacked session cannot do it. */
export async function regenerateRecoveryCodes(adminId: string, input: string, opts: { now?: number } = {}): Promise<ChangeResult<{ recoveryCodes: string[] }>> {
  const check = await verifySecondFactor(adminId, input, opts);
  if (!check.ok) return check;
  const recoveryCodes = await prisma.$transaction((tx) => replaceRecoveryCodes(tx, adminId));
  return { ok: true, recoveryCodes };
}

/** Turns 2FA off. Needs a fresh valid code. Sessions lose their MFA mark; recovery codes are deleted. */
export async function disableTotp(adminId: string, input: string, opts: { now?: number } = {}): Promise<ChangeResult> {
  const check = await verifySecondFactor(adminId, input, opts);
  if (!check.ok) return check;
  await prisma.$transaction([
    prisma.adminUser.update({ where: { id: adminId }, data: { totpSecretEnc: null, totpEnabledAt: null, totpLastStep: null } }),
    prisma.adminRecoveryCode.deleteMany({ where: { adminId } }),
    prisma.adminSession.updateMany({ where: { adminId }, data: { mfaVerifiedAt: null } }),
  ]);
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
