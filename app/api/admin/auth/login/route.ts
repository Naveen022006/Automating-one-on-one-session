import { NextResponse } from "next/server";
import { z } from "zod";
import { recordAnonymousAudit, recordAudit } from "@/lib/admin/audit";
import { issueAdminPendingToken, PENDING_TOKEN_TTL_SEC } from "@/lib/admin/mfa";
import { authenticateAdmin, createAdminSession, setAdminCookie } from "@/lib/admin/session";
import { PASSWORD_MAX_LENGTH } from "@/lib/auth/password";
import { jsonError, parseJson, requestMeta, safeNextPath } from "@/lib/http";
import { clientIp, enforce, IDENTITY_RULES } from "@/lib/rate-limit";

const schema = z.object({
  email: z.email().max(200),
  password: z.string().min(1).max(PASSWORD_MAX_LENGTH),
  next: z.string().max(500).optional(),
});

// Administrator sign-in, step 1 of 2 for admins with two-factor on. Limited per IP (proxy.ts) and per email + IP
// (here). The error never says whether the email belongs to an administrator, and every attempt is written to the
// audit trail. With 2FA enabled the password alone creates NO session: the response carries a short-lived signed
// token that /api/admin/auth/mfa exchanges, together with an authenticator or recovery code, for the session.
export async function POST(req: Request) {
  const parsed = await parseJson(req, schema);
  if (!parsed.ok) return parsed.response;
  const { email, password, next } = parsed.data;

  const ip = clientIp(req.headers);
  const limited = await enforce(
    IDENTITY_RULES.adminLoginEmail,
    `${email.toLowerCase()}|${ip}`,
    "Too many sign-in attempts. Try again in 15 minutes.",
  );
  if (limited) return limited;

  const result = await authenticateAdmin(email, password);
  if (!result) {
    await recordAnonymousAudit(email, { action: "admin.login_failed", ip }).catch(() => {});
    return jsonError("That email and password do not match.", 401);
  }

  const actor = { adminId: result.adminId, email: email.toLowerCase() };
  if (result.totpEnabled) {
    await recordAudit(actor, { action: "admin.login_mfa_challenge", ip });
    return NextResponse.json({
      ok: true,
      mfaRequired: true,
      pendingToken: issueAdminPendingToken(result.adminId, result.passwordFingerprint),
      expiresInSec: PENDING_TOKEN_TTL_SEC,
    });
  }

  const token = await createAdminSession(result.adminId, requestMeta(req, ip));
  await recordAudit(actor, { action: "admin.login", detail: { mfa: false }, ip });
  return setAdminCookie(NextResponse.json({ ok: true, redirect: safeNextPath(next, "/admin") }), token);
}
