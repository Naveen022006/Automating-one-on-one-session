import { NextResponse } from "next/server";
import { z } from "zod";
import { recordAnonymousAudit, recordAudit } from "@/lib/admin/audit";
import { codeFailureMessage, resolveAdminPending, verifySecondFactor } from "@/lib/admin/mfa";
import { createAdminSession, setAdminCookie } from "@/lib/admin/session";
import { jsonError, parseJson, requestMeta, safeNextPath } from "@/lib/http";
import { clientIp, enforce, IDENTITY_RULES } from "@/lib/rate-limit";

const schema = z.object({
  pendingToken: z.string().min(1).max(600),
  code: z.string().min(1).max(40),
  next: z.string().max(500).optional(),
});

// Administrator sign-in, step 2 of 2: the pending token from /api/admin/auth/login plus an authenticator code or a
// single-use recovery code. Only here is the session created, with `mfaVerifiedAt` set. Limited per IP (proxy.ts),
// per admin + IP and per admin overall (here); every success and failure is audited.
export async function POST(req: Request) {
  const parsed = await parseJson(req, schema);
  if (!parsed.ok) return parsed.response;
  const { pendingToken, code, next } = parsed.data;
  const ip = clientIp(req.headers);

  const pending = await resolveAdminPending(pendingToken);
  if (!pending) {
    await recordAnonymousAudit("unknown", { action: "admin.mfa_failed", detail: { reason: "bad-or-expired-token" }, ip }).catch(() => {});
    return jsonError("Your sign-in expired. Enter your email and password again.", 401, { restart: true });
  }
  const actor = { adminId: pending.adminId, email: pending.email };

  const limited =
    (await enforce(IDENTITY_RULES.adminMfaIp, `${pending.adminId}|${ip}`, "Too many attempts. Try again in 15 minutes.")) ??
    (await enforce(IDENTITY_RULES.adminMfaAdmin, pending.adminId, "Too many attempts on this account. Try again later."));
  if (limited) {
    await recordAudit(actor, { action: "admin.mfa_failed", detail: { reason: "rate-limited" }, ip }).catch(() => {});
    return limited;
  }

  const result = await verifySecondFactor(pending.adminId, code);
  if (!result.ok) {
    await recordAudit(actor, { action: "admin.mfa_failed", detail: { reason: result.reason, context: "login" }, ip });
    return jsonError(codeFailureMessage(result.reason), 401, result.reason === "not-enabled" ? { restart: true } : {});
  }

  const token = await createAdminSession(pending.adminId, requestMeta(req, ip), { mfaVerified: true });
  await recordAudit(actor, { action: "admin.login", detail: { mfa: true, method: result.method }, ip });
  if (result.method === "recovery") {
    await recordAudit(actor, { action: "admin.recovery_code_used", detail: { codesLeft: result.recoveryCodesLeft ?? 0 }, ip });
  }
  return setAdminCookie(
    NextResponse.json({ ok: true, redirect: safeNextPath(next, "/admin"), recoveryCodesLeft: result.recoveryCodesLeft }),
    token,
  );
}
