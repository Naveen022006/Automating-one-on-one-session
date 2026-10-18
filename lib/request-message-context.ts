import { hoursToAnswer } from "@/lib/approval-window";
import { appUrl } from "@/lib/brand";
import { formatDateTime, formatMoney } from "@/lib/india";
import type { MessageContext } from "@/lib/message-templates";
import { REQUEST_APPROVED_TEMPLATE, REQUEST_DECLINED_TEMPLATE, REQUEST_EXPIRED_TEMPLATE, REQUEST_RECEIVED_TEMPLATE } from "@/lib/message-kinds";
import { buildPayUrl } from "@/lib/self-service";

/**
 * The extra values the four booking-request messages carry, worked out AT SEND TIME from the booking as it is now. Nothing here is
 * stored or put in a job: the queue holds only the booking id and the template key, so a payment link (a bearer link) never sits in
 * Redis, and a retried job always builds a link that matches the booking's current pay-by time.
 *
 * Times and money go through lib/india.ts only (IST, rupees).
 */

export interface RequestMessageBooking {
  bookingId: string;
  /** The end of the hold: the end of the time to answer while the request waits, the pay-by time once it is approved. */
  holdExpiresAt: Date | null;
  /** When the session starts: a request cannot be approved in the last minutes before it. */
  sessionStart: Date;
  declineReason: string | null;
  priceMinor: number;
  currency: string;
  /** The influencer's public page: /<slug>. */
  slug: string;
}

/** The longest note shown to a customer (the decline route also cuts it at 300). */
export const MAX_NOTE_CHARS = 300;

/**
 * The values to merge into the message context for `template`, or null when the message cannot be sent: only the accepted message can
 * be impossible, when its pay-by time has already passed or the payment link cannot be signed (APP_URL / APP_SECRET missing). A link
 * to a payment page that refuses payment is worse than no message, so the caller skips instead of sending it.
 */
export function requestMessageContext(template: string, b: RequestMessageBooking, now: Date): Partial<MessageContext> | null {
  const bookingPageUrl = `${appUrl()}/${encodeURIComponent(b.slug)}`;
  switch (template) {
    case REQUEST_RECEIVED_TEMPLATE:
      // The host has until the request's hold ends, but not past the last moment an approval still leaves time to pay: for a session that
      // starts tomorrow that is far less than the 48 hours of the hold, and the customer is told the truth.
      return b.holdExpiresAt ? { decideWithinHours: hoursToAnswer(b.holdExpiresAt, b.sessionStart, now) } : {};
    case REQUEST_APPROVED_TEMPLATE: {
      if (!b.holdExpiresAt || b.holdExpiresAt.getTime() <= now.getTime()) return null;
      let payUrl: string;
      try {
        // Valid until the pay-by time (at least a minute), like the link in the e-mail.
        payUrl = buildPayUrl(b.bookingId, (b.holdExpiresAt.getTime() - now.getTime()) / 1000);
      } catch {
        return null;
      }
      return { payUrl, payBy: formatDateTime(b.holdExpiresAt), amount: formatMoney(b.priceMinor, b.currency), bookingPageUrl };
    }
    case REQUEST_DECLINED_TEMPLATE:
      return { reason: b.declineReason?.trim().slice(0, MAX_NOTE_CHARS) || null, bookingPageUrl };
    case REQUEST_EXPIRED_TEMPLATE:
      return { bookingPageUrl };
    default:
      return {};
  }
}
