import { NextResponse } from "next/server";
import { z } from "zod";
import { recordAudit } from "@/lib/admin/audit";
import { requireAdminMfa } from "@/lib/admin/session";
import { prisma } from "@/lib/db";
import { jsonError, parseJson } from "@/lib/http";
import { clientIp } from "@/lib/rate-limit";

// Percent with up to two decimals (0 - 50), or null to fall back to the platform default. Stored in basis points.
const schema = z.object({ feePercent: z.number().min(0).max(50).nullable() });

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const admin = await requireAdminMfa();
  if (admin instanceof NextResponse) return admin;
  const { id } = await ctx.params;
  const parsed = await parseJson(req, schema);
  if (!parsed.ok) return parsed.response;

  const existing = await prisma.influencer.findUnique({ where: { id }, select: { platformFeeBps: true } });
  if (!existing) return jsonError("Influencer not found", 404);
  const feeBps = parsed.data.feePercent === null ? null : Math.round(parsed.data.feePercent * 100);
  await prisma.influencer.update({ where: { id }, data: { platformFeeBps: feeBps } });
  await recordAudit(
    { adminId: admin.adminId, email: admin.email },
    { action: "influencer.fee_changed", targetType: "influencer", targetId: id, detail: { from: existing.platformFeeBps, to: feeBps }, ip: clientIp(req.headers) },
  );
  return NextResponse.json({ feeBps });
}
