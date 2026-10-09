import { NextResponse } from "next/server";
import { z } from "zod";
import { recordAudit } from "@/lib/admin/audit";
import { changeAdminPassword, requireAdminApi } from "@/lib/admin/session";
import { PASSWORD_MAX_LENGTH } from "@/lib/auth/password";
import { jsonError, parseJson } from "@/lib/http";
import { clientIp, enforce, IDENTITY_RULES } from "@/lib/rate-limit";

const schema = z.object({
  currentPassword: z.string().min(1).max(PASSWORD_MAX_LENGTH),
  newPassword: z.string().min(1).max(PASSWORD_MAX_LENGTH),
});

export async function POST(req: Request) {
  const admin = await requireAdminApi();
  if (admin instanceof NextResponse) return admin;
  const parsed = await parseJson(req, schema);
  if (!parsed.ok) return parsed.response;

  const ip = clientIp(req.headers);
  const limited = await enforce(IDENTITY_RULES.adminReauth, `${admin.adminId}|${ip}`, "Too many attempts. Try again later.");
  if (limited) return limited;

  const result = await changeAdminPassword(admin, parsed.data.currentPassword, parsed.data.newPassword);
  if (!result.ok) return jsonError(result.error, 400, { field: result.field });
  await recordAudit({ adminId: admin.adminId, email: admin.email }, { action: "admin.password_changed", ip });
  return NextResponse.json({ ok: true });
}
