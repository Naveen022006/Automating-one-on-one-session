/**
 * Shapes of the answers of the QR-code WhatsApp endpoints beyond the dashboard view itself (lib/whatsapp-web/types.ts). PURE TYPES: the
 * browser may `import type` from here. Nothing in these shapes is secret; none of them ever carries the stored login, a QR payload or a
 * customer's data (the QR picture is the one field of `WhatsAppWebView`, only while waiting for a scan).
 */

import type { WhatsAppWebStatus, WhatsAppWebView } from "./types";

/** Answer of `POST /api/dashboard/whatsapp-web` with `{ action: "test" }`: the fresh view plus how the test message went. */
export interface WhatsAppWebTestAnswer extends WhatsAppWebView {
  test: {
    /** `sent`: handed to WhatsApp. `pending`: the worker has not answered yet, the message may still arrive. */
    state: "sent" | "pending" | "failed";
    /** Plain-language reason when `state` is "failed". */
    message: string | null;
  };
}

/** Every refusal of the dashboard endpoint: `{ error, code }` (the status code carries the class: 400, 401, 409, 429, 503). */
export interface WhatsAppWebErrorBody {
  error: string;
  code?: "disabled" | "consent-required" | "consent-outdated" | "not-pending" | "not-linked" | "cooldown" | "unavailable";
  /** Seconds, with a 429. */
  retryAfterSec?: number;
}

/** One influencer's QR-code WhatsApp session as an administrator sees it (`GET /api/admin/whatsapp-web?influencerId=`). */
export interface AdminWhatsAppWebView {
  influencerId: string;
  /** The platform switch WHATSAPP_QR_ENABLED. */
  enabled: boolean;
  status: WhatsAppWebStatus;
  /** What the influencer asked for ("start" pressed and not undone). */
  wantLinked: boolean;
  phoneMasked: string | null;
  deviceLabel: string | null;
  consentAt: string | null;
  consentVersion: string | null;
  linkedAt: string | null;
  lastConnectedAt: string | null;
  sentToday: number;
  dailyCap: number;
  sentTotal: number;
  lastError: { code: string; text: string } | null;
  suspendedReason: string | null;
  /** True when "Force disconnect" would do something (a link, a pending link, a suspension or a stored login exists). */
  canForceDisconnect: boolean;
}

/** `GET /api/admin/whatsapp-web` without an influencer: the platform-wide counts. */
export interface AdminWhatsAppWebSummary {
  enabled: boolean;
  linked: number;
  reconnecting: number;
  suspended: number;
  loggedOut: number;
  waitingForScan: number;
}

/** Answer of `POST /api/admin/whatsapp-web/:influencerId`. */
export interface AdminWhatsAppWebForceDisconnectAnswer {
  ok: true;
  view: AdminWhatsAppWebView;
}
