import { NextResponse } from "next/server";
import { z } from "zod";
import { recordAudit } from "@/lib/admin/audit";
import { requireAdminApi } from "@/lib/admin/session";
import { jsonError, parseJson } from "@/lib/http";
import { createPayout, PayoutError } from "@/lib/payouts";
import { clientIp } from "@/lib/rate-limit";

const schema = z.object({ currency: z.string().length(3).transform((c) => c.toUpperCase()) });

// Creates a PENDING payout from everything currently payable for this influencer in one currency.
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const admin = await requireAdminApi();
  if (admin instanceof NextResponse) return admin;
  const { id } = await ctx.params;
  const parsed = await parseJson(req, schema);
  if (!parsed.ok) return parsed.response;

  try {
    const payout = await createPayout(id, parsed.data.currency, admin.email);
    await recordAudit(
      { adminId: admin.adminId, email: admin.email },
      {
        action: "payout.created",
        targetType: "payout",
        targetId: payout.id,
        detail: { influencerId: id, currency: payout.currency, netMinor: payout.netMinor, feeMinor: payout.feeMinor, payments: payout.paymentCount },
        ip: clientIp(req.headers),
      },
    );
    return NextResponse.json({ payout });
  } catch (e) {
    if (e instanceof PayoutError) return jsonError(e.message, e.status);
    throw e;
  }
}
