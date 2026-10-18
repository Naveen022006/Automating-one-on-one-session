import { readQrConfig } from "./config";

/**
 * The one function the messaging layer (lib/messaging.ts) calls to send a booking message from an influencer's QR-linked WhatsApp.
 * It runs in the worker process (the one that holds the sockets). FOUNDATION STUB: the contract is fixed here, the wiring into
 * lib/messaging.ts is implementer 2's.
 *
 * Never throws for an expected refusal: it answers `{ ok: false, reason, retryable }` and the caller falls back to the official
 * WhatsApp connection, SMS or e-mail. `retryable: true` means "not now" (the number is reconnecting), false means "not this way".
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
}

export type WhatsAppWebSendResult = { ok: true; providerMessageId: string } | { ok: false; reason: string; retryable: boolean };

export async function sendWhatsAppWebText(req: WhatsAppWebSendRequest): Promise<WhatsAppWebSendResult> {
  if (!readQrConfig().enabled) return { ok: false, reason: "qr-disabled", retryable: false };
  void req;
  throw new Error("sendWhatsAppWebText is not implemented yet");
}
