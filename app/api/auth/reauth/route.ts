import { NextResponse } from "next/server";
import { z } from "zod";
import { authenticate } from "@/lib/auth/accounts";
import { PASSWORD_MAX_LENGTH } from "@/lib/auth/password";
import { markReauthenticated, requireApiAuth } from "@/lib/auth/session";
import { jsonError, parseJson } from "@/lib/http";
import { clientIp, enforce, IDENTITY_RULES } from "@/lib/rate-limit";

const schema = z.object({ password: z.string().min(1).max(PASSWORD_MAX_LENGTH) });

// Re-confirms the password on the current session so sensitive actions are allowed for the next 8 hours.
export async function POST(req: Request) {
  const auth = await requireApiAuth();
  if (auth instanceof NextResponse) return auth;
  const parsed = await parseJson(req, schema);
  if (!parsed.ok) return parsed.response;
  const limited = await enforce(IDENTITY_RULES.reauthUser, `${auth.userId}|${clientIp(req.headers)}`, "Too many attempts. Try again in 15 minutes.");
  if (limited) return limited;
  const ok = await authenticate(auth.email, parsed.data.password);
  if (!ok || ok.userId !== auth.userId) return jsonError("That password is not correct.", 401);
  await markReauthenticated(auth.sessionId);
  return NextResponse.json({ ok: true });
}
