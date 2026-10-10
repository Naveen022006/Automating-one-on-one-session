// Integration test: needs a migrated Postgres at DATABASE_URL plus TOKEN_ENCRYPTION_KEY and APP_SECRET (skipped otherwise).
// Enrollment, replay protection, recovery codes, disabling, the pending sign-in token and the two-step sign-in.
// The tests are ordered and share state; every code check takes an explicit `now` so no test depends on the wall clock.
import "dotenv/config";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import {
  confirmTotpEnrollment,
  disableTotp,
  getMfaStatus,
  issueAdminPendingToken,
  MfaError,
  PENDING_TOKEN_PURPOSE,
  regenerateRecoveryCodes,
  resolveAdminPending,
  startTotpEnrollment,
  verifySecondFactor,
} from "../lib/admin/mfa";
import {
  adminApiGate,
  adminPasswordFingerprint,
  authenticateAdmin,
  createAdminSession,
  mfaGateStatus,
  resolveAdminSession,
} from "../lib/admin/session";
import { hashRecoveryCode, timeStepOf, totpAt } from "../lib/admin/totp";
import { hashPassword } from "../lib/auth/password";
import { decryptSecret } from "../lib/crypto";
import { prisma } from "../lib/db";
import { signToken } from "../lib/signing";

const skip = process.env.DATABASE_URL && process.env.TOKEN_ENCRYPTION_KEY && process.env.APP_SECRET ? false : "DATABASE_URL / TOKEN_ENCRYPTION_KEY / APP_SECRET not set";
const run = Date.now();
const emailA = `mfa-a-${run}@example.com`;
const emailB = `mfa-b-${run}@example.com`;
const PASSWORD = "correct-horse-battery-9";
let A: string;
let B: string;

// State carried between the ordered tests below. Admin A's clock starts at T0, admin B's five minutes later.
const T0 = Date.now();
const T0B = T0 + 5 * 60_000;
const STEP = timeStepOf(T0);
const STEP_B = timeStepOf(T0B);
let secretA = "";
let secretB = "";
let recoveryA: string[] = [];

const at = (secret: string, step: number) => totpAt(secret, step * 30_000);
/** A 6-digit code that is not valid at `now` (outside the +-1 window), for failure paths. */
function wrongCode(secret: string, now: number): string {
  const valid = new Set([-1, 0, 1].map((d) => at(secret, timeStepOf(now) + d)));
  for (let n = 0; n < 1000; n++) {
    const c = String(n).padStart(6, "0");
    if (!valid.has(c)) return c;
  }
  throw new Error("unreachable");
}

before(async () => {
  if (skip) return;
  const hash = await hashPassword(PASSWORD);
  A = (await prisma.adminUser.create({ data: { email: emailA, name: "MFA A", passwordHash: hash } })).id;
  B = (await prisma.adminUser.create({ data: { email: emailB, name: "MFA B", passwordHash: hash } })).id;
});

after(async () => {
  if (!skip && A) {
    await prisma.adminAuditLog.deleteMany({ where: { adminEmail: { in: [emailA, emailB] } } });
    await prisma.adminUser.deleteMany({ where: { id: { in: [A, B] } } });
  }
  await prisma.$disconnect();
});

test("enrollment: the secret is stored encrypted and bound to the admin, and only counts after a valid first code", { skip }, async () => {
  const first = await startTotpEnrollment(A);
  assert.match(first.secret, /^[A-Z2-7]{32}$/);
  assert.match(first.uri, /^otpauth:\/\/totp\//);

  const row = await prisma.adminUser.findUniqueOrThrow({ where: { id: A } });
  assert.ok(row.totpSecretEnc && !row.totpSecretEnc.includes(first.secret), "the plain secret is not stored");
  assert.equal(decryptSecret(row.totpSecretEnc, `admin-totp:${A}`), first.secret);
  assert.throws(() => decryptSecret(row.totpSecretEnc!, `admin-totp:${B}`), "the ciphertext is bound to this admin (aad)");
  assert.equal(row.totpEnabledAt, null, "a pending secret is not 2FA yet");

  // A pending secret does not turn on the second step at sign-in, and cannot verify anything.
  assert.equal((await authenticateAdmin(emailA, PASSWORD))?.totpEnabled, false);
  assert.deepEqual(await verifySecondFactor(A, at(first.secret, STEP), { now: T0 }), { ok: false, reason: "not-enabled" });

  // Starting again replaces the pending secret.
  const second = await startTotpEnrollment(A);
  assert.notEqual(second.secret, first.secret);
  secretA = second.secret;

  const keep = (await resolveAdminSession(await createAdminSession(A)))!;
  const other = await createAdminSession(A);
  assert.equal(keep.mfaVerified, false, "a password-only session is not MFA verified");

  // The old secret's code and a wrong code are rejected and leave 2FA off.
  assert.deepEqual(await confirmTotpEnrollment(A, at(first.secret, STEP), keep.sessionId, T0), { ok: false, reason: "invalid" });
  assert.deepEqual(await confirmTotpEnrollment(A, wrongCode(secretA, T0), keep.sessionId, T0), { ok: false, reason: "invalid" });
  assert.equal((await getMfaStatus(A)).enabled, false);

  const done = await confirmTotpEnrollment(A, at(secretA, STEP), keep.sessionId, T0);
  assert.ok(done.ok);
  if (!done.ok) return;
  recoveryA = done.recoveryCodes;
  assert.equal(recoveryA.length, 10);
  assert.equal(new Set(recoveryA).size, 10);

  const stored = await prisma.adminRecoveryCode.findMany({ where: { adminId: A } });
  assert.equal(stored.length, 10);
  for (const code of recoveryA) {
    assert.ok(stored.every((s) => s.codeHash !== code), "plain codes are not stored");
    assert.ok(stored.some((s) => s.codeHash === hashRecoveryCode(A, code) && s.usedAt === null), "each code is stored as its SHA-256");
  }

  const enabled = await prisma.adminUser.findUniqueOrThrow({ where: { id: A } });
  assert.ok(enabled.totpEnabledAt);
  assert.equal(enabled.totpLastStep, STEP, "the enrollment code's step is recorded, so it cannot be replayed");
  assert.equal(await resolveAdminSession(other), null, "other sessions were created without a second factor and are signed out");
  const mine = await prisma.adminSession.findUniqueOrThrow({ where: { id: keep.sessionId } });
  assert.ok(mine.mfaVerifiedAt, "the enrolling session counts as verified");
  assert.deepEqual(await getMfaStatus(A), { enabled: true, enabledAt: enabled.totpEnabledAt, recoveryCodesLeft: 10 });

  await assert.rejects(startTotpEnrollment(A), (e: unknown) => e instanceof MfaError && e.status === 409, "cannot re-enrol while 2FA is on");
});

test("second step: a code works once, older steps are refused, a later step works, two at once race to one winner", { skip }, async () => {
  // The code used to enrol is spent, and so is anything older.
  assert.deepEqual(await verifySecondFactor(A, at(secretA, STEP), { now: T0 }), { ok: false, reason: "replayed" });
  assert.deepEqual(await verifySecondFactor(A, at(secretA, STEP - 1), { now: T0 }), { ok: false, reason: "replayed" });

  const t1 = T0 + 30_000;
  assert.deepEqual(await verifySecondFactor(A, at(secretA, STEP + 1), { now: t1 }), { ok: true, method: "totp" });
  assert.deepEqual(await verifySecondFactor(A, at(secretA, STEP + 1), { now: t1 }), { ok: false, reason: "replayed" }, "the same code twice");
  assert.deepEqual(await verifySecondFactor(A, wrongCode(secretA, t1), { now: t1 }), { ok: false, reason: "invalid" });
  assert.deepEqual(await verifySecondFactor(A, at(secretA, STEP + 4), { now: t1 }), { ok: false, reason: "invalid" }, "outside the +-1 window");
  assert.deepEqual(await verifySecondFactor(A, "12 34", { now: t1 }), { ok: false, reason: "invalid" });

  const t2 = T0 + 60_000;
  const code = at(secretA, STEP + 2);
  const raced = await Promise.all([verifySecondFactor(A, code, { now: t2 }), verifySecondFactor(A, code, { now: t2 })]);
  assert.equal(raced.filter((r) => r.ok).length, 1, "exactly one of two simultaneous requests with the same code succeeds");
  assert.equal(raced.filter((r) => !r.ok && r.reason === "replayed").length, 1);
  assert.equal((await prisma.adminUser.findUniqueOrThrow({ where: { id: A } })).totpLastStep, STEP + 2);
});

test("recovery codes are single use, forgiving about case and spacing, and belong to one admin", { skip }, async () => {
  assert.deepEqual(await verifySecondFactor(A, recoveryA[0]), { ok: true, method: "recovery", recoveryCodesLeft: 9 });
  assert.deepEqual(await verifySecondFactor(A, recoveryA[0]), { ok: false, reason: "invalid" }, "a used code is dead");

  const messy = recoveryA[1].toUpperCase().replace("-", "  ");
  assert.deepEqual(await verifySecondFactor(A, messy), { ok: true, method: "recovery", recoveryCodesLeft: 8 });
  assert.deepEqual(await verifySecondFactor(A, "zzzzzz-zzzzzz"), { ok: false, reason: "invalid" });

  // The same code twice at once: one wins.
  const raced = await Promise.all([verifySecondFactor(A, recoveryA[2]), verifySecondFactor(A, recoveryA[2])]);
  assert.equal(raced.filter((r) => r.ok).length, 1, "a recovery code cannot be spent twice concurrently");
  assert.equal(await prisma.adminRecoveryCode.count({ where: { adminId: A, usedAt: null } }), 7);

  // Admin B enrols (on its own clock) and cannot use A's codes.
  secretB = (await startTotpEnrollment(B)).secret;
  const sessionB = (await resolveAdminSession(await createAdminSession(B)))!;
  assert.ok((await confirmTotpEnrollment(B, at(secretB, STEP_B), sessionB.sessionId, T0B)).ok);
  assert.deepEqual(await verifySecondFactor(B, recoveryA[3]), { ok: false, reason: "invalid" }, "A's recovery code does not work for B");
  assert.equal(await prisma.adminRecoveryCode.count({ where: { adminId: A, usedAt: null } }), 7, "A's unused codes are untouched");
});

test("regenerating recovery codes needs a fresh valid code and retires the old set", { skip }, async () => {
  const now = T0 + 90_000; // time step STEP + 3
  assert.deepEqual(await regenerateRecoveryCodes(A, wrongCode(secretA, now), { now }), { ok: false, reason: "invalid" });
  assert.equal(await prisma.adminRecoveryCode.count({ where: { adminId: A } }), 10, "nothing changed after a failed attempt");
  assert.deepEqual(await verifySecondFactor(A, recoveryA[5]), { ok: true, method: "recovery", recoveryCodesLeft: 6 }, "old codes still work until replaced");

  const fresh = await regenerateRecoveryCodes(A, at(secretA, STEP + 3), { now });
  assert.ok(fresh.ok);
  if (!fresh.ok) return;
  assert.equal(fresh.recoveryCodes.length, 10);
  assert.equal(await prisma.adminRecoveryCode.count({ where: { adminId: A } }), 10);
  assert.equal(await prisma.adminRecoveryCode.count({ where: { adminId: A, usedAt: null } }), 10, "the new set is all unused");
  assert.deepEqual(await regenerateRecoveryCodes(A, at(secretA, STEP + 3), { now }), { ok: false, reason: "replayed" }, "the code that authorised it is spent");
  assert.deepEqual(await verifySecondFactor(A, recoveryA[6]), { ok: false, reason: "invalid" }, "old codes stopped working");
  assert.equal((await verifySecondFactor(A, fresh.recoveryCodes[0])).ok, true, "new codes work");
});

test("pending sign-in token: bound to the admin, signed, short-lived and void after a password change", { skip }, async () => {
  const rowB = await prisma.adminUser.findUniqueOrThrow({ where: { id: B } });
  const login = await authenticateAdmin(emailB, PASSWORD);
  assert.equal(login?.totpEnabled, true, "password OK + 2FA on => a second step is due");
  assert.equal(login?.passwordFingerprint, adminPasswordFingerprint(rowB.passwordHash));

  const token = issueAdminPendingToken(B, login!.passwordFingerprint);
  assert.deepEqual(await resolveAdminPending(token), { adminId: B, email: emailB });

  // Tampering: payload swapped to another admin, signature damaged, truncated, empty.
  const [body, sig] = token.split(".");
  const forgedBody = Buffer.from(JSON.stringify({ adminId: A, pw: login!.passwordFingerprint, exp: Math.floor(Date.now() / 1000) + 300 })).toString("base64url");
  assert.equal(await resolveAdminPending(`${forgedBody}.${sig}`), null, "payload naming another admin, with B's signature");
  const damaged = `${sig[0] === "A" ? "B" : "A"}${sig.slice(1)}`;
  assert.equal(await resolveAdminPending(`${body}.${damaged}`), null, "damaged signature");
  assert.equal(await resolveAdminPending(body), null);
  assert.equal(await resolveAdminPending(""), null);
  assert.equal(await resolveAdminPending(null), null);

  // Expired, wrong purpose, missing fields.
  assert.equal(await resolveAdminPending(issueAdminPendingToken(B, login!.passwordFingerprint, -1)), null, "expired");
  assert.equal(await resolveAdminPending(signToken("admin-session", { adminId: B, pw: login!.passwordFingerprint }, 300)), null, "token minted for another purpose");
  assert.equal(await resolveAdminPending(signToken(PENDING_TOKEN_PURPOSE, { adminId: B }, 300)), null, "no password fingerprint");

  // Bound to the admin: A's token names A, so B's authenticator code does not complete it.
  const rowA = await prisma.adminUser.findUniqueOrThrow({ where: { id: A } });
  const pendingA = await resolveAdminPending(issueAdminPendingToken(A, adminPasswordFingerprint(rowA.passwordHash)));
  assert.equal(pendingA?.adminId, A);
  const now = T0B + 60_000;
  assert.deepEqual(await verifySecondFactor(pendingA!.adminId, at(secretB, timeStepOf(now)), { now }), { ok: false, reason: "invalid" });

  // A password change after the password step voids the token.
  await prisma.adminUser.update({ where: { id: B }, data: { passwordHash: await hashPassword("a-different-passphrase-42") } });
  assert.equal(await resolveAdminPending(token), null);
  await prisma.adminUser.update({ where: { id: B }, data: { passwordHash: rowB.passwordHash } });
  assert.ok(await resolveAdminPending(token), "restored password => the same token is good again");

  // A disabled admin cannot complete sign-in either.
  await prisma.adminUser.update({ where: { id: B }, data: { disabledAt: new Date() } });
  assert.equal(await resolveAdminPending(token), null);
  await prisma.adminUser.update({ where: { id: B }, data: { disabledAt: null } });
});

test("two-step sign-in end to end: only the second factor produces an MFA-verified session", { skip }, async () => {
  const login = (await authenticateAdmin(emailB, PASSWORD))!;
  assert.equal(login.totpEnabled, true);
  assert.equal(await prisma.adminSession.count({ where: { adminId: B } }), 1, "only the enrolment session exists: the password step created none");
  await prisma.adminUser.update({ where: { id: B }, data: { lastLoginAt: null } });

  const pending = (await resolveAdminPending(issueAdminPendingToken(B, login.passwordFingerprint)))!;
  const now = T0B + 30_000;
  assert.deepEqual(await verifySecondFactor(pending.adminId, wrongCode(secretB, now), { now }), { ok: false, reason: "invalid" });
  assert.equal(await prisma.adminSession.count({ where: { adminId: B } }), 1, "a wrong code creates no session");
  assert.deepEqual(await verifySecondFactor(pending.adminId, at(secretB, STEP_B + 1), { now }), { ok: true, method: "totp" });

  const token = await createAdminSession(B, { ip: "127.0.0.1" }, { mfaVerified: true });
  const ctx = await resolveAdminSession(token);
  assert.equal(ctx?.mfaVerified, true);
  assert.equal(ctx?.totpEnabled, true);
  assert.equal(mfaGateStatus(ctx!, {} as NodeJS.ProcessEnv), "ok");
  assert.ok((await prisma.adminUser.findUniqueOrThrow({ where: { id: B } })).lastLoginAt, "lastLoginAt is set when the session is created");

  // A session created from the password alone is not verified, and the gate says so.
  const pwOnly = await resolveAdminSession(await createAdminSession(B));
  assert.equal(pwOnly?.mfaVerified, false);
  assert.equal(mfaGateStatus(pwOnly!, {} as NodeJS.ProcessEnv), "verify");
});

test("disabling 2FA needs a fresh valid code and clears the secret, the recovery codes and the sessions' MFA mark", { skip }, async () => {
  const now = T0 + 120_000; // time step STEP + 4
  assert.deepEqual(await disableTotp(A, wrongCode(secretA, now), { now }), { ok: false, reason: "invalid" });
  assert.deepEqual(await disableTotp(A, "not a code", { now }), { ok: false, reason: "invalid" });
  assert.deepEqual(await disableTotp(A, at(secretA, STEP + 3), { now }), { ok: false, reason: "replayed" }, "a code that was already used cannot authorise it");
  assert.equal((await getMfaStatus(A)).enabled, true, "still on after the failed attempts");

  const sessionToken = await createAdminSession(A, {}, { mfaVerified: true });
  assert.equal((await resolveAdminSession(sessionToken))?.mfaVerified, true);
  assert.deepEqual(await disableTotp(A, at(secretA, STEP + 4), { now }), { ok: true });

  const row = await prisma.adminUser.findUniqueOrThrow({ where: { id: A } });
  assert.equal(row.totpSecretEnc, null);
  assert.equal(row.totpEnabledAt, null);
  assert.equal(row.totpLastStep, null);
  assert.equal(await prisma.adminRecoveryCode.count({ where: { adminId: A } }), 0);
  const ctx = await resolveAdminSession(sessionToken);
  assert.equal(ctx?.mfaVerified, false);
  assert.equal(ctx?.totpEnabled, false);
  assert.equal((await authenticateAdmin(emailA, PASSWORD))?.totpEnabled, false, "sign-in is password-only again");
  assert.equal((await verifySecondFactor(A, at(secretA, STEP + 5), { now: T0 + 150_000 })).ok, false);
  assert.equal(await resolveAdminPending(issueAdminPendingToken(A, adminPasswordFingerprint(row.passwordHash))), null, "no pending sign-in for an admin without 2FA");

  // Enrolling again starts from a clean slate.
  const again = await startTotpEnrollment(A);
  assert.notEqual(again.secret, secretA);
  assert.equal((await prisma.adminUser.findUniqueOrThrow({ where: { id: A } })).totpLastStep, null);
});

test("the API gate: enrol-first, verify-first, and open", () => {
  const prod = { NODE_ENV: "production" } as unknown as NodeJS.ProcessEnv;
  const dev = { NODE_ENV: "development" } as unknown as NodeJS.ProcessEnv;
  const noMfa = { totpEnabled: false, mfaVerified: false };
  const staleSession = { totpEnabled: true, mfaVerified: false };
  const verified = { totpEnabled: true, mfaVerified: true };

  assert.equal(mfaGateStatus(noMfa, prod), "enroll");
  assert.equal(mfaGateStatus(noMfa, dev), "ok");
  assert.equal(mfaGateStatus(staleSession, dev), "verify");
  assert.equal(mfaGateStatus(verified, prod), "ok");

  assert.equal(adminApiGate(noMfa, {}, prod)?.status, 403, "required but not enrolled: every route is closed");
  assert.equal(adminApiGate(noMfa, { mfa: true }, prod)?.status, 403);
  assert.equal(adminApiGate(noMfa, { allowEnrollment: true }, prod), null, "...except the enrollment routes");
  assert.equal(adminApiGate(noMfa, { mfa: true }, dev), null, "not required and not enabled: nothing to enforce");
  assert.equal(adminApiGate(staleSession, {}, dev), null, "a plain admin route does not need the MFA mark");
  assert.equal(adminApiGate(staleSession, { mfa: true }, dev)?.status, 403, "a sensitive route does");
  assert.equal(adminApiGate(verified, { mfa: true }, prod), null);
});

test("the gate's 403 body says MFA is required and what to do", async () => {
  const enroll = adminApiGate({ totpEnabled: false, mfaVerified: false }, {}, { NODE_ENV: "production" } as unknown as NodeJS.ProcessEnv)!;
  assert.deepEqual(await enroll.json(), {
    error: "Two-factor authentication is required. Set it up under Security before using the admin console.",
    mfaRequired: true,
    mfaAction: "enroll",
  });
  const verify = adminApiGate({ totpEnabled: true, mfaVerified: false }, { mfa: true }, {} as NodeJS.ProcessEnv)!;
  const body = await verify.json();
  assert.equal(body.mfaRequired, true);
  assert.equal(body.mfaAction, "verify");
  assert.match(body.error, /Sign out and sign in again/);
});
