import { NextResponse } from "next/server";
import { sendAccountEmail } from "@/lib/email";
import { payoutDetailsSavedMessage } from "@/lib/email/templates";
import { requireApiAuth, requireRecentAuth } from "@/lib/auth/session";
import { jsonError } from "@/lib/http";
import { getPayoutAccountView, payoutInputSchema, savePayoutAccount } from "@/lib/payout-account";
import { z } from "zod";

// The influencer's payout details. Reads return only masked values. Saving needs a recent password entry (the same
// rule as refunds), always resets the review status, and emails a security notice so a hijacked session cannot
// quietly redirect payouts.

export async function GET() {
  const auth = await requireApiAuth();
  if (auth instanceof NextResponse) return auth;
  return NextResponse.json({ account: await getPayoutAccountView(auth.influencerId) });
}

export async function PUT(req: Request) {
  const auth = await requireRecentAuth();
  if (auth instanceof NextResponse) return auth;

  const raw = await req.json().catch(() => null);
  const parsed = payoutInputSchema.safeParse(raw ?? {});
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Please check the highlighted fields.", details: z.flattenError(parsed.error) },
      { status: 400 },
    );
  }

  const account = await savePayoutAccount(auth.influencerId, parsed.data);
  const summary =
    account.method === "BANK" ? `bank account ${account.accountNumber} (${account.bankName})` : `UPI ID ${account.upiId}`;
  await sendAccountEmail({ email: auth.email, name: auth.influencerName }, payoutDetailsSavedMessage(auth.influencerName, summary), "payout-details-saved");
  return NextResponse.json({ account });
}

export function DELETE() {
  // Details are replaced, never deleted: payout history refers to them.
  return jsonError("Update your payout details instead of deleting them.", 405);
}
