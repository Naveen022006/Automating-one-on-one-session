/**
 * Customer message templates (WhatsApp + SMS fallback). The WhatsApp template NAMES are fixed here and must be
 * approved in Meta's WhatsApp Manager with exactly these names and the same number of body variables, in this
 * order. The SMS fallback text is rendered from the same values so both channels say the same thing, with the
 * session time in the customer's timezone (never a raw ISO timestamp).
 *
 * Two names per template. The KEY (booking-confirmation, ...) is what the rest of the app stores and passes around:
 * message rows, job data, the stored template status. The META NAME is what is sent to Meta, which only allows
 * lowercase letters, digits and underscores in a template name, and carries our prefix `sa_` so it cannot clash with a
 * template the influencer already has on their account (a template called "reschedule" with other text would otherwise
 * be mistaken for ours and every send would fail on the wrong number of parameters). They are translated only at the
 * Graph boundary (lib/whatsapp.ts, lib/whatsapp-connect.ts, the template status webhook).
 *
 *   Key                    Meta name                Body variables ({{n}})               Body submitted to Meta (see TEMPLATE_SPECS)
 *   booking-confirmation   sa_booking_confirmation  1 link, 2 service, 3 host, 4 time   "Your booking is confirmed. Join link: {{1}} Session: {{2}} with {{3}} on {{4}}. See you there."
 *   reminder-24h           sa_reminder_24h          1 link, 2 service, 3 host, 4 time   "Reminder: your session is tomorrow. Join link: {{1}} Session: {{2}} with {{3}} on {{4}}. See you soon."
 *   reminder-15m           sa_reminder_15m          1 link, 2 service, 3 host, 4 time   "Your session starts in 15 minutes. Join link: {{1}} Session: {{2}} with {{3}} on {{4}}. See you there."
 *   reschedule             sa_reschedule            1 link, 2 service, 3 host, 4 time   "Your session was rescheduled. Updated link: {{1}} Session: {{2}} with {{3}}, now on {{4}}. See you then."
 *   cancellation           sa_cancellation          1 service, 2 host, 3 time           "Your session was cancelled. Session: {{1}} with {{2}} on {{3}}. Any refund follows the cancellation policy."
 *
 * A template that already has one of these names on the account is used only if it has the same number of variables as
 * ours (templateConflict); otherwise it is reported and not used. Its wording is not compared: see templateConflict.
 *
 * Meta rejects a template body that starts or ends with a variable, so each body begins and ends with fixed text.
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
  /** The name submitted to and sent through Meta (see the header: lowercase letters, digits, underscores). */
  meta: string;
  params: Field[];
  sms: (c: Required<{ [K in Field]: string }>) => string;
}

const LINK_PENDING = "(link coming soon)";

const DEFS: Record<string, TemplateDef> = {
  "booking-confirmation": {
    meta: "sa_booking_confirmation",
    params: ["link", "serviceTitle", "influencerName", "when"],
    sms: (c) => `Your ${c.serviceTitle} session with ${c.influencerName} on ${c.when} is confirmed. Join here: ${c.link}`,
  },
  "reminder-24h": {
    meta: "sa_reminder_24h",
    params: ["link", "serviceTitle", "influencerName", "when"],
    sms: (c) => `Reminder: ${c.serviceTitle} with ${c.influencerName} is tomorrow, ${c.when}. Join link: ${c.link}`,
  },
  "reminder-15m": {
    meta: "sa_reminder_15m",
    params: ["link", "serviceTitle", "influencerName", "when"],
    sms: (c) => `${c.serviceTitle} with ${c.influencerName} starts in 15 minutes (${c.when}). Join here: ${c.link}`,
  },
  reschedule: {
    meta: "sa_reschedule",
    params: ["link", "serviceTitle", "influencerName", "when"],
    sms: (c) => `Your ${c.serviceTitle} session with ${c.influencerName} was moved to ${c.when}. Updated link: ${c.link}`,
  },
  cancellation: {
    meta: "sa_cancellation",
    params: ["serviceTitle", "influencerName", "when"],
    sms: (c) => `Your ${c.serviceTitle} session with ${c.influencerName} on ${c.when} was cancelled. Any refund follows our policy.`,
  },
};

export const KNOWN_TEMPLATES = Object.keys(DEFS);

/** Meta's rule for a template name: lowercase letters, digits and underscores, at most 512 characters. */
export const META_TEMPLATE_NAME = /^[a-z0-9_]{1,512}$/;

export function isMetaTemplateName(name: string): boolean {
  return META_TEMPLATE_NAME.test(name);
}

/** The name Meta knows a template by. A key we do not know is passed through unchanged. */
export function metaTemplateName(key: string): string {
  return DEFS[key]?.meta ?? key;
}

/**
 * Meta's template status as we store it. Meta reports a flagged template that recovered as REINSTATED, which means it is
 * approved again. Everything else is kept as Meta says it (FLAGGED stays FLAGGED so the settings card can say so).
 */
export function normalizeTemplateStatus(status: string): string {
  const s = status.trim().toUpperCase();
  return s === "REINSTATED" ? "APPROVED" : s;
}

/**
 * THE rule for "can a message be sent with a template in this status", used by the sender, the checklist and the settings
 * card so they cannot disagree. Approved, and FLAGGED: Meta flags a template whose quality is dropping but keeps
 * delivering it until it pauses it, so we keep using it (the card shows it as low quality).
 */
export function isSendableStatus(status: string | undefined): boolean {
  return status === "APPROVED" || status === "FLAGGED";
}

/**
 * Statuses that mean "this template will not be sent unless someone acts", as opposed to waiting for a review. CONFLICT is
 * ours: a template with that name already exists on the account with different text, so we did not adopt it.
 */
export const BLOCKED_TEMPLATE_STATUSES = new Set(["REJECTED", "PAUSED", "DISABLED", "DELETED", "PENDING_DELETION", "LIMIT_EXCEEDED", "CONFLICT"]);

export type TemplateState = "ready" | "pending" | "rejected" | "not-submitted";

/**
 * Where a set of template statuses stands, worst first: `rejected` (Meta rejected, paused or disabled at least one, or it
 * cannot be used: needs the influencer's attention), `not-submitted` (at least one never reached Meta: a sync would send
 * it), `pending` (everything submitted, Meta is still reviewing), `ready` (all sendable). `NOT_SUBMITTED` is our own marker
 * for a template with no status stored. Pure, and shared with the settings card in the browser.
 */
export function templateState(statuses: string[]): TemplateState {
  if (statuses.some((s) => BLOCKED_TEMPLATE_STATUSES.has(s))) return "rejected";
  if (statuses.includes("NOT_SUBMITTED")) return "not-submitted";
  return statuses.every((s) => isSendableStatus(s)) ? "ready" : "pending";
}

/** The label (and colour) the settings card shows for each template status, so none is shown as something it is not. */
export const TEMPLATE_STATUS_LABELS: Record<string, { label: string; tone?: "success" | "warning" | "danger" }> = {
  APPROVED: { label: "Approved", tone: "success" },
  FLAGGED: { label: "Low quality, still sent", tone: "warning" },
  PENDING: { label: "In review", tone: "warning" },
  IN_APPEAL: { label: "In review", tone: "warning" },
  REJECTED: { label: "Rejected", tone: "danger" },
  PAUSED: { label: "Paused", tone: "danger" },
  DISABLED: { label: "Disabled", tone: "danger" },
  DELETED: { label: "Deleted", tone: "danger" },
  PENDING_DELETION: { label: "Being deleted", tone: "danger" },
  LIMIT_EXCEEDED: { label: "Over its limit", tone: "danger" },
  CONFLICT: { label: "Name already used", tone: "danger" },
  NOT_SUBMITTED: { label: "Not submitted" },
};

/**
 * What to tell the influencer about each state that is not ready. One text, used by the go-live checklist and by the
 * settings card, so the two say the same thing about the same state (and only `pending` mentions a review).
 */
export const TEMPLATE_STATE_NOTICE: Record<Exclude<TemplateState, "ready">, { title: string; body: string }> = {
  pending: {
    title: "Meta is reviewing your message templates",
    body: "Meta is reviewing your message templates, usually within minutes to a day. Until each one is approved, customers get that message by SMS.",
  },
  rejected: {
    title: "Some message templates cannot be used",
    body: "Meta rejected, paused or disabled a message template, or it cannot be used (deleted, over its limit, or its name is taken by a different template on your account). Customers get those messages by SMS until it is fixed. The reason is shown next to each template.",
  },
  "not-submitted": {
    title: "Some message templates were never sent to Meta",
    body: "Some message templates were never sent to Meta for review. Customers get those messages by SMS until you press Check template status.",
  },
};

/** Back from Meta's name (as seen in the template list and status webhooks) to our key, or null if it is not one of ours. */
export function templateKeyFromMetaName(name: string): string | null {
  return Object.keys(DEFS).find((key) => DEFS[key].meta === name) ?? null;
}

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

export interface TemplateSpec {
  /** The name to submit to Meta (metaTemplateName(key)). */
  name: string;
  /** Body text with {{n}} placeholders, in the same order as the parameters sent by whatsappComponents(). */
  body: string;
  /** One realistic example per variable (Meta requires examples for review). */
  examples: string[];
}

const EXAMPLES = {
  link: "https://meet.google.com/abc-defg-hij",
  serviceTitle: "Career call",
  influencerName: "Sam Rao",
  when: "Mon, 12 Oct 2026, 11:00 am IST",
} satisfies Record<Field, string>;

const BODIES: Record<string, string> = {
  "booking-confirmation": "Your booking is confirmed. Join link: {{1}} Session: {{2}} with {{3}} on {{4}}. See you there.",
  "reminder-24h": "Reminder: your session is tomorrow. Join link: {{1}} Session: {{2}} with {{3}} on {{4}}. See you soon.",
  "reminder-15m": "Your session starts in 15 minutes. Join link: {{1}} Session: {{2}} with {{3}} on {{4}}. See you there.",
  reschedule: "Your session was rescheduled. Updated link: {{1}} Session: {{2}} with {{3}}, now on {{4}}. See you then.",
  cancellation: "Your session was cancelled. Session: {{1}} with {{2}} on {{3}}. Any refund follows the cancellation policy.",
};

/** What gets submitted to each influencer's WhatsApp Business Account for approval, keyed by our template key. */
export const TEMPLATE_SPECS: Record<string, TemplateSpec> = Object.fromEntries(
  Object.entries(DEFS).map(([key, d]) => [key, { name: d.meta, body: BODIES[key], examples: d.params.map((f) => EXAMPLES[f]) }]),
);

const variableCount = (text: string) => new Set([...text.matchAll(/\{\{\s*(\d+)\s*\}\}/g)].map((m) => m[1])).size;

/**
 * Why a template found on the account under one of our names is NOT ours to send with, or null. Only the number of
 * variables is compared, because that is the one thing a send depends on: our parameters are sent to the template, and a
 * template with another number of them fails every time.
 *
 * The wording is deliberately not compared. Under the `sa_` prefix a template with one of our names is one an earlier
 * sync created, possibly from an older wording of BODIES; comparing text would flip every influencer's approved
 * templates to CONFLICT, and WhatsApp would stop for all of them, the first time anyone rewords a message. (Comparing the
 * text only mattered when our names were plain ones like "reschedule", which an influencer could already have used for
 * something else; with the prefix that case is no longer reachable in practice.) A template whose text Meta did not show
 * cannot be compared, and is given the benefit of the doubt for the same reason.
 */
export function templateConflict(existingBody: string | null | undefined, spec: TemplateSpec): string | null {
  if (existingBody == null) return null;
  const have = variableCount(existingBody);
  const want = variableCount(spec.body);
  return have === want ? null : `it has ${have} variable${have === 1 ? "" : "s"} and our message needs ${want}`;
}
