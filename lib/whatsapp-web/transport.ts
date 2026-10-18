/**
 * The boundary between this app and the library that talks to WhatsApp's linked-device protocol. PURE TYPES: no library import
 * here or in anything but lib/whatsapp-web/baileys-transport.ts, which loads Baileys with a dynamic import() inside functions, so
 * tests, `next build` and the browser bundle (web/vite-server-guard.ts) never load it. The manager (worker/whatsapp-web-manager.ts)
 * only knows this interface; lib/whatsapp-web/fake-transport.ts implements it for tests and for local development.
 *
 * What a transport must NOT do: read, keep or report incoming chats or messages. It reports only the connection's own events
 * (QR code, opened, closed) and the delivery state of messages WE sent.
 */

/** The login of a linked device as the transport sees it: synchronous reads and writes on an in-memory copy (see auth-state.ts). */
export interface WhatsAppAuthStore {
  /** The library's credentials object, or undefined when no device was ever linked (the transport then creates fresh ones). */
  getCreds(): unknown | undefined;
  /** Replace the credentials. Persisted, encrypted, a moment later. */
  setCreds(creds: unknown): void;
  /** Signal keys of one type, by id. Missing ids are undefined. */
  getKeys(type: string, ids: string[]): Record<string, unknown>;
  /** Set (value) or delete (null) keys, by type and id. */
  setKeys(data: Record<string, Record<string, unknown | null>>): void;
  clearKeys(): void;
}

/**
 * Why a connection ended.
 *  - "logged-out": the phone removed this device (or the login is unusable). Nothing to retry; the login is deleted and the
 *    influencer must link again.
 *  - "restricted": WhatsApp refuses this number (forbidden). Retrying can only make it worse; sending is suspended.
 *  - "transient": anything else (network, server restart, replaced by another session). The manager reconnects with backoff.
 */
export type WhatsAppWebCloseReason = "logged-out" | "restricted" | "transient";

export interface WhatsAppWebCloseInfo {
  reason: WhatsAppWebCloseReason;
  /** A short machine code for logs and `lastError` ("restart-required", "replaced", "connection-lost", "bad-session", ...). No secrets. */
  code: string;
}

export interface WhatsAppWebOpenInfo {
  /** The linked number in E.164 ("+919876543210"). */
  phoneE164: string;
  /** How the device shows on the phone, when known. */
  deviceLabel: string | null;
}

export type WhatsAppWebDeliveryStatus = "sent" | "delivered" | "read" | "failed";

/** Callbacks a transport calls. Each may be called many times; none may throw into the transport (the manager guards them). */
export interface WhatsAppWebTransportEvents {
  /** A new QR payload to render (the library rotates it every ~20 s until it is scanned). */
  onQr(qr: string): void;
  /** The connection is open and the device is linked. */
  onOpen(info: WhatsAppWebOpenInfo): void;
  onClose(info: WhatsAppWebCloseInfo): void;
  /** State of a message this transport sent (matched by the id `sendText` returned). Never called for incoming messages. */
  onDelivery(info: { providerMessageId: string; status: WhatsAppWebDeliveryStatus }): void;
}

export interface WhatsAppWebTransport {
  /** Starts connecting. Resolves once the attempt is under way; progress and failure arrive through `events`. Call once. */
  connect(auth: WhatsAppAuthStore, events: WhatsAppWebTransportEvents): Promise<void>;
  /** Sends one text message. Throws a `WhatsAppWebTransportError` (or any error, treated as retryable) when it cannot. */
  sendText(toE164: string, text: string): Promise<{ providerMessageId: string }>;
  /** Whether a number has a WhatsApp account. */
  numberExists(e164: string): Promise<boolean>;
  /** Unlinks this device on the phone's side too, then closes. */
  logout(): Promise<void>;
  /** Closes the connection without unlinking (the stored login stays valid). Safe to call twice. */
  end(): Promise<void>;
}

export type WhatsAppWebTransportFactory = (opts: { influencerId: string }) => WhatsAppWebTransport;

export class WhatsAppWebTransportError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "WhatsAppWebTransportError";
  }
}
