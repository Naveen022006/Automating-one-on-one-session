// Pure helpers for the WhatsApp delivery-status webhook. Kept out of the route file so they can be
// unit-tested without a server or DB.

import { createHmac, timingSafeEqual } from "node:crypto";
import { normalizeTemplateStatus } from "@/lib/message-templates";

export type MessageStatus = "PENDING" | "SENT" | "DELIVERED" | "READ" | "FAILED";

/**
 * Verifies Meta's `X-Hub-Signature-256` header against the raw request body, in constant time.
 * The header value is `sha256=` + lowercase hex HMAC-SHA256(rawBody, appSecret). Mirrors
 * verifyWebhookSignature in lib/payments.ts (length-checked timingSafeEqual over raw bytes) so the
 * WhatsApp POST webhook enforces the same trust boundary the payment webhook does.
 */
export function verifyMetaSignature(
  rawBody: string,
  signatureHeader: string | null,
  appSecret: string | undefined,
): boolean {
  if (!signatureHeader || !appSecret) return false;
  // Meta prefixes the hex digest with "sha256="; anything else is malformed.
  const prefix = "sha256=";
  if (!signatureHeader.startsWith(prefix)) return false;
  const hex = signatureHeader.slice(prefix.length);
  const expected = createHmac("sha256", appSecret).update(rawBody).digest();
  let given: Buffer;
  try {
    given = Buffer.from(hex, "hex");
  } catch {
    return false;
  }
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/** Meta's delivery statuses -> our MessageStatus. Unknown values return null (ignored). */
export function mapWhatsAppStatus(status: string): MessageStatus | null {
  switch (status) {
    case "sent":
      return "SENT";
    case "delivered":
      return "DELIVERED";
    case "read":
      return "READ";
    case "failed":
      return "FAILED";
    default:
      return null;
  }
}

/** True when the GET verification handshake should succeed for the given query params. */
export function isVerifyRequestValid(
  mode: string | null,
  token: string | null,
  expectedToken: string | undefined,
): boolean {
  // Constant-time compare of the verify token to avoid a timing side-channel, matching the
  // timingSafeEqual approach verifyWebhookSignature/verifyMetaSignature use.
  return mode === "subscribe" && !!expectedToken && !!token && safeEqual(token, expectedToken);
}

/** Length-checked constant-time string compare (UTF-8 bytes). */
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

export interface WhatsAppStatusUpdate {
  providerMessageId: string;
  status: MessageStatus;
  // Only present (and only set) for FAILED statuses. For non-FAILED transitions the field is
  // omitted so the route leaves the stored error untouched (see Issue 5): a later DELIVERED/READ
  // callback must not null out diagnostic context recorded by a prior FAILED callback.
  error?: string | null;
}

interface MetaStatusPayload {
  entry?: Array<{
    changes?: Array<{
      value?: {
        statuses?: Array<{
          id?: string;
          status?: string;
          errors?: Array<{ title?: string; message?: string; code?: number }>;
        }>;
      };
    }>;
  }>;
}

/**
 * Flattens Meta's entry[].changes[].value.statuses[] into a list of status updates we can apply.
 * Entries with an unknown status or missing id are dropped.
 */
export function parseWhatsAppStatuses(payload: unknown): WhatsAppStatusUpdate[] {
  const body = (payload ?? {}) as MetaStatusPayload;
  const updates: WhatsAppStatusUpdate[] = [];
  for (const entry of body.entry ?? []) {
    for (const change of entry.changes ?? []) {
      for (const s of change.value?.statuses ?? []) {
        const mapped = s.status ? mapWhatsAppStatus(s.status) : null;
        if (!s.id || !mapped) continue;
        if (mapped === "FAILED") {
          const err = s.errors?.[0];
          const error = err ? err.message ?? err.title ?? `error ${err.code ?? ""}`.trim() : null;
          updates.push({ providerMessageId: s.id, status: mapped, error });
        } else {
          // Non-FAILED: omit `error` so the row's existing error is preserved on this transition.
          updates.push({ providerMessageId: s.id, status: mapped });
        }
      }
    }
  }
  return updates;
}

export interface TemplateStatusUpdate {
  wabaId: string;
  name: string;
  language: string;
  /** "APPROVED" | "REJECTED" | "PENDING" | "PAUSED" | "DISABLED" | "FLAGGED" ... as Meta reports it (REINSTATED arrives as APPROVED). */
  status: string;
  reason: string | null;
}

/**
 * Flattens `message_template_status_update` events (Meta tells us when a template is approved or rejected). The
 * `entry.id` is the WhatsApp Business Account id, which is how we find the influencer.
 */
export function parseTemplateStatusUpdates(payload: unknown): TemplateStatusUpdate[] {
  const body = (payload ?? {}) as {
    entry?: Array<{
      id?: string;
      changes?: Array<{ field?: string; value?: { event?: string; message_template_name?: string; message_template_language?: string; reason?: string } }>;
    }>;
  };
  const out: TemplateStatusUpdate[] = [];
  for (const entry of body.entry ?? []) {
    for (const change of entry.changes ?? []) {
      if (change.field !== "message_template_status_update") continue;
      const v = change.value;
      if (!entry.id || !v?.message_template_name || !v.event) continue;
      out.push({
        wabaId: String(entry.id),
        name: v.message_template_name,
        language: v.message_template_language ?? "en",
        status: normalizeTemplateStatus(v.event), // REINSTATED -> APPROVED; FLAGGED stays FLAGGED
        reason: v.reason && v.reason !== "NONE" ? v.reason : null,
      });
    }
  }
  return out;
}
