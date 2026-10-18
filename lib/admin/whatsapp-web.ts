import { recordActivity } from "@/lib/activity";
import { recordAudit, type AuditActor } from "@/lib/admin/audit";
import { prisma } from "@/lib/db";
import { getKv, kvKeys } from "@/lib/whatsapp-web/kv";
import { maskE164 } from "@/lib/whatsapp-web/mask";

/**
 * An administrator's one action on an influencer's QR-linked WhatsApp: force-disconnect. It asks the worker to unlink the device and
 * delete the stored login (the same teardown as the influencer's own "disconnect"), and removes the stored login at once.
 *
 * The change and its audit row (`whatsapp_web.force_disconnect`, with the reason) are written in ONE transaction: an action never
 * happens without its record, and a failing audit insert leaves the session as it was. The update is conditional on there being
 * something to disconnect (a wanted link or a stored login), so a repeat is a clean 409 with no second audit row.
 *
 * It does not send anything to the influencer and does not touch bookings, messages or the official WhatsApp connection; messages
 * go through the official connection, SMS or e-mail from the next one on. The influencer sees an entry in their account activity.
 */

export class WhatsAppWebAdminError extends Error {
  constructor(
    message: string,
    readonly status: 404 | 409,
  ) {
    super(message);
  }
}

export async function forceDisconnectWhatsAppWeb(actor: AuditActor, influencerId: string, reason: string, ip: string | null): Promise<void> {
  const row = await prisma.influencer.findUnique({ where: { id: influencerId }, select: { id: true, whatsappWebSession: { select: { phoneE164: true } } } });
  if (!row) throw new WhatsAppWebAdminError("Influencer not found", 404);

  await prisma.$transaction(async (tx) => {
    const { count } = await tx.whatsAppWebSession.updateMany({
      where: { influencerId, OR: [{ wantLinked: true }, { authStateEnc: { not: null } }] },
      data: { wantLinked: false, authStateEnc: null },
    });
    if (count === 0) throw new WhatsAppWebAdminError("This influencer has no linked WhatsApp number to disconnect.", 409);
    await recordAudit(actor, { action: "whatsapp_web.force_disconnect", targetType: "influencer", targetId: influencerId, detail: { reason }, ip }, tx);
  });

  // After the commit, best effort: the QR picture of an unfinished link goes now, and the influencer's trail gets an entry.
  await getKv().del(kvKeys.qr(influencerId)).catch(() => {});
  await recordActivity({ influencerId, action: "whatsapp_web.disconnected", actor: "system", detail: { phone: maskE164(row.whatsappWebSession?.phoneE164), reason: "admin" } });
}
