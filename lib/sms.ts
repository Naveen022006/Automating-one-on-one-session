/**
 * SMS send function (e.g. MSG91 for India).
 *
 * ASSUMPTION / Phase 4 completion: a real SMS send needs a provider account plus DLT registration
 * (sender id + approved templates) for India, and network access - none available here. So the default
 * below is a safe log-and-succeed stub when the provider env vars are absent, used as the fallback when
 * WhatsApp delivery fails. It keeps Phase 5 testable without fabricating credentials or real API calls.
 *
 * TODO(phase-4): when SMS_API_KEY (+ SMS_SENDER_ID) are configured, POST to the provider's send endpoint
 * and return the returned message id.
 */

import type { SendResult } from "@/lib/whatsapp";

export type SendSms = (to: string, body: string) => Promise<SendResult>;

export const sendSms: SendSms = async (to, body) => {
  const apiKey = process.env.SMS_API_KEY;
  if (!apiKey) {
    // Stub path: no provider configured. Log a structured line so the pipeline is observable and succeed.
    console.log("[sms:stub]", JSON.stringify({ to, body, note: "SMS_API_KEY not set; not actually sent" }));
    return { providerId: `stub-sms-${to}` };
  }
  // TODO(phase-4): real SMS provider call goes here (DLT-approved template required for India).
  throw new Error("SMS provider configured but real delivery is not implemented (Phase 4 completion)");
};
