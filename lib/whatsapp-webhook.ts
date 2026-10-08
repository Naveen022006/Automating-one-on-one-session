// Pure helpers for the WhatsApp delivery-status webhook. Kept out of the route file so they can be
// unit-tested without a server or DB.

export type MessageStatus = "PENDING" | "SENT" | "DELIVERED" | "READ" | "FAILED";

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
  return mode === "subscribe" && !!expectedToken && token === expectedToken;
}

export interface WhatsAppStatusUpdate {
  providerMessageId: string;
  status: MessageStatus;
  error: string | null;
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
        const err = s.errors?.[0];
        const error = err ? err.message ?? err.title ?? `error ${err.code ?? ""}`.trim() : null;
        updates.push({ providerMessageId: s.id, status: mapped, error: mapped === "FAILED" ? error : null });
      }
    }
  }
  return updates;
}
