import { NextResponse } from "next/server";
import { z } from "zod";
import { authenticate } from "@/lib/auth/accounts";
import { PASSWORD_MAX_LENGTH } from "@/lib/auth/password";
import { createSession, setSessionCookie } from "@/lib/auth/session";
import { prisma } from "@/lib/db";
import { jsonError, parseJson, requestMeta, safeNextPath } from "@/lib/http";
import { clientIp, enforce, IDENTITY_RULES } from "@/lib/rate-limit";

const schema = z.object({
  email: z.email().max(200),
  password: z.string().min(1).max(PASSWORD_MAX_LENGTH),
  next: z.string().max(500).optional(),
});

// Email + password -> opaque session cookie. Limited per IP (proxy.ts) and per email (here), so neither a single
// attacker nor a distributed attack on one account can brute-force passwords quickly. The error never says
// whether the email exists.
export async function POST(req: Request) {
  const parsed = await parseJson(req, schema);
  if (!parsed.ok) return parsed.response;
  const { email, password, next } = parsed.data;

  const limited = await enforce(IDENTITY_RULES.loginEmail, email, "Too many sign-in attempts for this account. Try again in 15 minutes or reset your password.");
  if (limited) return limited;

  const result = await authenticate(email, password);
  if (!result) return jsonError("That email and password do not match.", 401);

  const token = await createSession(result.userId, requestMeta(req, clientIp(req.headers)));
  const user = await prisma.user.findUnique({
    where: { id: result.userId },
    select: { influencer: { select: { onboardedAt: true } } },
  });
  const redirect = user?.influencer.onboardedAt ? safeNextPath(next) : "/onboarding";
  return setSessionCookie(NextResponse.json({ ok: true, redirect }), token);
}
