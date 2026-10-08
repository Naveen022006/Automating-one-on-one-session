import { NextResponse } from "next/server";
import { z } from "zod";
import { requestPasswordReset } from "@/lib/auth/accounts";
import { parseJson } from "@/lib/http";
import { enforce, IDENTITY_RULES } from "@/lib/rate-limit";
import { reportError } from "@/lib/observability";

const schema = z.object({ email: z.email().max(200) });

// Always answers the same way, whether or not the email has an account, so it cannot be used to enumerate users.
export async function POST(req: Request) {
  const parsed = await parseJson(req, schema);
  if (!parsed.ok) return parsed.response;
  const limited = await enforce(IDENTITY_RULES.forgotEmail, parsed.data.email, "Too many reset requests for this email. Try again in an hour.");
  if (limited) return limited;
  try {
    await requestPasswordReset(parsed.data.email);
  } catch (e) {
    reportError(e, { where: "forgot-password" });
  }
  return NextResponse.json({ ok: true, message: "If an account exists for that email, a reset link is on its way." });
}
