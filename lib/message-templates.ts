/**
 * Customer message templates (WhatsApp + SMS fallback). The WhatsApp template NAMES are fixed here and must be
 * approved in Meta's WhatsApp Manager with exactly these names and the same number of body variables, in this
 * order. The SMS fallback text is rendered from the same values so both channels say the same thing, with the
 * session time in Indian Standard Time, "Mon, 12 Oct 2026, 11:00 AM IST" (never a raw ISO timestamp).
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
 * The four booking-request messages (services that need the host's approval, doc/16-request-whatsapp-flow.md):
 *   request-received       sa_request_received      1 service, 2 host, 3 time, 4 wait, 5 booking link
 *   request-approved       sa_request_approved      1 service, 2 host, 3 time, 4 amount, 5 pay by, 6 payment link, 7 booking link
 *   request-declined       sa_request_declined      1 service, 2 host, 3 time, 4 note sentence, 5 booking page
 *   request-expired        sa_request_expired       1 service, 2 host, 3 time, 4 booking page
 *   (bodies in BODIES below). Their extra values (payment link, pay-by time, amount, ...) are worked out when the message is SENT
 *   (lib/request-message-context.ts), never stored in a job.
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
  /** Already formatted in Indian Standard Time, e.g. "Mon, 12 Oct 2026, 11:00 AM IST" (lib/format.ts formatSessionTime). */
  when: string;
  /** The customer's signed manage/status page, when one could be built (APP_URL / APP_SECRET set). Carried by the request-received message. */
  manageUrl?: string | null;
  /** request-approved: the customer's payment link. A BEARER link: never logged, never stored, built when the message is sent. */
  payUrl?: string | null;
  /** request-approved: when the time to pay ends, already formatted in IST ("Tue, 13 Oct 2026, 6:00 PM IST"). */
  payBy?: string;
  /** request-approved: the price, already formatted in rupees ("₹499.00"). */
  amount?: string;
  /** request-declined / request-expired: the influencer's public booking page ("https://.../slug"), to pick another time. */
  bookingPageUrl?: string | null;
  /** request-received: how long the host has to answer, in hours (the request's hold). */
  decideWithinHours?: number;
  /** request-declined: the note the host left for the customer, plain text; empty or absent when there is none. */
  reason?: string | null;
}

/** The values a template can take, in the words the body uses. Each is a plain string by the time it reaches a body (see `values`). */
type Field = "link" | "serviceTitle" | "influencerName" | "when" | "manageUrl" | "payUrl" | "payBy" | "amount" | "bookingPageUrl" | "decideWithin" | "note";

interface TemplateDef {
  /** The name submitted to and sent through Meta (see the header: lowercase letters, digits, underscores). */
  meta: string;
  params: Field[];
  sms: (c: Record<Field, string>) => string;
}

const LINK_PENDING = "(link coming soon)";
const LINK_UNAVAILABLE = "(link unavailable)";
/** The sentence a decline carries when the host left no note (a template parameter cannot be empty, so it is a sentence, not a blank). */
const NO_NOTE = "No reason was given.";

/**
 * How long the host has to answer a request, in words: "2 days" from 48 hours, "36 hours", "1 hour", and "a short time" under an hour.
 * Whole hours, rounded down with a quarter of an hour of slack (a request made a few seconds ago still has "2 days", not "47 hours"),
 * so the customer is never promised more time than there is.
 */
export function describeWait(hours: number): string {
  if (!(hours >= 1)) return "a short time";
  const h = Math.floor(hours + 0.25);
  if (h >= 48) return `${Math.floor(h / 24)} days`;
  return h <= 1 ? "1 hour" : `${h} hours`;
}

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
  "request-received": {
    meta: "sa_request_received",
    params: ["serviceTitle", "influencerName", "when", "decideWithin", "manageUrl"],
    sms: (c) =>
      `Request received: ${c.serviceTitle} with ${c.influencerName}, ${c.when}. ${c.influencerName} has ${c.decideWithin} to answer. Nothing is charged yet. If accepted, the payment link follows. Your booking: ${c.manageUrl}`,
  },
  "request-approved": {
    meta: "sa_request_approved",
    params: ["serviceTitle", "influencerName", "when", "amount", "payBy", "payUrl", "manageUrl"],
    sms: (c) =>
      `Request accepted: ${c.serviceTitle} with ${c.influencerName}, ${c.when}. Pay ${c.amount} by ${c.payBy} to confirm, or the time is released. Pay here: ${c.payUrl}`,
  },
  "request-declined": {
    meta: "sa_request_declined",
    params: ["serviceTitle", "influencerName", "when", "note", "bookingPageUrl"],
    sms: (c) => `Request not accepted: ${c.serviceTitle} with ${c.influencerName}, ${c.when}. ${c.note} You were not charged. Pick another time: ${c.bookingPageUrl}`,
  },
  "request-expired": {
    meta: "sa_request_expired",
    params: ["serviceTitle", "influencerName", "when", "bookingPageUrl"],
    sms: (c) =>
      `Request not confirmed in time: ${c.serviceTitle} with ${c.influencerName}, ${c.when}. You were not charged. Request a time again: ${c.bookingPageUrl}`,
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

/** What the settings card calls each template (by key). Used wherever a template is named to an influencer, never the key. */
export const TEMPLATE_LABELS: Record<string, string> = {
  "booking-confirmation": "Booking confirmation",
  "reminder-24h": "Reminder, 24 hours before",
  "reminder-15m": "Reminder, 15 minutes before",
  reschedule: "Session rescheduled",
  cancellation: "Session cancelled",
  "request-received": "Request received",
  "request-approved": "Request accepted (payment link)",
  "request-declined": "Request declined",
  "request-expired": "Request expired",
};
export const templateLabel = (key: string): string => TEMPLATE_LABELS[key] ?? key;

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

/**
 * Meta's documented reasons for rejecting a message template (`rejected_reason` in the template list, `reason` in the status
 * webhook), in words an influencer can read. Anything else Meta might send is handled by templateReasonText.
 */
export const TEMPLATE_REJECTION_REASONS: Record<string, string> = {
  ABUSIVE_CONTENT: "Meta thought the wording was abusive or threatening.",
  INCORRECT_CATEGORY: "Meta decided the category this message was filed under does not fit what it says.",
  INVALID_FORMAT: "Meta did not accept the layout of the message, for example how its variables are placed.",
  PROMOTIONAL: "Meta read the message as promotional, which its category does not allow.",
  SCAM: "Meta suspected the wording of being a scam.",
  TAG_CONTENT_MISMATCH: "The wording did not match the category it was submitted under.",
};

/** What to do about a rejected template: it is our wording, not the influencer's, and nothing here resubmits it. */
export const TEMPLATE_REJECTION_NEXT_STEP =
  "The wording is ours, so you cannot change it here: contact support and we will look at it. Until it is approved, customers get this message by SMS.";

/**
 * The line shown under a template on the settings card. Meta's reason codes (INVALID_FORMAT, ...) become a sentence, and a
 * rejected template also says what happens next (TEMPLATE_REJECTION_NEXT_STEP: this platform does not resubmit a template Meta
 * rejected, so someone has to look at it). A reason that is already a sentence (our "name already used" text) is shown as it
 * is, and a status with no reason shows nothing, except a rejection, which says Meta gave none. Pure, and shared with the card.
 */
export function templateReasonText(status: string, reason: string | null | undefined): string | null {
  const raw = (reason ?? "").trim();
  const none = raw === "" || raw === "NONE";
  const code = /^[A-Z][A-Z0-9_]*$/.test(raw) ? raw : null;
  const rejected = status === "REJECTED";
  if (none) return rejected ? `Meta did not say why it rejected this message. ${TEMPLATE_REJECTION_NEXT_STEP}` : null;
  if (!code) return raw;
  const sentence = TEMPLATE_REJECTION_REASONS[code] ?? `Meta gave this reason: ${code.toLowerCase().replace(/_/g, " ")}.`;
  return rejected ? `${sentence} ${TEMPLATE_REJECTION_NEXT_STEP}` : sentence;
}

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

function values(c: MessageContext): Record<Field, string> {
  return {
    link: c.link || LINK_PENDING,
    serviceTitle: c.serviceTitle,
    influencerName: c.influencerName,
    when: c.when,
    manageUrl: c.manageUrl || LINK_UNAVAILABLE,
    payUrl: c.payUrl || LINK_UNAVAILABLE,
    payBy: c.payBy ?? "",
    amount: c.amount ?? "",
    bookingPageUrl: c.bookingPageUrl || LINK_UNAVAILABLE,
    decideWithin: c.decideWithinHours !== undefined ? describeWait(c.decideWithinHours) : "a couple of days",
    // The whole sentence is the parameter, so a decline with no note does not print an empty quote.
    note: c.reason?.trim() ? `Their note: "${c.reason.trim()}".` : NO_NOTE,
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
  manageUrl: "https://example.com/manage/abc123",
  payUrl: "https://example.com/pay/abc123",
  payBy: "Tue, 13 Oct 2026, 6:00 pm IST",
  amount: "₹499.00",
  bookingPageUrl: "https://example.com/sam-rao",
  decideWithin: "2 days",
  note: 'Their note: "I am away that week".',
} satisfies Record<Field, string>;

const BODIES: Record<string, string> = {
  "booking-confirmation": "Your booking is confirmed. Join link: {{1}} Session: {{2}} with {{3}} on {{4}}. See you there.",
  "reminder-24h": "Reminder: your session is tomorrow. Join link: {{1}} Session: {{2}} with {{3}} on {{4}}. See you soon.",
  "reminder-15m": "Your session starts in 15 minutes. Join link: {{1}} Session: {{2}} with {{3}} on {{4}}. See you there.",
  reschedule: "Your session was rescheduled. Updated link: {{1}} Session: {{2}} with {{3}}, now on {{4}}. See you then.",
  cancellation: "Your session was cancelled. Session: {{1}} with {{2}} on {{3}}. Any refund follows the cancellation policy.",
  "request-received":
    "Your booking request was received. Session: {{1}} with {{2}} on {{3}}. The host has {{4}} to answer. Nothing has been charged. If it is accepted, the payment link will be sent here. Your booking: {{5}} Thank you.",
  "request-approved":
    "Your booking request was accepted. Session: {{1}} with {{2}} on {{3}}. Amount: {{4}}. Pay by {{5}} or the time is released. Payment link: {{6}} Your booking: {{7}} Thank you.",
  "request-declined":
    "Your booking request was not accepted. Session: {{1}} with {{2}} on {{3}}. {{4}} You were not charged. Pick another time: {{5}} Thank you.",
  "request-expired":
    "Your booking request was not confirmed in time. Session: {{1}} with {{2}} on {{3}}. You were not charged. Request a time again: {{4}} Thank you.",
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
