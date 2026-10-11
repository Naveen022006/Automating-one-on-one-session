import { NextResponse } from "next/server";
import { z } from "zod";
import { recordAudit } from "@/lib/admin/audit";
import { requireAdminMfa } from "@/lib/admin/session";
import { sendAccountEmail } from "@/lib/email";
import { payoutSentMessage } from "@/lib/email/templates";
import { jsonError, parseJson } from "@/lib/http";
import { approvePayout, cancelPayout, markPayoutPaid, PayoutError } from "@/lib/payouts";
import { clientIp } from "@/lib/rate-limit";

// For a suspended influencer, approving or paying is refused (409 `influencer-suspended`) unless the administrator confirms with
// `acknowledgeSuspended: true` and says why in `suspendedReason`; the override and the reason go into the audit entry.
const suspendedAck = {
  acknowledgeSuspended: z.boolean().optional(),
  suspendedReason: z.string().trim().min(5, "Say why you are paying a suspended influencer.").max(300).optional(),
};
const needsReason = (b: { acknowledgeSuspended?: boolean; suspendedReason?: string }) => !b.acknowledgeSuspended || b.suspendedReason !== undefined;
const reasonIssue = { message: "Say why you are paying a suspended influencer.", path: ["suspendedReason"] };
const schema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("approve"), ...suspendedAck }).refine(needsReason, reasonIssue),
  z.object({ action: z.literal("paid"), reference: z.string().trim().min(6, "Enter the bank reference (UTR).").max(60), ...suspendedAck }).refine(needsReason, reasonIssue),
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
  const override = body.action !== "cancel" && body.acknowledgeSuspended && body.suspendedReason ? { reason: body.suspendedReason } : undefined;

  try {
    if (body.action === "approve") {
      const payout = await approvePayout(id, admin.email, new Date(), override);
      await recordAudit(actor, {
        action: "payout.approved",
        targetType: "payout",
        targetId: id,
        detail: { netMinor: payout.netMinor, currency: payout.currency, createdBy: payout.createdByEmail, ...(payout.suspendedOverride && override ? { suspendedOverride: override.reason } : {}) },
        ip,
      });
      return NextResponse.json({ ok: true, approvedAt: payout.approvedAt, approvedByEmail: payout.approvedByEmail });
    }
    if (body.action === "paid") {
      const payout = await markPayoutPaid(id, body.reference, admin.email, process.env, override);
      await recordAudit(actor, {
        action: "payout.paid",
        targetType: "payout",
        targetId: id,
        detail: { reference: body.reference, netMinor: payout.netMinor, currency: payout.currency, approvedBy: payout.approvedByEmail, ...(payout.suspendedOverride && override ? { suspendedOverride: override.reason } : {}) },
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
    const { flaggedPaymentIds } = await cancelPayout(id, body.note ?? null);
    await recordAudit(actor, { action: "payout.cancelled", targetType: "payout", targetId: id, detail: { note: body.note ?? null, flaggedPayments: flaggedPaymentIds.length }, ip });
    // The flagged payments are released but are NOT payable again until refunded: the console says which and where to go.
    return NextResponse.json({ ok: true, flaggedPaymentIds });
  } catch (e) {
    if (e instanceof PayoutError) return jsonError(e.message, e.status, e.code ? { code: e.code } : {});
    throw e;
  }
}
