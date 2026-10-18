/**
 * Which booking states each customer message may be sent in. ONE table, read by the sender (lib/messaging.ts) and by the
 * linked-number queue's booking check (lib/whatsapp-web/booking-guard.ts), so the two can never disagree about a message
 * that exists in both. Pure (no imports), so it is tested without a database.
 *
 * Two families:
 *  - the five booking events (confirmation, two reminders, reschedule, cancellation). Their rule is what the code did
 *    before this table existed. The sender allows paid, scheduled and completed bookings (plus cancelled for the cancellation
 *    notice); the linked-number queue is deliberately STRICTER for reminders (only SCHEDULED) and reschedule notices (only
 *    PAID or SCHEDULED), because it checks again right before the send, after the message may have waited. A test pins that
 *    the queue's states are always a subset of the sender's;
 *  - the four booking-request messages (services that need the host's approval). They have ONE rule for both routes, which
 *    reads the booking's facts, not only its status: whether the host decided, whether the request was ever approved, and
 *    whether the hold is still alive.
 *
 * Read at run time, never trusted from enqueue time: the booking may have changed since the job was queued.
 */

export const REQUEST_RECEIVED_TEMPLATE = "request-received";
export const REQUEST_APPROVED_TEMPLATE = "request-approved";
export const REQUEST_DECLINED_TEMPLATE = "request-declined";
export const REQUEST_EXPIRED_TEMPLATE = "request-expired";

/** The messages a customer gets along the booking-request flow (template keys, as stored on message rows and in job data). */
export const REQUEST_MESSAGE_KINDS = [REQUEST_RECEIVED_TEMPLATE, REQUEST_APPROVED_TEMPLATE, REQUEST_DECLINED_TEMPLATE, REQUEST_EXPIRED_TEMPLATE] as const;
export type RequestMessageKind = (typeof REQUEST_MESSAGE_KINDS)[number];

export function isRequestMessageKind(template: string): template is RequestMessageKind {
  return (REQUEST_MESSAGE_KINDS as readonly string[]).includes(template);
}

/** What the rule needs to know about a booking. All of it is read from the database when the message runs. */
export interface BookingFacts {
  status: string;
  /** When the booking's hold ends: the request's answer-by time while REQUESTED, the pay-by time once approved. */
  holdExpiresAt: Date | null;
  /** Set when the host approved or declined a request (null for a booking that never was a decided request). */
  decidedAt: Date | null;
  /** The booking's service asks the host to approve each booking. */
  requiresApproval: boolean;
  /** The booking has a payment row of any status. A declined or expired request never has one (nothing is payable before approval). */
  hasPayment: boolean;
  /** The customer was really sent the "request received" message (a sent, delivered or read row on any customer channel). */
  receivedDelivered: boolean;
}

/** `sender`: lib/messaging.ts. `queue`: the linked number's booking check, asked again right before each send. */
export type SendPath = "sender" | "queue";

/**
 * How a customer message can actually reach the customer for one influencer right now (lib/message-route.ts): their linked WhatsApp
 * number, their official WhatsApp connection WITH the template approved, SMS configured for that message, or nothing. `none` means a
 * queued job could only fail, so nothing is queued and the dashboard says so.
 */
export const DELIVERY_ROUTES = ["whatsapp-linked", "whatsapp-official", "sms", "none"] as const;
export type DeliveryRoute = (typeof DELIVERY_ROUTES)[number];

const PAID_OR_AFTER = ["PAID", "SCHEDULED", "COMPLETED"] as const;

/** The five booking events: the states each may be sent in, per route. A template that is not listed gets `UNLISTED`. */
const BOOKING_EVENT_STATUSES: Record<string, { sender: readonly string[]; queue: readonly string[] }> = {
  "booking-confirmation": { sender: PAID_OR_AFTER, queue: PAID_OR_AFTER },
  "reminder-24h": { sender: PAID_OR_AFTER, queue: ["SCHEDULED"] },
  "reminder-15m": { sender: PAID_OR_AFTER, queue: ["SCHEDULED"] },
  reschedule: { sender: PAID_OR_AFTER, queue: ["PAID", "SCHEDULED"] },
  // A cancellation notice is the one message that is meant for a CANCELLED booking.
  cancellation: { sender: [...PAID_OR_AFTER, "CANCELLED"], queue: [...PAID_OR_AFTER, "CANCELLED"] },
};
/** A template with no entry (and a queue request that does not say what it is): the widest rule the first versions used. */
const UNLISTED: { sender: readonly string[]; queue: readonly string[] } = { sender: PAID_OR_AFTER, queue: [...PAID_OR_AFTER, "CANCELLED"] };

/** The states a template may be sent in, for the five booking events (and any unlisted template). Null for a request message, whose rule reads more than the status. */
export function statusesFor(template: string, route: SendPath): readonly string[] | null {
  if (isRequestMessageKind(template)) return null;
  return (BOOKING_EVENT_STATUSES[template] ?? UNLISTED)[route];
}

/** The hold is still running: a payment link or a "your request is open" notice for a lapsed one would be wrong. */
function holdAlive(f: BookingFacts, now: Date): boolean {
  return f.holdExpiresAt !== null && f.holdExpiresAt.getTime() > now.getTime();
}

/**
 * True when `template` still makes sense for a booking in this state. The caller has already dealt with erased customer data and a
 * missing WhatsApp opt-in (both always skip). `route` only matters for the five booking events.
 *
 *  - request-received: still a REQUESTED booking whose hold is running;
 *  - request-approved: approved (decided) and not yet paid: HELD, or PENDING_PAYMENT when the customer already opened the payment;
 *    PAID and SCHEDULED are excluded because the confirmation follows. The pay-by time must be ahead;
 *  - request-declined: CANCELLED, decided and never paid. Declining is the only way a booking that was never paid gets CANCELLED (a
 *    customer, host or administrator can cancel only a paid or scheduled booking, and that has a payment), so this is exactly a declined
 *    request, whatever the service's approval setting is today (a host who turned approval off can still decline the backlog);
 *  - request-expired: EXPIRED, never decided, never paid, and the service needs approval: an ordinary hold that lapsed also has no
 *    decision, so the service's setting is what tells a request from it (the worker only queues this for a booking it expired from
 *    REQUESTED; the check guards against a stray job). An approved hold that lapsed unpaid is NOT this message: the host decided.
 *    Only for a customer who was told about the request in the first place: "not confirmed in time" about something they never heard
 *    of is a message to a stranger (a number typed into the booking form by someone else), so without a delivered "request received"
 *    it is not sent.
 */
export function messageMayBeSent(template: string, f: BookingFacts, now: Date, route: SendPath = "sender"): boolean {
  switch (template) {
    case REQUEST_RECEIVED_TEMPLATE:
      return f.status === "REQUESTED" && holdAlive(f, now);
    case REQUEST_APPROVED_TEMPLATE:
      return (f.status === "HELD" || f.status === "PENDING_PAYMENT") && f.decidedAt !== null && holdAlive(f, now);
    case REQUEST_DECLINED_TEMPLATE:
      return f.status === "CANCELLED" && f.decidedAt !== null && !f.hasPayment;
    case REQUEST_EXPIRED_TEMPLATE:
      return f.status === "EXPIRED" && f.decidedAt === null && f.requiresApproval && !f.hasPayment && f.receivedDelivered;
    default:
      return (statusesFor(template, route) ?? []).includes(f.status);
  }
}

/**
 * Takes anything that looks like a payment link out of a piece of text. The payment link is a bearer link (whoever has it can pay for
 * the booking), so it must never reach a log line, a stored error, an alert or a failed job's reason, even when a provider echoes the
 * message back in its error.
 */
export function redactPayLinks(text: string): string {
  return text.replace(/(?:https?:\/\/[^\s"'<>]*)?\/pay\/[^\s"'<>]+/gi, "[payment link]");
}
