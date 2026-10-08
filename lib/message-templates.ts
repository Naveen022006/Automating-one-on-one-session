/**
 * Customer message templates (WhatsApp + SMS fallback). The WhatsApp template NAMES are fixed here and must be
 * approved in Meta's WhatsApp Manager with exactly these names and the same number of body variables, in this
 * order. The SMS fallback text is rendered from the same values so both channels say the same thing, with the
 * session time in the customer's timezone (never a raw ISO timestamp).
 *
 *   Template               Body variables ({{n}})                                   Suggested approved body
 *   booking-confirmation   1 link, 2 service, 3 host, 4 time   "Your {{2}} session with {{3}} on {{4}} is confirmed. Join here: {{1}}"
 *   reminder-24h           1 link, 2 service, 3 host, 4 time   "Reminder: {{2}} with {{3}} is tomorrow, {{4}}. Join link: {{1}}"
 *   reminder-15m           1 link, 2 service, 3 host, 4 time   "{{2}} with {{3}} starts in 15 minutes ({{4}}). Join here: {{1}}"
 *   reschedule             1 link, 2 service, 3 host, 4 time   "Your {{2}} session with {{3}} was moved to {{4}}. Updated link: {{1}}"
 *   cancellation           1 service, 2 host, 3 time           "Your {{1}} session with {{2}} on {{3}} was cancelled. Any refund follows our policy."
 */

export const CONFIRMATION_TEMPLATE = "booking-confirmation";
export const RESCHEDULE_TEMPLATE = "reschedule";
export const CANCELLATION_TEMPLATE = "cancellation";

export interface MessageContext {
  link: string | null;
  serviceTitle: string;
  influencerName: string;
  /** Already formatted in the customer's timezone, e.g. "Mon, 12 Oct 2026, 11:00 am IST". */
  when: string;
}

type Field = keyof MessageContext;

interface TemplateDef {
  params: Field[];
  sms: (c: Required<{ [K in Field]: string }>) => string;
}

const LINK_PENDING = "(link coming soon)";

const DEFS: Record<string, TemplateDef> = {
  "booking-confirmation": {
    params: ["link", "serviceTitle", "influencerName", "when"],
    sms: (c) => `Your ${c.serviceTitle} session with ${c.influencerName} on ${c.when} is confirmed. Join here: ${c.link}`,
  },
  "reminder-24h": {
    params: ["link", "serviceTitle", "influencerName", "when"],
    sms: (c) => `Reminder: ${c.serviceTitle} with ${c.influencerName} is tomorrow, ${c.when}. Join link: ${c.link}`,
  },
  "reminder-15m": {
    params: ["link", "serviceTitle", "influencerName", "when"],
    sms: (c) => `${c.serviceTitle} with ${c.influencerName} starts in 15 minutes (${c.when}). Join here: ${c.link}`,
  },
  reschedule: {
    params: ["link", "serviceTitle", "influencerName", "when"],
    sms: (c) => `Your ${c.serviceTitle} session with ${c.influencerName} was moved to ${c.when}. Updated link: ${c.link}`,
  },
  cancellation: {
    params: ["serviceTitle", "influencerName", "when"],
    sms: (c) => `Your ${c.serviceTitle} session with ${c.influencerName} on ${c.when} was cancelled. Any refund follows our policy.`,
  },
};

export const KNOWN_TEMPLATES = Object.keys(DEFS);

/**
 * WhatsApp rejects body parameters that are empty or contain newlines, tabs or more than four consecutive
 * spaces (error 132018), so every value is normalised.
 */
export function cleanParam(value: string): string {
  const v = value.replace(/[\r\n\t]+/g, " ").replace(/ {4,}/g, "   ").trim();
  return (v || "-").slice(0, 1000);
}

function values(c: MessageContext): Required<{ [K in Field]: string }> {
  return {
    link: c.link || LINK_PENDING,
    serviceTitle: c.serviceTitle,
    influencerName: c.influencerName,
    when: c.when,
  };
}

function def(template: string): TemplateDef {
  return DEFS[template] ?? DEFS[CONFIRMATION_TEMPLATE];
}

/** Ordered WhatsApp body parameters for `template`. */
export function templateParams(template: string, c: MessageContext): string[] {
  const v = values(c);
  return def(template).params.map((f) => cleanParam(v[f]));
}

/** WhatsApp Cloud API `components` for a template send. */
export function whatsappComponents(template: string, c: MessageContext) {
  return [{ type: "body", parameters: templateParams(template, c).map((text) => ({ type: "text", text })) }];
}

/** Plain-text SMS fallback with the same content. */
export function smsBody(template: string, c: MessageContext): string {
  const v = values(c);
  const clean = Object.fromEntries(Object.entries(v).map(([k, s]) => [k, cleanParam(s)])) as typeof v;
  return def(template).sms(clean);
}
