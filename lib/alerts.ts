import { appUrl } from "@/lib/brand";
import { prisma } from "@/lib/db";
import { reportError } from "@/lib/observability";

export type InfluencerAlertKind =
  | "google-reconnect-needed"
  | "meeting-creation-failed"
  | "message-delivery-failed"
  | "refund-needed"
  | "refund-failed"
  | "booking-request"
  | "whatsapp-reconnect-needed"
  | "whatsapp-qr-logged-out"
  | "whatsapp-qr-suspended"
  | "platform-cancelled";

export interface InfluencerAlert {
  kind: InfluencerAlertKind;
  detail: string;
  bookingId?: string;
  /** Where the influencer should go to fix it. Defaults per kind (settings for Google, sessions otherwise). */
  actionUrl?: string;
  /** Heading of the alert email, when the kind's default does not describe this particular case. */
  title?: string;
}

export interface AlertRecipient {
  id: string;
  name: string;
  email: string;
  notifyByEmail: boolean;
}

/** Delivery hook. The default emails the influencer (unless they turned alerts off) and always logs. */
export type AlertSender = (to: AlertRecipient, alert: InfluencerAlert) => Promise<void>;

const TITLES: Record<InfluencerAlertKind, { title: string; action: string }> = {
  "google-reconnect-needed": { title: "Reconnect Google Calendar", action: "Reconnect Google" },
  "meeting-creation-failed": { title: "A Meet link could not be created", action: "Open the session" },
  "message-delivery-failed": { title: "A customer message was not delivered", action: "Open the session" },
  "refund-needed": { title: "A payment needs a refund", action: "Review the refund" },
  "refund-failed": { title: "A refund failed", action: "Review the refund" },
  "booking-request": { title: "New booking request", action: "Review the request" },
  "whatsapp-reconnect-needed": { title: "Reconnect WhatsApp", action: "Reconnect WhatsApp" },
  "whatsapp-qr-logged-out": { title: "Your linked WhatsApp was logged out", action: "Link WhatsApp again" },
  "whatsapp-qr-suspended": { title: "Sending from your linked WhatsApp was paused", action: "Review WhatsApp settings" },
  "platform-cancelled": { title: "A booking was cancelled by the platform", action: "Open the session" },
};

export function defaultActionUrl(alert: InfluencerAlert): string {
  if (alert.kind === "google-reconnect-needed") return `${appUrl()}/dashboard/settings#google`;
  if (alert.kind === "whatsapp-reconnect-needed" || alert.kind === "whatsapp-qr-logged-out" || alert.kind === "whatsapp-qr-suspended") return `${appUrl()}/dashboard/settings#whatsapp`;
  if (alert.bookingId) return `${appUrl()}/dashboard/sessions?booking=${encodeURIComponent(alert.bookingId)}`;
  return `${appUrl()}/dashboard`;
}

const defaultSender: AlertSender = async (to, alert) => {
  console.error("[alert:influencer]", JSON.stringify({ influencerId: to.id, kind: alert.kind, bookingId: alert.bookingId, detail: alert.detail }));
  if (!to.notifyByEmail) return;
  // Imported lazily so modules that only raise alerts do not pull in the email stack at load time.
  const [{ sendAccountEmail }, { influencerAlertMessage }] = await Promise.all([
    import("@/lib/email"),
    import("@/lib/email/templates"),
  ]);
  const t = TITLES[alert.kind];
  await sendAccountEmail(
    { email: to.email, name: to.name },
    influencerAlertMessage(to.name, {
      title: alert.title ?? t.title,
      detail: alert.detail,
      actionLabel: t.action,
      actionUrl: alert.actionUrl ?? defaultActionUrl(alert),
    }),
    `alert-${alert.kind}`,
  );
};

let sender: AlertSender = defaultSender;
/** Replaces the delivery hook and returns the one it replaced, so a test can put it back (`finally { setAlertSender(previous) }`). */
export function setAlertSender(next: AlertSender): AlertSender {
  const previous = sender;
  sender = next;
  return previous;
}

/** Never throws: a broken alert channel must not fail or retry the job that raised the alert. */
export async function alertInfluencer(influencerId: string, alert: InfluencerAlert): Promise<void> {
  try {
    const influencer = await prisma.influencer.findUnique({
      where: { id: influencerId },
      select: { id: true, name: true, email: true, notifyByEmail: true },
    });
    if (!influencer) return;
    await sender(influencer, { ...alert, actionUrl: alert.actionUrl ?? defaultActionUrl(alert) });
  } catch (e) {
    reportError(e, { where: "alertInfluencer", influencerId, kind: alert.kind });
  }
}
