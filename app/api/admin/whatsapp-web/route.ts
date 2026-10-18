import { NextResponse } from "next/server";
import { requireAdminMfa } from "@/lib/admin/session";
import { isEntityId } from "@/lib/http";
import { loadAdminWhatsAppWebSummary, loadAdminWhatsAppWebView } from "@/lib/views/admin-whatsapp-web";
import { jsonView } from "@/lib/views/http";

export const dynamic = "force-dynamic";

/**
 * QR-linked WhatsApp numbers, administrator side. Gate: `requireAdminMfa()`, like the rest of the console.
 *
 *   GET /api/admin/whatsapp-web?influencerId=ID   one influencer's session (404 for an unknown id or a malformed one)
 *   GET /api/admin/whatsapp-web                    the platform-wide counts (linked, suspended, ...)
 *
 * The action that changes something is POST /api/admin/whatsapp-web/:influencerId.
 */
export async function GET(req: Request) {
  const admin = await requireAdminMfa();
  if (admin instanceof NextResponse) return admin;
  const influencerId = new URL(req.url).searchParams.get("influencerId");
  if (influencerId === null) return jsonView(await loadAdminWhatsAppWebSummary());
  const view = isEntityId(influencerId) ? await loadAdminWhatsAppWebView(influencerId) : null;
  if (!view) return jsonView({ error: "Influencer not found" }, { status: 404 });
  return jsonView(view);
}
