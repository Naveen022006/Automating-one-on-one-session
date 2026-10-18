import { NextResponse } from "next/server";
import { z } from "zod";
import { requestPasswordReset } from "@/lib/auth/accounts";
import { platformEmailEnabled } from "@/lib/email/providers";
import { parseJson } from "@/lib/http";
import { enforce, IDENTITY_RULES } from "@/lib/rate-limit";
import { reportError } from "@/lib/observability";

const schema = z.object({ email: z.email().max(200) });

// Always answers the same way, whether or not the email has an account, so it cannot be used to enumerate users.
export async function POST(req: Request) {
  const parsed = await parseJson(req, schema);
  if (!parsed.ok) return parsed.response;
  // The platform sends no e-mail (EMAIL_PROVIDER=none, doc/15): say so instead of promising a link that will never arrive. The answer
  // is the same for every address, so it still reveals nothing about who has an account.
  if (!platformEmailEnabled()) {
    return NextResponse.json({
      ok: true,
      emailEnabled: false,
      message: "This site does not send password reset e-mails. Ask your administrator for a password reset link.",
    });
  }
  const limited = await enforce(IDENTITY_RULES.forgotEmail, parsed.data.email, "Too many reset requests for this email. Try again in an hour.");
  if (limited) return limited;
  try {
    await requestPasswordReset(parsed.data.email);
  } catch (e) {
    reportError(e, { where: "forgot-password" });
  }
  return NextResponse.json({ ok: true, emailEnabled: true, message: "If an account exists for that email, a reset link is on its way." });
}
