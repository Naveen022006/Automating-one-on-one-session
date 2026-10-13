import { NextResponse } from "next/server";
import { z } from "zod";
import { recordActivityForUser } from "@/lib/activity";
import { AccountError, resetPassword } from "@/lib/auth/accounts";
import { PASSWORD_MAX_LENGTH } from "@/lib/auth/password";
import { createSession, setSessionCookie } from "@/lib/auth/session";
import { jsonError, parseJson, requestMeta } from "@/lib/http";
import { clientIp } from "@/lib/rate-limit";

// Any non-empty token reaches the lookup, so a truncated link gets "invalid or has expired", not a form error (QA-5).
const schema = z.object({ token: z.string().min(1).max(200), password: z.string().min(1).max(PASSWORD_MAX_LENGTH) });

// Single-use, 1-hour token from the reset email. Every existing session is revoked and a fresh one is issued.
export async function POST(req: Request) {
  const parsed = await parseJson(req, schema);
  if (!parsed.ok) return parsed.response;
  try {
    const { userId } = await resetPassword(parsed.data.token, parsed.data.password);
    const token = await createSession(userId, requestMeta(req, clientIp(req.headers)));
    await recordActivityForUser(userId, { action: "auth.password_reset", req });
    return setSessionCookie(NextResponse.json({ ok: true, redirect: "/dashboard" }), token);
  } catch (e) {
    if (e instanceof AccountError) return jsonError(e.message, e.status, { field: e.field });
    throw e;
  }
}
