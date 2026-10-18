import { prisma } from "@/lib/db";
import type { DeliveryRoute } from "@/lib/message-kinds";
import { smsConfigProblem } from "@/lib/sms";
import { officialRouteAvailable } from "@/lib/whatsapp-connection";
import { readQrConfig } from "@/lib/whatsapp-web/config";
import { isWhatsAppWebTemplate } from "@/lib/whatsapp-web/messages";

/**
 * How a customer message of this kind can reach the customer of this influencer RIGHT NOW, in the order the messaging layer tries
 * (lib/messaging.ts): their linked WhatsApp number, their official WhatsApp connection with this template approved, SMS configured for
 * this message, or `none`. One shared answer, read when a message is about to be queued and by the dashboard's wording, so nobody is told
 * "the payment link is on its way to WhatsApp" when no route exists.
 *
 * It is the route as far as the web process can see: the linked number counts when the feature is on and the number is LINKED and wanted
 * (the worker may still find the socket busy a moment later; the message then falls through to the next route as always). A dry run
 * (`MESSAGING_DRY_RUN`) logs instead of sending, so the official route is reported as available.
 */
export async function customerMessageRoute(influencerId: string, template: string, env: NodeJS.ProcessEnv = process.env): Promise<DeliveryRoute> {
  if (env.MESSAGING_DRY_RUN !== "true" && readQrConfig(env).enabled && isWhatsAppWebTemplate(template)) {
    const linked = await prisma.whatsAppWebSession.findUnique({ where: { influencerId }, select: { status: true, wantLinked: true } });
    if (linked && linked.status === "LINKED" && linked.wantLinked) return "whatsapp-linked";
  }
  if (await officialRouteAvailable(influencerId, template, env)) return "whatsapp-official";
  if (smsConfigProblem(template, env) === null) return "sms";
  return "none";
}
