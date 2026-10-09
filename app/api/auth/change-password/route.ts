import { NextResponse } from "next/server";
import { z } from "zod";
import { AccountError, changePassword } from "@/lib/auth/accounts";
import { PASSWORD_MAX_LENGTH } from "@/lib/auth/password";
import { markReauthenticated, requireApiAuth } from "@/lib/auth/session";
import { jsonError, parseJson } from "@/lib/http";
import { clientIp, enforce, IDENTITY_RULES } from "@/lib/rate-limit";

const schema = z.object({
  currentPassword: z.string().min(1).max(PASSWORD_MAX_LENGTH),
  newPassword: z.string().min(1).max(PASSWORD_MAX_LENGTH),
});

export async function POST(req: Request) {
  const auth = await requireApiAuth();
  if (auth instanceof NextResponse) return auth;
  const parsed = await parseJson(req, schema);
  if (!parsed.ok) return parsed.response;
  const limited = await enforce(IDENTITY_RULES.reauthUser, `${auth.userId}|${clientIp(req.headers)}`, "Too many attempts. Try again in 15 minutes.");
  if (limited) return limited;
  try {
    await changePassword(auth.userId, auth.sessionId, parsed.data.currentPassword, parsed.data.newPassword);
    await markReauthenticated(auth.sessionId);
    return NextResponse.json({ ok: true });
  } catch (e) {
    if (e instanceof AccountError) return jsonError(e.message, e.status, { field: e.field });
    throw e;
  }
}
