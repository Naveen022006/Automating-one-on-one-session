import { cookies } from "next/headers";
import { cache } from "react";
import { redirect } from "next/navigation";
import { NextResponse } from "next/server";
import { ADMIN_SECURITY_PATH, admin2faRequired } from "@/lib/admin/policy";
import { hashToken, randomToken } from "@/lib/auth/tokens";
import { dummyPasswordHash, hashPassword, passwordProblem, verifyPassword } from "@/lib/auth/password";
import { isSecureCookies } from "@/lib/auth/session";
import { prisma } from "@/lib/db";

/**
 * Administrator sessions. A deliberately separate plane from influencer sessions: its own accounts, its own
 * cookie, SameSite=Strict, and a hard 12-hour lifetime (no sliding expiry), so an influencer session can never
 * reach /admin and a stolen admin cookie stops working by the end of the working day.
 *
 * Two-factor: an admin with TOTP enabled only gets a session after a second factor (lib/admin/mfa.ts), and that
 * session carries `mfaVerifiedAt`. Sensitive actions call requireAdminMfa(); with ADMIN_REQUIRE_2FA on, an admin
 * who has not enrolled can reach nothing but the enrollment page and its API.
 */

export const ADMIN_SESSION_TTL_MS = 12 * 3_600_000;

export function adminCookieName(): string {
  return isSecureCookies() ? "__Host-sa_admin" : "sa_admin";
}

export function adminCookieOptions(maxAgeSec = ADMIN_SESSION_TTL_MS / 1000) {
  return { httpOnly: true, sameSite: "strict" as const, secure: isSecureCookies(), path: "/", maxAge: maxAgeSec };
}

export interface AdminContext {
  sessionId: string;
  adminId: string;
  email: string;
  name: string;
  /** The admin has finished enrolling a second factor. */
  totpEnabled: boolean;
  /** This session passed a second factor. */
  mfaVerified: boolean;
}

export function normaliseAdminEmail(email: string): string {
  return email.trim().toLowerCase();
}

export interface AdminPasswordLogin {
  adminId: string;
  /** The admin must now present a second factor; do not create a session yet. */
  totpEnabled: boolean;
  /** Changes when the password changes, so a half-finished sign-in cannot outlive a password change. */
  passwordFingerprint: string;
}

/** Ties a pending sign-in to the password it was started with. */
export function adminPasswordFingerprint(passwordHash: string): string {
  return hashToken(`admin-2fa-pw:${passwordHash}`).slice(0, 16);
}

/**
 * Checks an email + password. Always spends a password hash (a dummy one for unknown or disabled accounts) so the
 * response time does not reveal which emails are administrators. Returns the admin id (and whether a second
 * factor is due), or null. It does not create a session.
 */
export async function authenticateAdmin(emailInput: string, password: string): Promise<AdminPasswordLogin | null> {
  const admin = await prisma.adminUser.findUnique({ where: { email: normaliseAdminEmail(emailInput) } });
  const usable = admin && !admin.disabledAt;
  const ok = await verifyPassword(password, usable ? admin.passwordHash : await dummyPasswordHash());
  if (!usable || !ok) return null;
  return { adminId: admin.id, totpEnabled: admin.totpEnabledAt != null, passwordFingerprint: adminPasswordFingerprint(admin.passwordHash) };
}

/** A password-only session was requested for an admin who has two-factor on. Sign-in must go through the second step. */
export class AdminMfaRequiredError extends Error {
  constructor() {
    super("This administrator has two-factor authentication on; a code is required to sign in.");
  }
}

/**
 * Creates the session row and returns the raw cookie token. Call it only once sign-in is complete: after the
 * password for an admin without 2FA, or after the second factor (`mfaVerified: true`) for one with it.
 *
 * A password-only session (no `mfaVerified`) is REFUSED with AdminMfaRequiredError when the admin has 2FA on. The check
 * and the insert share a transaction that holds a share lock on the admin row, so it cannot race with an enrollment:
 * either the enrollment committed first (the check sees it and refuses), or this session committed first and the
 * enrollment, which waits for the row, then signs every other session out.
 */
export async function createAdminSession(
  adminId: string,
  meta: { userAgent?: string | null; ip?: string | null } = {},
  opts: { mfaVerified?: boolean } = {},
): Promise<string> {
  const token = randomToken();
  const now = new Date();
  const data = {
    tokenHash: hashToken(token),
    adminId,
    expiresAt: new Date(now.getTime() + ADMIN_SESSION_TTL_MS),
    userAgent: meta.userAgent?.slice(0, 300) ?? null,
    ip: meta.ip?.slice(0, 64) ?? null,
    mfaVerifiedAt: opts.mfaVerified ? now : null,
  };
  if (opts.mfaVerified) {
    await prisma.adminSession.create({ data });
  } else {
    await prisma.$transaction(
      async (tx) => {
        const rows = await tx.$queryRaw<{ totp_enabled_at: Date | null }[]>`SELECT totp_enabled_at FROM admin_users WHERE id = ${adminId} FOR SHARE`;
        if (rows.length === 0) throw new Error("Administrator not found");
        if (rows[0].totp_enabled_at) throw new AdminMfaRequiredError();
        await tx.adminSession.create({ data });
      },
      { timeout: 20_000 },
    );
  }
  await prisma.adminUser.update({ where: { id: adminId }, data: { lastLoginAt: now } });
  return token;
}

/** Re-checks the signed-in admin's own password (constant-time compare; always spends one hash). */
export async function verifyAdminPassword(adminId: string, password: string): Promise<boolean> {
  const row = await prisma.adminUser.findUnique({ where: { id: adminId }, select: { passwordHash: true } });
  const ok = await verifyPassword(password, row ? row.passwordHash : await dummyPasswordHash());
  return Boolean(row) && ok;
}

/** Resolves a raw cookie token to the signed-in admin. Null if missing, expired, revoked or the admin is disabled. */
export async function resolveAdminSession(token: string | null | undefined): Promise<AdminContext | null> {
  if (!token || token.length > 200) return null;
  const row = await prisma.adminSession.findUnique({
    where: { tokenHash: hashToken(token) },
    include: { admin: { select: { id: true, email: true, name: true, disabledAt: true, totpEnabledAt: true } } },
  });
  if (!row) return null;
  if (row.expiresAt.getTime() <= Date.now() || row.admin.disabledAt) {
    await prisma.adminSession.delete({ where: { id: row.id } }).catch(() => {});
    return null;
  }
  return {
    sessionId: row.id,
    adminId: row.admin.id,
    email: row.admin.email,
    name: row.admin.name,
    totpEnabled: row.admin.totpEnabledAt != null,
    mfaVerified: row.mfaVerifiedAt != null,
  };
}

/** The signed-in admin for this request (server components and route handlers), memoised per request. */
export const getAdminAuth = cache(async (): Promise<AdminContext | null> => {
  const jar = await cookies();
  return resolveAdminSession(jar.get(adminCookieName())?.value);
});

/* ---------- Two-factor gate ---------- */

/**
 *  - "ok":     nothing more is needed (2FA is on and this session passed it, or 2FA is neither enabled nor required)
 *  - "enroll": 2FA is required (ADMIN_REQUIRE_2FA) but this admin has not set it up
 *  - "verify": 2FA is enabled but this session did not pass it (a session older than the enrollment)
 */
export type MfaGate = "ok" | "enroll" | "verify";

export function mfaGateStatus(admin: Pick<AdminContext, "totpEnabled" | "mfaVerified">, env: NodeJS.ProcessEnv = process.env): MfaGate {
  if (admin.totpEnabled) return admin.mfaVerified ? "ok" : "verify";
  return admin2faRequired(env) ? "enroll" : "ok";
}

/** 403 with `mfaRequired: true`; `mfaAction` says whether to enrol or to sign in again with a code. */
export function mfaDeniedResponse(gate: "enroll" | "verify"): NextResponse {
  const error =
    gate === "enroll"
      ? "Two-factor authentication is required. Set it up under Security before using the admin console."
      : "This action needs a session verified with your authenticator. Sign out and sign in again with your code.";
  return NextResponse.json({ error, mfaRequired: true, mfaAction: gate }, { status: 403 });
}

/**
 * The response to send for this admin on a route, or null to continue. `mfa` marks a sensitive action that needs a
 * verified session; every route (except the enrollment ones, `allowEnrollment`) is closed to an admin who must enrol.
 */
export function adminApiGate(
  admin: Pick<AdminContext, "totpEnabled" | "mfaVerified">,
  opts: { mfa?: boolean; allowEnrollment?: boolean } = {},
  env: NodeJS.ProcessEnv = process.env,
): NextResponse | null {
  const gate = mfaGateStatus(admin, env);
  if (gate === "enroll" && !opts.allowEnrollment) return mfaDeniedResponse("enroll");
  if (gate === "verify" && opts.mfa) return mfaDeniedResponse("verify");
  return null;
}

/**
 * Page guard: unauthenticated visitors go to the admin login; an admin who must enrol is sent to the Security page
 * (the only page open to them); and a password-only session of an admin who HAS 2FA ("verify": a session older than
 * the enrollment) is sent back to sign in with a code, so it cannot browse the console. `mfaGate: false` skips both
 * redirects for callers that cannot tell which page they are guarding.
 */
export async function requireAdminPage(path = "/admin", opts: { mfaGate?: boolean } = {}): Promise<AdminContext> {
  const admin = await getAdminAuth();
  if (!admin) redirect(`/admin/login?next=${encodeURIComponent(path)}`);
  if (opts.mfaGate !== false) {
    const gate = mfaGateStatus(admin);
    if (gate === "verify") redirect(`/admin/login?next=${encodeURIComponent(path)}`);
    if (gate === "enroll" && path.split("?")[0] !== ADMIN_SECURITY_PATH) redirect(ADMIN_SECURITY_PATH);
  }
  return admin;
}

/**
 * Whether this session may see the list of administrators and their 2FA status. Hidden from a session that has not
 * passed what it must (a stolen cookie of an admin who has not enrolled, or a password-only session) so it cannot be
 * used to pick targets; with 2FA required that means "enrolled and verified".
 */
export function canViewAdminList(admin: Pick<AdminContext, "totpEnabled" | "mfaVerified">, env: NodeJS.ProcessEnv = process.env): boolean {
  return mfaGateStatus(admin, env) === "ok";
}

/**
 * Route-handler guard: the admin context, or a 401 (not signed in) / 403 `{ mfaRequired: true }` (must enrol first)
 * response to return. Enrollment routes pass `allowEnrollment`.
 */
export async function requireAdminApi(opts: { allowEnrollment?: boolean } = {}): Promise<AdminContext | NextResponse> {
  const admin = await getAdminAuth();
  if (!admin) return NextResponse.json({ error: "Please sign in to the admin console." }, { status: 401 });
  return adminApiGate(admin, opts) ?? admin;
}

/**
 * Route-handler guard for sensitive actions (revealing bank details, reviewing payout details, reconciling, creating,
 * approving, paying or cancelling payouts, changing fees). As requireAdminApi, and additionally the session must have
 * passed a second factor whenever the admin has one enabled.
 *
 * It is also the guard of every admin READ endpoint the SPA uses (GET /api/admin/...): it denies exactly what the old
 * server-rendered pages denied ("enroll" and "verify", see requireAdminPage), which `requireAdminApi()` alone does not
 * (it lets a password-only session of a 2FA admin through). `allowEnrollment` is only for the two endpoints behind the
 * only console screens an enrolling admin can open: GET /api/admin/security and GET /api/admin/shell. "verify" stays
 * denied there too. Calling it without options keeps its previous behaviour.
 */
export async function requireAdminMfa(opts: { allowEnrollment?: boolean } = {}): Promise<AdminContext | NextResponse> {
  const admin = await getAdminAuth();
  if (!admin) return NextResponse.json({ error: "Please sign in to the admin console." }, { status: 401 });
  return adminApiGate(admin, { mfa: true, allowEnrollment: opts.allowEnrollment }) ?? admin;
}

export async function revokeAdminSession(sessionId: string): Promise<void> {
  await prisma.adminSession.deleteMany({ where: { id: sessionId } });
}

export async function changeAdminPassword(
  admin: AdminContext,
  currentPassword: string,
  newPassword: string,
): Promise<{ ok: true } | { ok: false; field: string; error: string }> {
  const row = await prisma.adminUser.findUnique({ where: { id: admin.adminId } });
  if (!row || !(await verifyPassword(currentPassword, row.passwordHash))) {
    return { ok: false, field: "currentPassword", error: "Your current password is not correct." };
  }
  const problem = passwordProblem(newPassword, { email: row.email, name: row.name });
  if (problem) return { ok: false, field: "newPassword", error: problem };
  await prisma.adminUser.update({ where: { id: row.id }, data: { passwordHash: await hashPassword(newPassword) } });
  // Every other admin session ends; the current one continues.
  await prisma.adminSession.deleteMany({ where: { adminId: row.id, id: { not: admin.sessionId } } });
  return { ok: true };
}

export function setAdminCookie(res: NextResponse, token: string): NextResponse {
  res.cookies.set(adminCookieName(), token, adminCookieOptions());
  return res;
}

export function clearAdminCookie(res: NextResponse): NextResponse {
  res.cookies.set(adminCookieName(), "", { ...adminCookieOptions(0), maxAge: 0 });
  return res;
}
