import { NextResponse } from "next/server";
import { resendVerification } from "@/lib/auth/accounts";
import { requireApiAuth } from "@/lib/auth/session";
import { platformEmailEnabled } from "@/lib/email/providers";
import { enforce, IDENTITY_RULES } from "@/lib/rate-limit";

export async function POST() {
  const auth = await requireApiAuth();
  if (auth instanceof NextResponse) return auth;
  if (auth.emailVerified) return NextResponse.json({ ok: true, alreadyVerified: true });
  // The platform sends no e-mail (EMAIL_PROVIDER=none, doc/15): nothing is created or sent. An administrator verifies the account.
  if (!platformEmailEnabled()) {
    return NextResponse.json({ ok: true, sent: false, emailEnabled: false, message: "This site does not send verification e-mails. Your administrator verifies new accounts." });
  }
  const limited = await enforce(IDENTITY_RULES.resendVerificationEmail, auth.email, "We already sent a few links. Check your inbox and spam folder, or try again in an hour.");
  if (limited) return limited;
  const sent = await resendVerification(auth.userId);
  return NextResponse.json({ ok: true, sent, emailEnabled: true });
}
