import { NextResponse } from "next/server";
import { z } from "zod";
import { recordAnonymousAudit, recordAudit } from "@/lib/admin/audit";
import { authenticateAdmin, createAdminSession, setAdminCookie } from "@/lib/admin/session";
import { PASSWORD_MAX_LENGTH } from "@/lib/auth/password";
import { jsonError, parseJson, requestMeta, safeNextPath } from "@/lib/http";
import { clientIp, enforce, IDENTITY_RULES } from "@/lib/rate-limit";

const schema = z.object({
  email: z.email().max(200),
  password: z.string().min(1).max(PASSWORD_MAX_LENGTH),
  next: z.string().max(500).optional(),
});

// Administrator sign-in. Limited per IP (proxy.ts) and per email + IP (here). The error never says whether the
// email belongs to an administrator, and every attempt is written to the audit trail.
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

  const token = await createAdminSession(result.adminId, requestMeta(req, ip));
  await recordAudit({ adminId: result.adminId, email: email.toLowerCase() }, { action: "admin.login", ip });
  return setAdminCookie(NextResponse.json({ ok: true, redirect: safeNextPath(next, "/admin") }), token);
}
