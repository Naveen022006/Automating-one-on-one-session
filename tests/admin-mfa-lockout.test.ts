// Integration test (needs DATABASE_URL, TOKEN_ENCRYPTION_KEY, APP_SECRET; skipped otherwise): the durable code-guessing
// lockout that does not depend on the rate limiter, its email/audit/notice, the break-glass `--reset-2fa` command and
// the four-eyes split-payout rule. No limiter is involved anywhere in this file.
import "dotenv/config";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { after, before, test } from "node:test";
import {
  codeFailureMessage,
  confirmTotpEnrollment,
  disableTotp,
  MFA_LOCK_THRESHOLD,
  regenerateRecoveryCodes,
  startTotpEnrollment,
  verifySecondFactor,
} from "../lib/admin/mfa";
import { createAdminSession, resolveAdminSession } from "../lib/admin/session";
import { timeStepOf, totpAt } from "../lib/admin/totp";
import { hashPassword } from "../lib/auth/password";
import { prisma } from "../lib/db";
import { setEmailSender } from "../lib/email";
import type { OutgoingEmail } from "../lib/email/providers";

const skip = process.env.DATABASE_URL && process.env.TOKEN_ENCRYPTION_KEY && process.env.APP_SECRET ? false : "DATABASE_URL / TOKEN_ENCRYPTION_KEY / APP_SECRET not set";
const run = Date.now();
const email = `lock-${run}@example.com`;
const T0 = Date.now();
const STEP = timeStepOf(T0);
let L = "";
let secret = "";
let recovery: string[] = [];
const sent: OutgoingEmail[] = [];
let nextStep = STEP; // codes handed out so far are at steps <= nextStep

const at = (step: number) => totpAt(secret, step * 30_000);
/** A wrong 6-digit code (not valid anywhere in the +-1 window around `now`). */
function wrong(now: number): string {
  const valid = new Set([-1, 0, 1].map((d) => at(timeStepOf(now) + d)));
  for (let n = 0; n < 1000; n++) {
    const c = String(n).padStart(6, "0");
    if (!valid.has(c)) return c;
  }
  throw new Error("unreachable");
}
/** The next never-used correct code and the clock to present it at. */
function freshCode(): { code: string; now: number } {
  nextStep += 1;
  return { code: at(nextStep), now: nextStep * 30_000 };
}
const lockState = () => prisma.adminUser.findUniqueOrThrow({ where: { id: L }, select: { mfaFailedCount: true, mfaLockLevel: true, mfaLockedUntil: true, totpLastStep: true } });
const lockEmails = () => sent.filter((e) => e.to.email === email && /locked/i.test(e.subject));
const minutesFromNow = (d: Date | null) => (d ? (d.getTime() - Date.now()) / 60_000 : NaN);

async function failTimes(n: number) {
  const results = [];
  for (let i = 0; i < n; i++) results.push(await verifySecondFactor(L, wrong(T0), { now: T0 }));
  return results;
}
async function clearLock() {
  await prisma.adminUser.update({ where: { id: L }, data: { mfaFailedCount: 0, mfaLockLevel: 0, mfaLockedUntil: null } });
}

before(async () => {
  if (skip) return;
  setEmailSender(async (e) => {
    sent.push(e);
    return { providerMessageId: null };
  });
  L = (await prisma.adminUser.create({ data: { email, name: "Lock <b>Test</b>", passwordHash: await hashPassword("correct-horse-battery-9") } })).id;
  secret = (await startTotpEnrollment(L)).secret;
  const done = await confirmTotpEnrollment(L, at(STEP), null, T0);
  assert.ok(done.ok);
  if (done.ok) recovery = done.recoveryCodes;
});

after(async () => {
  if (!skip && L) {
    await prisma.adminAuditLog.deleteMany({ where: { OR: [{ adminEmail: email }, { adminEmail: "cli", targetId: L }] } });
    await prisma.adminUser.deleteMany({ where: { id: L } });
  }
  await prisma.$disconnect();
});

test("ten code attempts in a row lock authenticator codes, even the correct one; the admin is emailed, audited and reported", { skip }, async () => {
  const warns: string[] = [];
  const realWarn = console.warn;
  console.warn = (...args: unknown[]) => void warns.push(args.join(" "));
  try {
    const first = await failTimes(MFA_LOCK_THRESHOLD - 1);
    assert.ok(first.every((r) => !r.ok && r.reason === "invalid"));
    assert.equal((await lockState()).mfaFailedCount, MFA_LOCK_THRESHOLD - 1);
    assert.equal(lockEmails().length, 0, "not locked yet, nobody emailed");

    const tenth = await verifySecondFactor(L, wrong(T0), { now: T0 });
    assert.deepEqual(tenth, { ok: false, reason: "invalid" }, "the attempt that trips the lock is itself just a wrong code");
    const locked = await lockState();
    assert.equal(locked.mfaFailedCount, 0, "the counter restarts after a lock");
    assert.equal(locked.mfaLockLevel, 1);
    const minutes = minutesFromNow(locked.mfaLockedUntil);
    assert.ok(minutes > 14 && minutes <= 15.1, `first lock is 15 minutes (got ${minutes.toFixed(2)})`);

    // Exactly one email, escaped, and one operator notice and one audit row.
    assert.equal(lockEmails().length, 1);
    assert.ok(!lockEmails()[0].html.includes("<b>Test</b>"), "the admin's name is HTML-escaped in the email");
    assert.match(lockEmails()[0].text, /recovery code/i);
    assert.ok(warns.some((w) => w.includes("locked after repeated failures") && w.includes("admin-mfa")), "reportNotice warned the operator");
    assert.equal(await prisma.adminAuditLog.count({ where: { adminEmail: email, action: "admin.mfa_locked" } }), 1);

    // While locked the CORRECT code is refused without being looked at: its time step stays unused.
    const lastStepBefore = (await lockState()).totpLastStep;
    const { code, now } = freshCode();
    const refused = await verifySecondFactor(L, code, { now });
    assert.equal(refused.ok, false);
    assert.ok(!refused.ok && refused.reason === "locked" && refused.lockedUntil instanceof Date);
    assert.equal((await lockState()).totpLastStep, lastStepBefore, "a locked attempt does not consume the code");
    assert.match(codeFailureMessage("locked", locked.mfaLockedUntil), /locked for about 1[456] minutes/);
    assert.equal(lockEmails().length, 1, "refused attempts do not send more email");

    // ...but a recovery code still gets in (break-glass for the real admin) and clears the lock.
    assert.deepEqual(await verifySecondFactor(L, recovery[0]), { ok: true, method: "recovery", recoveryCodesLeft: 9 });
    assert.deepEqual(await lockState(), { mfaFailedCount: 0, mfaLockLevel: 0, mfaLockedUntil: null, totpLastStep: lastStepBefore });
    // The authenticator works again straight away.
    assert.deepEqual(await verifySecondFactor(L, code, { now }), { ok: true, method: "totp" });
  } finally {
    console.warn = realWarn;
  }
});

test("a success resets the counter, so scattered mistakes never add up to a lock", { skip }, async () => {
  await clearLock();
  await failTimes(MFA_LOCK_THRESHOLD - 1);
  assert.equal((await lockState()).mfaFailedCount, MFA_LOCK_THRESHOLD - 1);
  const ok = freshCode();
  assert.equal((await verifySecondFactor(L, ok.code, { now: ok.now })).ok, true);
  assert.equal((await lockState()).mfaFailedCount, 0, "reset on success");
  await failTimes(MFA_LOCK_THRESHOLD - 1);
  const s = await lockState();
  assert.equal(s.mfaLockedUntil, null, "9 + 9 mistakes with a success between never lock");
  assert.equal(s.mfaFailedCount, MFA_LOCK_THRESHOLD - 1);
  const again = freshCode();
  assert.equal((await verifySecondFactor(L, again.code, { now: again.now })).ok, true);
});

test("input that is not shaped like a code is not counted; wrong recovery codes during a lock change nothing", { skip }, async () => {
  await clearLock();
  for (let i = 0; i < 20; i++) assert.deepEqual(await verifySecondFactor(L, i % 2 ? "12 34" : "hello", { now: T0 }), { ok: false, reason: "invalid" });
  assert.equal((await lockState()).mfaFailedCount, 0);

  await prisma.adminUser.update({ where: { id: L }, data: { mfaLockedUntil: new Date(Date.now() + 600_000) } });
  assert.deepEqual(await verifySecondFactor(L, "zzzzzz-zzzzzz"), { ok: false, reason: "invalid" });
  assert.equal((await lockState()).mfaFailedCount, 0, "guessing a recovery code while locked is not counted (and cannot succeed)");
  await clearLock();
});

test("each repeat lock lasts four times longer (15 min, 1 h, 4 h), and a lock expires on its own", { skip }, async () => {
  await clearLock();
  await failTimes(MFA_LOCK_THRESHOLD);
  assert.ok(Math.abs(minutesFromNow((await lockState()).mfaLockedUntil) - 15) < 1);

  // Time passes: the lock is over, attempts are evaluated again (and the counter restarts).
  await prisma.adminUser.update({ where: { id: L }, data: { mfaLockedUntil: new Date(Date.now() - 1000) } });
  assert.deepEqual(await verifySecondFactor(L, wrong(T0), { now: T0 }), { ok: false, reason: "invalid" }, "an expired lock does not refuse");
  await failTimes(MFA_LOCK_THRESHOLD - 1);
  const second = await lockState();
  assert.equal(second.mfaLockLevel, 2);
  assert.ok(Math.abs(minutesFromNow(second.mfaLockedUntil) - 60) < 1, "second lock: one hour");

  await prisma.adminUser.update({ where: { id: L }, data: { mfaLockedUntil: new Date(Date.now() - 1000) } });
  await failTimes(MFA_LOCK_THRESHOLD);
  const third = await lockState();
  assert.equal(third.mfaLockLevel, 3);
  assert.ok(Math.abs(minutesFromNow(third.mfaLockedUntil) - 240) < 1, "third lock: four hours");

  // Each lock emailed the admin.
  assert.ok(lockEmails().length >= 4);
  await clearLock();
});

test("guesses fired in parallel cannot slip past the lock: at most 10 are evaluated", { skip }, async () => {
  await clearLock();
  const emailsBefore = lockEmails().length;
  const burst = await Promise.all(Array.from({ length: 25 }, () => verifySecondFactor(L, wrong(T0), { now: T0 })));
  const evaluated = burst.filter((r) => !r.ok && r.reason === "invalid").length;
  const refused = burst.filter((r) => !r.ok && r.reason === "locked").length;
  assert.equal(evaluated + refused, 25);
  assert.ok(evaluated <= MFA_LOCK_THRESHOLD, `only ${MFA_LOCK_THRESHOLD} attempts may be evaluated (got ${evaluated})`);
  assert.ok(refused >= 25 - MFA_LOCK_THRESHOLD);
  assert.equal(lockEmails().length, emailsBefore + 1, "one lock, one email");
  await clearLock();
});

test("while locked, disabling 2FA or regenerating recovery codes with an authenticator code is refused too", { skip }, async () => {
  await prisma.adminUser.update({ where: { id: L }, data: { mfaLockedUntil: new Date(Date.now() + 600_000) } });
  const { code, now } = freshCode();
  const regen = await regenerateRecoveryCodes(L, code, { now });
  assert.ok(!regen.ok && regen.reason === "locked");
  const off = await disableTotp(L, code, { now });
  assert.ok(!off.ok && off.reason === "locked");
  assert.equal((await prisma.adminUser.findUniqueOrThrow({ where: { id: L } })).totpEnabledAt !== null, true, "2FA is still on");
  await clearLock();
});

test("`admin:create --reset-2fa` (break-glass) turns 2FA off, clears the lock, ends every session and is audited", { skip }, async () => {
  const s1 = await resolveAdminSession(await createAdminSession(L, {}, { mfaVerified: true }));
  const s2 = await createAdminSession(L, {}, { mfaVerified: true });
  assert.ok(s1);
  await prisma.adminUser.update({ where: { id: L }, data: { mfaFailedCount: 4, mfaLockLevel: 2, mfaLockedUntil: new Date(Date.now() + 3_600_000) } });
  assert.equal(await prisma.adminSession.count({ where: { adminId: L } }), 2);
  assert.ok((await prisma.adminRecoveryCode.count({ where: { adminId: L } })) > 0);

  const r = spawnSync(process.execPath, ["--import", "tsx", "scripts/create-admin.ts", "--email", email.toUpperCase(), "--reset-2fa"], {
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_POOL_MAX: "2" },
    encoding: "utf8",
    timeout: 120_000,
  });
  assert.equal(r.status, 0, `the command succeeded: ${r.stderr}`);
  assert.match(r.stdout, /Two-factor authentication turned off/);

  const row = await prisma.adminUser.findUniqueOrThrow({ where: { id: L } });
  assert.equal(row.totpEnabledAt, null);
  assert.equal(row.totpSecretEnc, null);
  assert.equal(row.totpLastStep, null);
  assert.equal(row.mfaFailedCount, 0);
  assert.equal(row.mfaLockLevel, 0);
  assert.equal(row.mfaLockedUntil, null);
  assert.equal(await prisma.adminRecoveryCode.count({ where: { adminId: L } }), 0);
  assert.equal(await prisma.adminSession.count({ where: { adminId: L } }), 0, "every session was ended");
  assert.equal(await resolveAdminSession(s2), null);
  assert.equal(await prisma.adminAuditLog.count({ where: { adminEmail: "cli", action: "admin.2fa_reset_cli", targetId: L } }), 1);

  const unknown = spawnSync(process.execPath, ["--import", "tsx", "scripts/create-admin.ts", "--email", `nobody-${run}@example.com`, "--reset-2fa"], {
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_POOL_MAX: "2" },
    encoding: "utf8",
    timeout: 120_000,
  });
  assert.notEqual(unknown.status, 0, "an unknown admin is an error");
});
