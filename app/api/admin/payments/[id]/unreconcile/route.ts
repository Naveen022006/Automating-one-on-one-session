import { NextResponse } from "next/server";
import { recordAudit } from "@/lib/admin/audit";
import { requireAdminApi } from "@/lib/admin/session";
import { jsonError } from "@/lib/http";
import { unreconcilePayment } from "@/lib/payouts";
import { clientIp } from "@/lib/rate-limit";

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const admin = await requireAdminApi();
  if (admin instanceof NextResponse) return admin;
  const { id } = await ctx.params;
  if (!(await unreconcilePayment(id))) return jsonError("This payment is not reconciled, or it is already part of a payout.", 409);
  await recordAudit({ adminId: admin.adminId, email: admin.email }, { action: "payment.unreconciled", targetType: "payment", targetId: id, ip: clientIp(req.headers) });
  return NextResponse.json({ ok: true });
}
