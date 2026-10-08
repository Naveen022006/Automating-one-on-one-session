import { toE164 } from "@/lib/phone";

// Generic SMS provider HTTP endpoint. Swap this for the chosen provider (MSG91/Twilio) during
// provider onboarding; the request shape is kept in one place so the rest of the app is unaffected.
// DLT registration (sender id + templates) for India is an external/manual step (doc/04-messaging.md).
const SMS_API = process.env.SMS_API_URL ?? "https://api.sms-provider.example.com/v1/messages";

function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set`);
  return v;
}

export interface SendSMSInput {
  /** Destination number; normalized to E.164 (default IN) before sending. */
  to: string;
  /** Message body (fallback plain text with the meeting link). */
  body: string;
}

export interface SendResult {
  providerMessageId: string;
}

type FetchFn = typeof fetch;

/**
 * Sends an SMS through the configured provider. The `fetch` function is injectable so tests run with
 * no network. Throws on a non-2xx response (mirrors lib/whatsapp.ts / lib/payments.ts createOrder).
 */
export async function sendSMS(input: SendSMSInput, fetchFn: FetchFn = fetch): Promise<SendResult> {
  const apiKey = env("SMS_API_KEY");
  const to = toE164(input.to) ?? input.to;

  const res = await fetchFn(SMS_API, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ to, body: input.body }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`SMS send failed (${res.status}): ${body.slice(0, 300)}`);
  }

  const data = (await res.json()) as { id?: string; messageId?: string };
  const providerMessageId = data.messageId ?? data.id;
  if (!providerMessageId) {
    throw new Error("SMS send succeeded but no message id was returned");
  }
  return { providerMessageId };
}
