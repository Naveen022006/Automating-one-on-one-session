import { readQrConfig } from "./config";

/**
 * The one function the messaging layer (lib/messaging.ts) calls to send a booking message from an influencer's QR-linked WhatsApp.
 *
 * It must run in the WORKER process, the only one that holds sockets (worker/whatsapp-web-manager.ts registers itself here at
 * start-up). In any other process (the web app) there is no sender, and the call answers "manager-not-running".
 *
 * It never throws for an expected refusal. It answers `{ ok: false, reason, retryable }` and the caller falls back to the official
 * WhatsApp connection, SMS or e-mail. `retryable: true` means "not right now" (the number is reconnecting, the queue is full);
 * `false` means "not this way" (QR mode off, number not linked, daily limit reached, not on WhatsApp, circuit breaker open,
 * no real booking for this number). Reason codes: qr-disabled, manager-not-running, not-linked, not-connected, circuit-open,
 * daily-cap, not-on-whatsapp, no-booking, invalid-number, empty-text, missing-booking, queue-full, limits-unavailable,
 * guard-unavailable, plus the transport's own codes for a failed send.
 */
export interface WhatsAppWebSendRequest {
  influencerId: string;
  /** Destination in E.164 ("+919876543210"). Must be the number on a real booking of this influencer. */
  toE164: string;
  /** The ready message text. */
  text: string;
  /** The booking this message is about. A send without a real booking of this influencer and number is refused. */
  bookingId: string;
  /** Idempotency key, for example `${bookingId}:${template}`: a repeat while the first is queued or just done returns the same result. */
  key: string;
  /**
   * Which booking message this is (the template key: "booking-confirmation", "reminder-24h", ...). The booking check uses it: a
   * reminder or a confirmation is not sent for a booking that was cancelled meanwhile, a cancellation notice is.
   */
  kind?: string;
  /**
   * Epoch milliseconds after which the message is no longer worth sending (a 15-minute reminder after the session started). Checked
   * again immediately before the actual send; a message past it is dropped with reason "expired" and never sent.
   */
  deadlineAtMs?: number;
}

/**
 * The one exception to "only about a real booking": a test message to the influencer's OWN linked number (to prove the link works).
 * Send it with `bookingId: SELF_TEST_BOOKING_ID`; the manager accepts it only when `toE164` is exactly the number linked on this
 * influencer's device, and refuses it for any other number.
 */
export const SELF_TEST_BOOKING_ID = "self-test";

export type WhatsAppWebSendResult = { ok: true; providerMessageId: string } | { ok: false; reason: string; retryable: boolean };

/** What the worker's manager offers. */
export interface WhatsAppWebSender {
  send(req: WhatsAppWebSendRequest): Promise<WhatsAppWebSendResult>;
  /** True when a message could go out through this influencer's linked number right now. */
  isReady(influencerId: string): boolean;
}

let active: WhatsAppWebSender | null = null;

/** Called by the worker when the manager starts (and with null when it stops). Tests use it to plug in a fake. */
export function setActiveSender(next: WhatsAppWebSender | null): void {
  active = next;
}

/** Cheap check before building a message: is the QR route usable for this influencer right now? */
export function isWhatsAppWebReady(influencerId: string): boolean {
  if (!readQrConfig().enabled || !active) return false;
  try {
    return active.isReady(influencerId);
  } catch {
    return false;
  }
}

export async function sendWhatsAppWebText(req: WhatsAppWebSendRequest): Promise<WhatsAppWebSendResult> {
  if (!readQrConfig().enabled) return { ok: false, reason: "qr-disabled", retryable: false };
  if (!active) return { ok: false, reason: "manager-not-running", retryable: false };
  try {
    return await active.send(req);
  } catch {
    return { ok: false, reason: "send-error", retryable: true };
  }
}
