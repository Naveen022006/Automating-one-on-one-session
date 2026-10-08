import { toE164 } from "@/lib/phone";

const GRAPH_API = "https://graph.facebook.com/v21.0";

function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set`);
  return v;
}

export interface WhatsAppTemplateComponent {
  type: string;
  parameters?: Array<Record<string, unknown>>;
  [key: string]: unknown;
}

export interface SendWhatsAppInput {
  /** Destination number; normalized to E.164 (default IN) before sending. */
  to: string;
  /** Approved template name. */
  template: string;
  /** Template language code, e.g. "en" or "en_US". */
  languageCode?: string;
  components?: WhatsAppTemplateComponent[];
}

export interface SendResult {
  providerMessageId: string;
}

type FetchFn = typeof fetch;

/**
 * Sends a template message through the WhatsApp Cloud API. Business-initiated messages must use an
 * approved template (see doc/04-messaging.md). The `fetch` function is injectable so tests run with
 * no network. Throws on a non-2xx response (mirrors lib/payments.ts createOrder).
 */
export async function sendWhatsApp(input: SendWhatsAppInput, fetchFn: FetchFn = fetch): Promise<SendResult> {
  const token = env("WHATSAPP_TOKEN");
  const phoneNumberId = env("WHATSAPP_PHONE_NUMBER_ID");
  const to = toE164(input.to) ?? input.to;

  const res = await fetchFn(`${GRAPH_API}/${phoneNumberId}/messages`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to,
      type: "template",
      template: {
        name: input.template,
        language: { code: input.languageCode ?? "en" },
        components: input.components ?? [],
      },
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`WhatsApp send failed (${res.status}): ${body.slice(0, 300)}`);
  }

  const data = (await res.json()) as { messages?: Array<{ id?: string }> };
  const providerMessageId = data.messages?.[0]?.id;
  if (!providerMessageId) {
    throw new Error("WhatsApp send succeeded but no message id was returned");
  }
  return { providerMessageId };
}
