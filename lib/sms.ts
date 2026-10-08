import { toE164 } from "@/lib/phone";

/**
 * SMS fallback delivery. Provider chosen by SMS_PROVIDER:
 *
 *   msg91   (India) MSG91 Flow API v5. SMS_API_KEY = MSG91 authkey. Each message type needs a DLT-approved flow:
 *           MSG91_TEMPLATE_<NAME> (e.g. MSG91_TEMPLATE_BOOKING_CONFIRMATION) = flow/template id, falling back to
 *           MSG91_TEMPLATE_DEFAULT. The template variables are sent as var1..varN in the order of
 *           lib/message-templates.ts, plus the whole text as `body` for flows that use a single variable.
 *   twilio  Twilio Programmable Messaging. TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, and either
 *           TWILIO_MESSAGING_SERVICE_SID or TWILIO_FROM.
 *   generic (default, legacy) POST {to, body} with a Bearer SMS_API_KEY to SMS_API_URL.
 *
 * MESSAGING_DRY_RUN=true logs instead of sending (local development without provider accounts).
 * India: DLT registration (entity, sender id, content templates) must be complete before SMS is delivered.
 */

export interface SendSMSInput {
  /** Destination number; normalized to E.164 (default IN) before sending. */
  to: string;
  /** Rendered plain-text message. */
  body: string;
  /** Template name (selects the MSG91 flow). */
  template?: string;
  /** Ordered template variables (MSG91 var1..varN). */
  variables?: string[];
}

export interface SendResult {
  providerMessageId: string;
}

type FetchFn = typeof fetch;

function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set`);
  return v;
}

function templateEnvName(template: string): string {
  return `MSG91_TEMPLATE_${template.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}`;
}

async function failOnError(res: Response, provider: string): Promise<void> {
  if (res.ok) return;
  const body = await res.text().catch(() => "");
  throw new Error(`${provider} SMS send failed (${res.status}): ${body.slice(0, 300)}`);
}

export async function sendViaMsg91(input: SendSMSInput, to: string, fetchFn: FetchFn): Promise<SendResult> {
  const templateId =
    (input.template && process.env[templateEnvName(input.template)]) || env("MSG91_TEMPLATE_DEFAULT");
  const recipient: Record<string, string> = { mobiles: to.replace(/^\+/, ""), body: input.body };
  (input.variables ?? []).forEach((v, i) => (recipient[`var${i + 1}`] = v));
  const res = await fetchFn("https://control.msg91.com/api/v5/flow", {
    method: "POST",
    headers: { authkey: env("SMS_API_KEY"), accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({ template_id: templateId, short_url: "0", recipients: [recipient] }),
    signal: AbortSignal.timeout(15_000),
  });
  await failOnError(res, "MSG91");
  const data = (await res.json().catch(() => ({}))) as { type?: string; message?: string };
  if (data.type && data.type !== "success") throw new Error(`MSG91 SMS send failed: ${data.message ?? data.type}`);
  if (!data.message) throw new Error("MSG91 accepted the SMS but returned no request id");
  return { providerMessageId: data.message };
}

export async function sendViaTwilio(input: SendSMSInput, to: string, fetchFn: FetchFn): Promise<SendResult> {
  const sid = env("TWILIO_ACCOUNT_SID");
  const auth = Buffer.from(`${sid}:${env("TWILIO_AUTH_TOKEN")}`).toString("base64");
  const form = new URLSearchParams({ To: to, Body: input.body });
  if (process.env.TWILIO_MESSAGING_SERVICE_SID) form.set("MessagingServiceSid", process.env.TWILIO_MESSAGING_SERVICE_SID);
  else form.set("From", env("TWILIO_FROM"));
  const res = await fetchFn(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(sid)}/Messages.json`, {
    method: "POST",
    headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: form,
    signal: AbortSignal.timeout(15_000),
  });
  await failOnError(res, "Twilio");
  const data = (await res.json()) as { sid?: string };
  if (!data.sid) throw new Error("Twilio accepted the SMS but returned no message sid");
  return { providerMessageId: data.sid };
}

async function sendViaGeneric(input: SendSMSInput, to: string, fetchFn: FetchFn): Promise<SendResult> {
  const res = await fetchFn(env("SMS_API_URL"), {
    method: "POST",
    headers: { Authorization: `Bearer ${env("SMS_API_KEY")}`, "Content-Type": "application/json" },
    body: JSON.stringify({ to, body: input.body }),
    signal: AbortSignal.timeout(15_000),
  });
  await failOnError(res, "SMS");
  const data = (await res.json()) as { id?: string; messageId?: string };
  const providerMessageId = data.messageId ?? data.id;
  if (!providerMessageId) throw new Error("SMS send succeeded but no message id was returned");
  return { providerMessageId };
}

/**
 * Sends an SMS through the configured provider. The `fetch` function is injectable so tests run with no network.
 * Throws on a provider error so the messaging job retries with backoff.
 */
export async function sendSMS(input: SendSMSInput, fetchFn: FetchFn = fetch): Promise<SendResult> {
  const to = toE164(input.to) ?? input.to;
  if (process.env.MESSAGING_DRY_RUN === "true") {
    console.log("[sms:dry-run]", JSON.stringify({ to, template: input.template, body: input.body }));
    return { providerMessageId: `dry-run-sms-${Date.now()}` };
  }
  const provider = (process.env.SMS_PROVIDER || "generic").toLowerCase();
  if (provider === "msg91") return sendViaMsg91(input, to, fetchFn);
  if (provider === "twilio") return sendViaTwilio(input, to, fetchFn);
  return sendViaGeneric(input, to, fetchFn);
}
