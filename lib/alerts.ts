import { prisma } from "@/lib/db";
import { buildConnectUrl } from "@/lib/google-tokens";

export type InfluencerAlertKind = "google-reconnect-needed" | "meeting-creation-failed";

export interface InfluencerAlert {
  kind: InfluencerAlertKind;
  detail: string;
  bookingId?: string;
  /** Present on reconnect alerts: the signed link the influencer must open. */
  actionUrl?: string;
}

/** Delivery hook. Phase 4 (WhatsApp/SMS/email) replaces the default, which only writes a structured log line. */
export type AlertSender = (to: { id: string; name: string; email: string }, alert: InfluencerAlert) => Promise<void>;

const logSender: AlertSender = async (to, alert) => {
  console.error("[alert:influencer]", JSON.stringify({ influencerId: to.id, email: to.email, ...alert }));
};

let sender: AlertSender = logSender;
export function setAlertSender(next: AlertSender): void {
  sender = next;
}

/** Never throws: a broken alert channel must not fail or retry the job that raised the alert. */
export async function alertInfluencer(influencerId: string, alert: InfluencerAlert): Promise<void> {
  try {
    const influencer = await prisma.influencer.findUnique({
      where: { id: influencerId },
      select: { id: true, name: true, email: true },
    });
    if (!influencer) return;
    const withLink =
      alert.kind === "google-reconnect-needed" && !alert.actionUrl
        ? { ...alert, actionUrl: buildConnectUrl(influencerId) }
        : alert;
    await sender(influencer, withLink);
  } catch (e) {
    console.error("[alert:influencer] failed to send alert", e);
  }
}
