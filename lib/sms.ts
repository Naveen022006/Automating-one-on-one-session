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

/**
 * There is no way to send this message by SMS: the provider is not set up, or (MSG91) has no flow for this message. Not a failure of an
 * attempt, so it is never worth retrying; lib/messaging.ts reads it as "no route" for the booking-request messages.
 */
export class NoMessageRouteError extends Error {
  readonly retryable = false;
  constructor(message: string) {
    super(message);
    this.name = "NoMessageRouteError";
  }
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

/**
 * Why this message cannot be sent by SMS with the settings in `env`, or null when it can: the provider's credentials, and for MSG91 a
 * flow id for this message type (its own `MSG91_TEMPLATE_<NAME>` or the default). `MESSAGING_DRY_RUN` logs instead of sending, so it is
 * always possible. The one answer is read by `sendSMS` (which refuses to send) and by lib/message-route.ts (which decides whether to
 * queue a message at all), so the two can never disagree.
 */
export function smsConfigProblem(template: string | undefined, env: NodeJS.ProcessEnv = process.env): string | null {
  if (env.MESSAGING_DRY_RUN === "true") return null;
  const missing = (...names: string[]) => names.filter((n) => !env[n]);
  const provider = (env.SMS_PROVIDER || "generic").toLowerCase();
  if (provider === "msg91") {
    if (missing("SMS_API_KEY").length) return "SMS is not set up (SMS_API_KEY is missing)";
    const own = template ? env[templateEnvName(template)] : undefined;
    if (!own && !env.MSG91_TEMPLATE_DEFAULT) return "SMS has no flow for this message (its MSG91_TEMPLATE_* and MSG91_TEMPLATE_DEFAULT are both unset)";
    return null;
  }
  if (provider === "twilio") {
    if (missing("TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN").length) return "SMS is not set up (Twilio credentials are missing)";
    if (!env.TWILIO_MESSAGING_SERVICE_SID && !env.TWILIO_FROM) return "SMS is not set up (Twilio has no sender)";
    return null;
  }
  return missing("SMS_API_URL", "SMS_API_KEY").length ? "SMS is not set up (SMS_API_URL / SMS_API_KEY are missing)" : null;
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
  const problem = smsConfigProblem(input.template);
  if (problem) throw new NoMessageRouteError(problem);
  const provider = (process.env.SMS_PROVIDER || "generic").toLowerCase();
  if (provider === "msg91") return sendViaMsg91(input, to, fetchFn);
  if (provider === "twilio") return sendViaTwilio(input, to, fetchFn);
  return sendViaGeneric(input, to, fetchFn);
}
