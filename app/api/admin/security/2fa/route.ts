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
import { requireAdminApi } from "@/lib/admin/session";
import { jsonError, parseJson } from "@/lib/http";
import { clientIp, enforce, IDENTITY_RULES } from "@/lib/rate-limit";

const code = z.string().trim().min(1, "Enter a code.").max(40);
const schema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("setup") }),
  z.object({ action: z.literal("enable"), code }),
  z.object({ action: z.literal("regenerate"), code }),
  z.object({ action: z.literal("disable"), code }),
]);

// Two-factor management for the signed-in administrator. This is one of the few admin routes open to an admin who
// still has to enrol (allowEnrollment). Every action that checks a code is rate limited per admin + IP; enabling,
// regenerating recovery codes and disabling all need a valid, unused code, so a stolen session cannot weaken 2FA.
export async function POST(req: Request) {
  const admin = await requireAdminApi({ allowEnrollment: true });
  if (admin instanceof NextResponse) return admin;
  const parsed = await parseJson(req, schema);
  if (!parsed.ok) return parsed.response;
  const body = parsed.data;
  const ip = clientIp(req.headers);
  const actor = { adminId: admin.adminId, email: admin.email };

  try {
    if (body.action === "setup") {
      const enrollment = await startTotpEnrollment(admin.adminId);
      await recordAudit(actor, { action: "admin.2fa_setup_started", ip });
      return NextResponse.json({ secret: enrollment.secret, uri: enrollment.uri });
    }

    const limited = await enforce(IDENTITY_RULES.adminMfaManage, `${admin.adminId}|${ip}`, "Too many attempts. Try again in 15 minutes.");
    if (limited) return limited;

    if (body.action === "enable") {
      const result = await confirmTotpEnrollment(admin.adminId, body.code, admin.sessionId);
      if (!result.ok) {
        await recordAudit(actor, { action: "admin.mfa_failed", detail: { reason: result.reason, context: "enable" }, ip });
        if (result.reason === "no-pending") return jsonError("Start the setup again to get a new key.", 409);
        return jsonError(codeFailureMessage(result.reason), 400);
      }
      await recordAudit(actor, { action: "admin.2fa_enabled", detail: { recoveryCodes: result.recoveryCodes.length }, ip });
      return NextResponse.json({ ok: true, recoveryCodes: result.recoveryCodes });
    }

    const result = body.action === "regenerate" ? await regenerateRecoveryCodes(admin.adminId, body.code) : await disableTotp(admin.adminId, body.code);
    if (!result.ok) {
      await recordAudit(actor, { action: "admin.mfa_failed", detail: { reason: result.reason, context: body.action }, ip });
      return jsonError(codeFailureMessage(result.reason), 400);
    }
    if (body.action === "regenerate" && "recoveryCodes" in result) {
      await recordAudit(actor, { action: "admin.2fa_recovery_regenerated", ip });
      return NextResponse.json({ ok: true, recoveryCodes: result.recoveryCodes });
    }
    await recordAudit(actor, { action: "admin.2fa_disabled", ip });
    return NextResponse.json({ ok: true });
  } catch (e) {
    if (e instanceof MfaError) return jsonError(e.message, e.status);
    throw e;
  }
}
