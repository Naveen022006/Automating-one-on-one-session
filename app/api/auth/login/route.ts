import { NextResponse } from "next/server";
import { z } from "zod";
import { recordActivity, recordFailedLogin } from "@/lib/activity";
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

  const ip = clientIp(req.headers);
  const limited = await enforce(
    IDENTITY_RULES.loginEmail,
    `${email}|${ip}`,
    "Too many sign-in attempts. Try again in 15 minutes or reset your password.",
  );
  if (limited) return limited;

  const result = await authenticate(email, password);
  if (!result) {
    // Not awaited: the answer must take the same time whether or not the e-mail has an account (the account log is a side effect).
    recordFailedLogin(email, req);
    return jsonError("That email and password do not match.", 401);
  }

  const token = await createSession(result.userId, requestMeta(req, ip));
  const user = await prisma.user.findUnique({
    where: { id: result.userId },
    select: { influencerId: true, influencer: { select: { onboardedAt: true } } },
  });
  if (user) await recordActivity({ influencerId: user.influencerId, action: "auth.login", req });
  const redirect = user?.influencer.onboardedAt ? safeNextPath(next) : "/onboarding";
  return setSessionCookie(NextResponse.json({ ok: true, redirect }), token);
}
