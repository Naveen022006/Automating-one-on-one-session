import { NextResponse } from "next/server";
import { z } from "zod";
import { forceDisconnectWhatsAppWeb, WhatsAppWebAdminError } from "@/lib/admin/whatsapp-web";
import { requireAdminMfa } from "@/lib/admin/session";
import { isEntityId, parseJson } from "@/lib/http";
import { clientIp } from "@/lib/rate-limit";
import { loadAdminWhatsAppWebView } from "@/lib/views/admin-whatsapp-web";
import { jsonView } from "@/lib/views/http";

export const dynamic = "force-dynamic";

const NOT_FOUND = { error: "Influencer not found" };

const schema = z.object({ action: z.literal("disconnect"), reason: z.string().trim().min(5).max(300) });

type Ctx = { params: Promise<{ influencerId: string }> };

/** One influencer's QR-linked WhatsApp session (the same answer as GET /api/admin/whatsapp-web?influencerId=). */
export async function GET(_req: Request, ctx: Ctx) {
  const admin = await requireAdminMfa();
  if (admin instanceof NextResponse) return admin;
  const { influencerId } = await ctx.params;
  const view = isEntityId(influencerId) ? await loadAdminWhatsAppWebView(influencerId) : null;
  if (!view) return jsonView(NOT_FOUND, { status: 404 });
  return jsonView(view);
}

/**
 * `{ action: "disconnect", reason }` (the reason is 5 to 300 characters): force-disconnects the influencer's QR-linked WhatsApp. The
 * change and its audit entry are one transaction. 404 for an unknown influencer, 409 when there is nothing linked to disconnect
 * (a repeat is a 409 with no second audit entry).
 */
export async function POST(req: Request, ctx: Ctx) {
  const admin = await requireAdminMfa();
  if (admin instanceof NextResponse) return admin;
  const { influencerId } = await ctx.params;
  if (!isEntityId(influencerId)) return jsonView(NOT_FOUND, { status: 404 });
  const parsed = await parseJson(req, schema);
  if (!parsed.ok) return parsed.response;

  try {
    await forceDisconnectWhatsAppWeb({ adminId: admin.adminId, email: admin.email }, influencerId, parsed.data.reason, clientIp(req.headers));
  } catch (e) {
    if (e instanceof WhatsAppWebAdminError) return jsonView({ error: e.message }, { status: e.status });
    throw e;
  }
  const view = await loadAdminWhatsAppWebView(influencerId);
  if (!view) return jsonView(NOT_FOUND, { status: 404 });
  return jsonView({ ok: true, view });
}
