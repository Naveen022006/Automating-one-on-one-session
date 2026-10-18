/**
 * The contract of the OPTIONAL "link WhatsApp by QR code" sending mode (doc/14-whatsapp-qr-*.md), shared by the server and the
 * browser. PURE TYPES AND CONSTANTS ONLY: the browser may `import type` from here and may import the two constants, so this file must
 * never import anything (no Baileys, no Prisma, no Node built-ins). Everything else under lib/whatsapp-web/ stays server-side.
 *
 * This mode is unofficial: WhatsApp's terms do not allow third-party clients, and a linked number can be restricted or banned
 * without warning. The official Cloud API connection (lib/whatsapp-connection.ts) stays the default and the safer choice.
 */

/** What the dashboard shows. The database enum (NOT_LINKED, PENDING_QR, ...) maps one to one onto these. */
export type WhatsAppWebStatus = "not-linked" | "waiting-for-scan" | "linked" | "reconnecting" | "suspended" | "logged-out";

/**
 * The answer of `GET /api/dashboard/whatsapp-web` (and of every POST, which returns the fresh view). Built field by field in
 * lib/whatsapp-web/commands.ts. It never carries the login of the linked device, a token or a customer's data. `qrSvg` is a server
 * rendered inline SVG string (the browser imports no QR library) that is only present while `status` is "waiting-for-scan".
 */
export interface WhatsAppWebView {
  /** The platform switch WHATSAPP_QR_ENABLED. When false the whole section is hidden and nothing is sent this way. */
  enabled: boolean;
  /** True when the local simulator is in use (WHATSAPP_QR_FAKE, development only): nothing reaches WhatsApp. */
  fake: boolean;
  status: WhatsAppWebStatus;
  /** The linked number with the middle hidden, for example "+91 ••••• ••210". Null until linked. */
  phoneMasked: string | null;
  /** How the linked device appears on the phone, when known. */
  deviceLabel: string | null;
  qrSvg: string | null;
  /** ISO time after which `qrSvg` stops working; a newer code replaces it while the page keeps polling. */
  qrExpiresAt: string | null;
  /** When the influencer accepted the risk statement, and which version of it. */
  consentAt: string | null;
  /** The version of RISK_TEXT the server currently expects in a "start" request. */
  consentVersion: string;
  riskText: string;
  dailyCap: number;
  sentToday: number;
  lastError: { code: string; text: string } | null;
  suspendedReason: string | null;
  /** Whether the official Cloud API connection is active (the safer way, and the automatic fallback). */
  officialConnected: boolean;
}

/** Body of `POST /api/dashboard/whatsapp-web`. */
export type WhatsAppWebRequest =
  | { action: "start"; consent: true; consentVersion: string }
  | { action: "cancel" }
  | { action: "disconnect" }
  | { action: "test" };

/**
 * Bumped whenever RISK_TEXT changes in substance, so an old consent is never taken for the new wording. The server refuses a
 * "start" whose consentVersion differs.
 */
export const CONSENT_VERSION = "wa-web-2026-11-1";

/** Plain-language statement shown before linking and stored (by version) with the consent. */
export const RISK_TEXT =
  "This links your own WhatsApp number as a linked device, the same way WhatsApp Web works, and sends your booking messages " +
  "(confirmation, reminders, reschedule and cancellation) to your customers from it. It is an unofficial method: WhatsApp's terms " +
  "do not allow it, and WhatsApp may restrict or ban the number, without notice and without a way for us to prevent or reverse it. " +
  "Use a number you can afford to lose, not your only business number. Only messages about a booking that a customer made with you are sent, " +
  "slowly and up to a daily limit. Your customers' replies and your chats are not read or stored. We keep an encrypted login for the " +
  "linked device so it stays connected, and you can disconnect at any time (we then delete it; remove the device in WhatsApp > Linked devices too). " +
  "If sending fails or the link is lost, messages go through the official connection, SMS or e-mail instead. " +
  "The official WhatsApp Business API connection is the safer option and does not put your number at risk.";
