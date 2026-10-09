import { NextResponse } from "next/server";
import { z } from "zod";
import { recordAudit } from "@/lib/admin/audit";
import { requireAdminApi } from "@/lib/admin/session";
import { prisma } from "@/lib/db";
import { sendAccountEmail } from "@/lib/email";
import { payoutDetailsReviewedMessage } from "@/lib/email/templates";
import { jsonError, parseJson } from "@/lib/http";
import { revealPayoutAccount, reviewPayoutAccount } from "@/lib/payout-account";
import { clientIp } from "@/lib/rate-limit";

const schema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("reveal") }),
  z.object({ action: z.literal("verify") }),
  z.object({ action: z.literal("reject"), reason: z.string().trim().min(5, "Tell the influencer what to fix.").max(300) }),
]);

// Administrator actions on an influencer's payout details. Revealing the full account number is audited BEFORE the
// value is decrypted, so there is no way to see it without leaving a record.
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const admin = await requireAdminApi();
  if (admin instanceof NextResponse) return admin;
  const { id } = await ctx.params;

  const parsed = await parseJson(req, schema);
  if (!parsed.ok) return parsed.response;
  const body = parsed.data;
  const ip = clientIp(req.headers);
  const actor = { adminId: admin.adminId, email: admin.email };

  const influencer = await prisma.influencer.findUnique({ where: { id }, select: { id: true, name: true, email: true } });
  if (!influencer) return jsonError("Influencer not found", 404);

  if (body.action === "reveal") {
    await recordAudit(actor, { action: "payout_account.revealed", targetType: "influencer", targetId: id, ip });
    const details = await revealPayoutAccount(id);
    if (!details) return jsonError("This influencer has not added payout details.", 404);
    return NextResponse.json({ details });
  }

  const decision = body.action === "verify" ? ({ verified: true } as const) : ({ verified: false, reason: body.reason } as const);
  const account = await reviewPayoutAccount(id, decision, admin.email);
  if (!account) return jsonError("This influencer has not added payout details.", 404);
  await recordAudit(actor, {
    action: body.action === "verify" ? "payout_account.verified" : "payout_account.rejected",
    targetType: "influencer",
    targetId: id,
    detail: body.action === "reject" ? { reason: body.reason } : undefined,
    ip,
  });
  await sendAccountEmail({ email: influencer.email, name: influencer.name }, payoutDetailsReviewedMessage(influencer.name, decision), "payout-details-reviewed");
  return NextResponse.json({ account });
}
