import { NextResponse } from "next/server";
import { z } from "zod";
import { recordAudit } from "@/lib/admin/audit";
import {
  codeFailureMessage,
  confirmTotpEnrollment,
  disableTotp,
  MfaError,
  regenerateRecoveryCodes,
  startTotpEnrollment,
} from "@/lib/admin/mfa";
import { notifyAdminSecurity } from "@/lib/admin/security-notices";
import { requireAdminApi, verifyAdminPassword } from "@/lib/admin/session";
import { PASSWORD_MAX_LENGTH } from "@/lib/auth/password";
import { jsonError, parseJson } from "@/lib/http";
import { clientIp, enforce, IDENTITY_RULES } from "@/lib/rate-limit";

const password = z.string().min(1, "Enter your password.").max(PASSWORD_MAX_LENGTH);
const code = z.string().trim().min(1, "Enter a code.").max(40);
const schema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("setup"), password }),
  z.object({ action: z.literal("enable"), password, code }),
  z.object({ action: z.literal("regenerate"), password, code }),
  z.object({ action: z.literal("disable"), password, code }),
]);

// Two-factor management for the signed-in administrator. This is one of the few admin routes open to an admin who
// still has to enrol (allowEnrollment).
//
// A session cookie alone can never change two-factor: EVERY action needs the admin's current password (so a stolen
// cookie of a not-yet-enrolled admin cannot be used to enrol the thief's authenticator and lock the owner out), and
// enable / regenerate / disable also need a valid, unused code. Password checks go through the admin re-auth limiter
// and everything is capped per admin across all IPs; all of these limiters fail closed. Code checks additionally
// count towards the durable lockout in verifySecondFactor. Each change is audited and emailed to the admin.
export async function POST(req: Request) {
  const admin = await requireAdminApi({ allowEnrollment: true });
  if (admin instanceof NextResponse) return admin;
  const parsed = await parseJson(req, schema);
  if (!parsed.ok) return parsed.response;
  const body = parsed.data;
  const ip = clientIp(req.headers);
  const actor = { adminId: admin.adminId, email: admin.email };

  try {
    const limited =
      (await enforce(IDENTITY_RULES.adminReauth, `${admin.adminId}|${ip}`, "Too many password attempts. Try again in 15 minutes.")) ??
      (await enforce(IDENTITY_RULES.adminMfaManageAdmin, admin.adminId, "Too many attempts on this account. Try again later.")) ??
      (body.action === "setup" ? null : await enforce(IDENTITY_RULES.adminMfaManage, `${admin.adminId}|${ip}`, "Too many attempts. Try again in 15 minutes."));
    if (limited) return limited;

    if (!(await verifyAdminPassword(admin.adminId, body.password))) {
      await recordAudit(actor, { action: "admin.mfa_failed", detail: { reason: "wrong-password", context: body.action }, ip });
      return jsonError("Your password is not correct.", 400, { field: "password" });
    }

    if (body.action === "setup") {
      const enrollment = await startTotpEnrollment(admin.adminId);
      await recordAudit(actor, { action: "admin.2fa_setup_started", ip });
      return NextResponse.json({ secret: enrollment.secret, uri: enrollment.uri });
    }

    if (body.action === "enable") {
      const result = await confirmTotpEnrollment(admin.adminId, body.code, admin.sessionId);
      if (!result.ok) {
        await recordAudit(actor, { action: "admin.mfa_failed", detail: { reason: result.reason, context: "enable" }, ip });
        if (result.reason === "no-pending") return jsonError("Start the setup again to get a new key.", 409);
        return jsonError(codeFailureMessage(result.reason), 400);
      }
      await recordAudit(actor, { action: "admin.2fa_enabled", detail: { recoveryCodes: result.recoveryCodes.length }, ip });
      await notifyAdminSecurity(admin.adminId, "2fa-enabled", { ip });
      return NextResponse.json({ ok: true, recoveryCodes: result.recoveryCodes });
    }

    const result =
      body.action === "regenerate"
        ? await regenerateRecoveryCodes(admin.adminId, body.code)
        : await disableTotp(admin.adminId, body.code, { keepSessionId: admin.sessionId });
    if (!result.ok) {
      await recordAudit(actor, { action: "admin.mfa_failed", detail: { reason: result.reason, context: body.action }, ip });
      if (result.reason === "locked") {
        const retryAfterSec = result.lockedUntil ? Math.max(1, Math.ceil((result.lockedUntil.getTime() - Date.now()) / 1000)) : 900;
        return jsonError(codeFailureMessage("locked", result.lockedUntil), 429, { locked: true, retryAfterSec });
      }
      return jsonError(codeFailureMessage(result.reason), 400);
    }
    if (body.action === "regenerate" && "recoveryCodes" in result) {
      await recordAudit(actor, { action: "admin.2fa_recovery_regenerated", ip });
      await notifyAdminSecurity(admin.adminId, "recovery-regenerated", { ip });
      return NextResponse.json({ ok: true, recoveryCodes: result.recoveryCodes });
    }
    await recordAudit(actor, { action: "admin.2fa_disabled", detail: { otherSessionsSignedOut: true }, ip });
    await notifyAdminSecurity(admin.adminId, "2fa-disabled", { ip });
    return NextResponse.json({ ok: true });
  } catch (e) {
    if (e instanceof MfaError) return jsonError(e.message, e.status);
    throw e;
  }
}
