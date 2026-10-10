import { NextResponse } from "next/server";
import { z } from "zod";
import { recordAudit } from "@/lib/admin/audit";
import { requireAdminMfa } from "@/lib/admin/session";
import { sendAccountEmail } from "@/lib/email";
import { payoutSentMessage } from "@/lib/email/templates";
import { jsonError, parseJson } from "@/lib/http";
import { approvePayout, cancelPayout, markPayoutPaid, PayoutError } from "@/lib/payouts";
import { clientIp } from "@/lib/rate-limit";

const schema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("approve") }),
  z.object({ action: z.literal("paid"), reference: z.string().trim().min(6, "Enter the bank reference (UTR).").max(60) }),
  z.object({ action: z.literal("cancel"), note: z.string().trim().max(300).optional() }),
]);

// Every action here moves money, so it needs an MFA-verified session. Approving is four-eyes: lib/payouts.ts refuses
// the administrator who created the payout, and marking it paid is refused until another administrator approved it
// (when PAYOUT_FOUR_EYES applies).
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const admin = await requireAdminMfa();
  if (admin instanceof NextResponse) return admin;
  const { id } = await ctx.params;
  const parsed = await parseJson(req, schema);
  if (!parsed.ok) return parsed.response;
  const body = parsed.data;
  const actor = { adminId: admin.adminId, email: admin.email };
  const ip = clientIp(req.headers);

  try {
    if (body.action === "approve") {
      const payout = await approvePayout(id, admin.email);
      await recordAudit(actor, {
        action: "payout.approved",
        targetType: "payout",
        targetId: id,
        detail: { netMinor: payout.netMinor, currency: payout.currency, createdBy: payout.createdByEmail },
        ip,
      });
      return NextResponse.json({ ok: true, approvedAt: payout.approvedAt, approvedByEmail: payout.approvedByEmail });
    }
    if (body.action === "paid") {
      const payout = await markPayoutPaid(id, body.reference, admin.email);
      await recordAudit(actor, {
        action: "payout.paid",
        targetType: "payout",
        targetId: id,
        detail: { reference: body.reference, netMinor: payout.netMinor, currency: payout.currency, approvedBy: payout.approvedByEmail },
        ip,
      });
      await sendAccountEmail(
        { email: payout.influencer.email, name: payout.influencer.name },
        payoutSentMessage(payout.influencer.name, {
          netMinor: payout.netMinor,
          currency: payout.currency,
          destination: payout.destination,
          reference: body.reference,
          paymentCount: payout.paymentCount,
          feeMinor: payout.feeMinor,
        }),
        "payout-sent",
      );
      return NextResponse.json({ ok: true });
    }
    await cancelPayout(id, body.note ?? null);
    await recordAudit(actor, { action: "payout.cancelled", targetType: "payout", targetId: id, detail: { note: body.note ?? null }, ip });
    return NextResponse.json({ ok: true });
  } catch (e) {
    if (e instanceof PayoutError) return jsonError(e.message, e.status);
    throw e;
  }
}
