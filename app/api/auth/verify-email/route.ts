import { NextResponse } from "next/server";
import { z } from "zod";
import { recordActivityForUser } from "@/lib/activity";
import { verifyEmailToken } from "@/lib/auth/accounts";
import { jsonError, parseJson } from "@/lib/http";

const schema = z.object({ token: z.string().min(10).max(200) });

// The verify page POSTs the token (rather than verifying on GET) so mail scanners that prefetch links cannot
// consume it.
export async function POST(req: Request) {
  const parsed = await parseJson(req, schema);
  if (!parsed.ok) return parsed.response;
  const userId = await verifyEmailToken(parsed.data.token);
  if (!userId) return jsonError("This verification link is invalid, already used, or expired.", 400);
  await recordActivityForUser(userId, { action: "auth.email_verified", req });
  return NextResponse.json({ ok: true });
}
