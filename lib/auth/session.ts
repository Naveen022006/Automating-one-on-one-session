import { cookies } from "next/headers";
import { cache } from "react";
import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { hashToken, randomToken } from "./tokens";

/**
 * Opaque, database-backed login sessions for influencers (Phase 7 B2).
 *
 *  - The cookie holds a random 256-bit token; only its SHA-256 is stored (`auth_sessions.token_hash`).
 *  - HttpOnly, SameSite=Lax, Secure in production (and then `__Host-` prefixed, so it is bound to this host).
 *  - Rolling 30-day expiry: every use slides `expiresAt` forward (written at most every 5 minutes).
 *  - Sensitive actions require the password to have been entered on this session within the last 8 hours
 *    (`authenticatedAt`); otherwise the API answers 401 `{ reauth: true }` and the UI asks for the password.
 */

export const SESSION_TTL_MS = 30 * 86_400_000;
export const SENSITIVE_WINDOW_MS = 8 * 3_600_000;
const TOUCH_INTERVAL_MS = 5 * 60_000;

export function isSecureCookies(): boolean {
  return process.env.NODE_ENV === "production" || (process.env.APP_URL ?? "").startsWith("https://");
}

export function sessionCookieName(): string {
  return isSecureCookies() ? "__Host-sa_session" : "sa_session";
}

export function sessionCookieOptions(maxAgeSec = SESSION_TTL_MS / 1000) {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: isSecureCookies(),
    path: "/",
    maxAge: maxAgeSec,
  };
}

export interface AuthContext {
  sessionId: string;
  userId: string;
  email: string;
  emailVerified: boolean;
  influencerId: string;
  influencerSlug: string;
  influencerName: string;
  onboarded: boolean;
  /** Milliseconds since the password was last entered on this session. */
  sinceAuthMs: number;
}

export async function createSession(
  userId: string,
  meta: { userAgent?: string | null; ip?: string | null } = {},
): Promise<string> {
  const token = randomToken();
  await prisma.authSession.create({
    data: {
      tokenHash: hashToken(token),
      userId,
      expiresAt: new Date(Date.now() + SESSION_TTL_MS),
      userAgent: meta.userAgent?.slice(0, 300) ?? null,
      ip: meta.ip?.slice(0, 64) ?? null,
    },
  });
  return token;
}

/** Resolves a raw cookie token to the logged-in influencer, sliding the expiry. Null if missing/expired/revoked. */
export async function resolveSession(token: string | null | undefined): Promise<AuthContext | null> {
  if (!token || token.length > 200) return null;
  const row = await prisma.authSession.findUnique({
    where: { tokenHash: hashToken(token) },
    include: { user: { include: { influencer: { select: { id: true, slug: true, name: true, onboardedAt: true } } } } },
  });
  if (!row) return null;
  const now = Date.now();
  if (row.expiresAt.getTime() <= now) {
    await prisma.authSession.delete({ where: { id: row.id } }).catch(() => {});
    return null;
  }
  if (now - row.lastUsedAt.getTime() > TOUCH_INTERVAL_MS) {
    await prisma.authSession
      .update({ where: { id: row.id }, data: { lastUsedAt: new Date(now), expiresAt: new Date(now + SESSION_TTL_MS) } })
      .catch(() => {});
  }
  const { user } = row;
  return {
    sessionId: row.id,
    userId: user.id,
    email: user.email,
    emailVerified: user.emailVerifiedAt !== null,
    influencerId: user.influencer.id,
    influencerSlug: user.influencer.slug,
    influencerName: user.influencer.name,
    onboarded: user.influencer.onboardedAt !== null,
    sinceAuthMs: now - row.authenticatedAt.getTime(),
  };
}

/**
 * The logged-in influencer for the current request (server components, route handlers), or null. Memoised per
 * request with React `cache`, so a layout and its page share one database lookup.
 */
export const getAuth = cache(async (): Promise<AuthContext | null> => {
  const jar = await cookies();
  return resolveSession(jar.get(sessionCookieName())?.value);
});

/** Route-handler guard: the auth context, or a 401 response to return. */
export async function requireApiAuth(): Promise<AuthContext | NextResponse> {
  const auth = await getAuth();
  if (!auth) return NextResponse.json({ error: "Please log in again." }, { status: 401 });
  return auth;
}

/** Route-handler guard for sensitive actions: also requires a password entry within the last 8 hours. */
export async function requireRecentAuth(): Promise<AuthContext | NextResponse> {
  const auth = await requireApiAuth();
  if (auth instanceof NextResponse) return auth;
  if (auth.sinceAuthMs > SENSITIVE_WINDOW_MS) {
    return NextResponse.json(
      { error: "For your security, please confirm your password to continue.", reauth: true },
      { status: 401 },
    );
  }
  return auth;
}

export async function markReauthenticated(sessionId: string): Promise<void> {
  await prisma.authSession.update({ where: { id: sessionId }, data: { authenticatedAt: new Date() } });
}

export async function revokeSession(sessionId: string): Promise<void> {
  await prisma.authSession.deleteMany({ where: { id: sessionId } });
}

/** "Log out everywhere": deletes every session of the user (optionally keeping the current one). */
export async function revokeAllSessions(userId: string, exceptSessionId?: string): Promise<number> {
  const { count } = await prisma.authSession.deleteMany({
    where: { userId, ...(exceptSessionId ? { id: { not: exceptSessionId } } : {}) },
  });
  return count;
}

export function setSessionCookie(res: NextResponse, token: string): NextResponse {
  res.cookies.set(sessionCookieName(), token, sessionCookieOptions());
  return res;
}

export function clearSessionCookie(res: NextResponse): NextResponse {
  res.cookies.set(sessionCookieName(), "", { ...sessionCookieOptions(0), maxAge: 0 });
  return res;
}
