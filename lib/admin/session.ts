import { cookies } from "next/headers";
import { cache } from "react";
import { redirect } from "next/navigation";
import { NextResponse } from "next/server";
import { hashToken, randomToken } from "@/lib/auth/tokens";
import { dummyPasswordHash, hashPassword, passwordProblem, verifyPassword } from "@/lib/auth/password";
import { isSecureCookies } from "@/lib/auth/session";
import { prisma } from "@/lib/db";

/**
 * Administrator sessions. A deliberately separate plane from influencer sessions: its own accounts, its own
 * cookie, SameSite=Strict, and a hard 12-hour lifetime (no sliding expiry), so an influencer session can never
 * reach /admin and a stolen admin cookie stops working by the end of the working day.
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
}

export function normaliseAdminEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * Checks an email + password. Always spends a password hash (a dummy one for unknown or disabled accounts) so the
 * response time does not reveal which emails are administrators. Returns the admin id, or null.
 */
export async function authenticateAdmin(emailInput: string, password: string): Promise<{ adminId: string } | null> {
  const admin = await prisma.adminUser.findUnique({ where: { email: normaliseAdminEmail(emailInput) } });
  const usable = admin && !admin.disabledAt;
  const ok = await verifyPassword(password, usable ? admin.passwordHash : await dummyPasswordHash());
  if (!usable || !ok) return null;
  await prisma.adminUser.update({ where: { id: admin.id }, data: { lastLoginAt: new Date() } });
  return { adminId: admin.id };
}

export async function createAdminSession(
  adminId: string,
  meta: { userAgent?: string | null; ip?: string | null } = {},
): Promise<string> {
  const token = randomToken();
  await prisma.adminSession.create({
    data: {
      tokenHash: hashToken(token),
      adminId,
      expiresAt: new Date(Date.now() + ADMIN_SESSION_TTL_MS),
      userAgent: meta.userAgent?.slice(0, 300) ?? null,
      ip: meta.ip?.slice(0, 64) ?? null,
    },
  });
  return token;
}

/** Resolves a raw cookie token to the signed-in admin. Null if missing, expired, revoked or the admin is disabled. */
export async function resolveAdminSession(token: string | null | undefined): Promise<AdminContext | null> {
  if (!token || token.length > 200) return null;
  const row = await prisma.adminSession.findUnique({
    where: { tokenHash: hashToken(token) },
    include: { admin: { select: { id: true, email: true, name: true, disabledAt: true } } },
  });
  if (!row) return null;
  if (row.expiresAt.getTime() <= Date.now() || row.admin.disabledAt) {
    await prisma.adminSession.delete({ where: { id: row.id } }).catch(() => {});
    return null;
  }
  return { sessionId: row.id, adminId: row.admin.id, email: row.admin.email, name: row.admin.name };
}

/** The signed-in admin for this request (server components and route handlers), memoised per request. */
export const getAdminAuth = cache(async (): Promise<AdminContext | null> => {
  const jar = await cookies();
  return resolveAdminSession(jar.get(adminCookieName())?.value);
});

/** Page guard: unauthenticated visitors go to the admin login. */
export async function requireAdminPage(path = "/admin"): Promise<AdminContext> {
  const admin = await getAdminAuth();
  if (!admin) redirect(`/admin/login?next=${encodeURIComponent(path)}`);
  return admin;
}

/** Route-handler guard: the admin context, or a 401 response to return. */
export async function requireAdminApi(): Promise<AdminContext | NextResponse> {
  const admin = await getAdminAuth();
  if (!admin) return NextResponse.json({ error: "Please sign in to the admin console." }, { status: 401 });
  return admin;
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
