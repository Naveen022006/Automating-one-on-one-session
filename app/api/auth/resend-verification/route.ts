import { NextResponse } from "next/server";
import { resendVerification } from "@/lib/auth/accounts";
import { requireApiAuth } from "@/lib/auth/session";
import { enforce, IDENTITY_RULES } from "@/lib/rate-limit";

export async function POST() {
  const auth = await requireApiAuth();
  if (auth instanceof NextResponse) return auth;
  if (auth.emailVerified) return NextResponse.json({ ok: true, alreadyVerified: true });
  const limited = await enforce(IDENTITY_RULES.resendVerificationEmail, auth.email, "We already sent a few links. Check your inbox and spam folder, or try again in an hour.");
  if (limited) return limited;
  await resendVerification(auth.userId);
  return NextResponse.json({ ok: true });
}
