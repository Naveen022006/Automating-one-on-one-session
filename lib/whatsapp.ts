/**
 * WhatsApp send function (Meta WhatsApp Cloud API).
 *
 * ASSUMPTION / Phase 4 completion: a real WhatsApp send needs a Meta Business account, an approved
 * message template per `template`, a phone-number id, and an access token - none of which are available
 * in this environment, and business-initiated messages are rejected without an approved template. So the
 * default below is a safe log-and-succeed stub when the provider env vars are absent: it exercises the
 * send -> record pipeline (and the SMS fallback) without fabricating credentials or hitting the network.
 *
 * TODO(phase-4): when WHATSAPP_TOKEN + WHATSAPP_PHONE_NUMBER_ID are configured, POST to
 *   https://graph.facebook.com/v20.0/<phone-number-id>/messages
 * with a `template` payload (name = template, components from params) and return the returned message id.
 */

export interface SendResult {
  /** Provider message id, recorded on the Message row. */
  providerId: string;
}

export type SendWhatsApp = (to: string, template: string, params: Record<string, string>) => Promise<SendResult>;

export const sendWhatsAppTemplate: SendWhatsApp = async (to, template, params) => {
  const token = process.env.WHATSAPP_TOKEN;
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  if (!token || !phoneNumberId) {
    // Stub path: no provider configured. Log a structured line so the pipeline is observable and succeed.
    console.log(
      "[whatsapp:stub]",
      JSON.stringify({ to, template, params, note: "WHATSAPP_TOKEN/WHATSAPP_PHONE_NUMBER_ID not set; not actually sent" }),
    );
    return { providerId: `stub-whatsapp-${template}` };
  }
  // TODO(phase-4): real Meta Cloud API call goes here (approved template required).
  throw new Error("WhatsApp provider configured but real delivery is not implemented (Phase 4 completion)");
};
