import { NextResponse } from "next/server";
import { z } from "zod";
import { AccountError, registerAccount } from "@/lib/auth/accounts";
import { PASSWORD_MAX_LENGTH } from "@/lib/auth/password";
import { createSession, setSessionCookie } from "@/lib/auth/session";
import { jsonError, parseJson, requestMeta } from "@/lib/http";
import { clientIp } from "@/lib/rate-limit";
import { isValidTimezone } from "@/lib/slots";

const schema = z.object({
  name: z.string().trim().min(1).max(100),
  email: z.email().max(200),
  password: z.string().min(1).max(PASSWORD_MAX_LENGTH),
  slug: z.string().trim().min(1).max(60),
  timezone: z.string().max(64).optional(),
  acceptTerms: z.boolean(),
});

// Creates an influencer account + profile, emails a verification link, and logs the new user in so they can start
// onboarding straight away. Rate limited per IP in proxy.ts.
export async function POST(req: Request) {
  const parsed = await parseJson(req, schema);
  if (!parsed.ok) return parsed.response;
  const body = parsed.data;
  const timezone = body.timezone && isValidTimezone(body.timezone) ? body.timezone : "Asia/Kolkata";
  try {
    const { userId } = await registerAccount({ ...body, timezone });
    const token = await createSession(userId, requestMeta(req, clientIp(req.headers)));
    return setSessionCookie(NextResponse.json({ ok: true, redirect: "/onboarding" }, { status: 201 }), token);
  } catch (e) {
    if (e instanceof AccountError) return jsonError(e.message, e.status, { field: e.field });
    throw e;
  }
}
