import { recordAudit } from "@/lib/admin/audit";
import { hashToken, randomToken } from "@/lib/auth/tokens";
import { appUrl } from "@/lib/brand";
import { prisma } from "@/lib/db";
import { sendAccountEmail } from "@/lib/email";
import { portalErasedMessage, portalLinkMessage } from "@/lib/email/customer-portal";
import { reportError } from "@/lib/observability";
import { eraseCustomerData } from "@/lib/privacy";
import { hit, IDENTITY_RULES } from "@/lib/rate-limit";
import { buildReceipt, refundedMinorOf, type ReceiptView } from "@/lib/receipts";
import { buildSelfServiceUrl } from "@/lib/self-service";

/**
 * Customer portal ("find your bookings", doc/13-product-build-plan.md WP-D). Customers have no accounts: whoever can read the
 * inbox of the address a booking was made with may see, export and erase that address's bookings. The proof is a random token
 * e-mailed to the address, valid for one hour, stored only as its SHA-256 (a database leak exposes no usable link). It is a
 * different mechanism from the signed manage/pay links (lib/signing.ts): the two cannot be mistaken for each other, because a
 * signed token contains a "." and fails the shape check below, and a portal token fails every signature check.
 */

export const PORTAL_TOKEN_TTL_MS = 60 * 60_000;
/** The list stops at this many bookings (newest first); the data export and the erasure always cover every booking. */
export const PORTAL_LIST_MAX = 200;
const EXPORT_MAX = 1_000;
const COUNT_MAX = 5_000;
const PAID_STATUSES = ["PAID", "SCHEDULED", "COMPLETED"] as const;
const MONEY_STATUSES = ["CAPTURED", "REFUNDED"] as const;
/** The statuses lib/privacy.ts treats as "still live" (not erasable until the session is over). Keep in step with eraseCustomerData. */
const LIVE_STATUSES = ["HELD", "PENDING_PAYMENT", "PAID", "SCHEDULED"];

export function normalisePortalEmail(input: string): string {
  return input.trim().toLowerCase();
}

/* ---------------------------------------------------------------------------------------------------------------- */
/* Asking for a link                                                                                                 */
/* ---------------------------------------------------------------------------------------------------------------- */

export interface PortalLinkDeps {
  send: typeof sendAccountEmail;
  now: () => Date;
}

const defaultLinkDeps: PortalLinkDeps = { send: sendAccountEmail, now: () => new Date() };

/**
 * Starts the "find your bookings" flow. The caller answers the same thing whatever happens here, so it must not wait for `done`:
 * the whole check (the per-address limit, the lookup, the token, the e-mail) runs detached, which keeps the response time the same
 * for an address with bookings, one without, and one that is over its limit. Tests await `done`. Never rejects.
 *
 * The e-mail only goes to an address that has bookings, so the form cannot be used to send mail to strangers; it goes through the
 * platform's own provider, never a host's Gmail.
 */
export function requestPortalLink(emailInput: string, overrides: Partial<PortalLinkDeps> = {}): { done: Promise<void> } {
  const deps = { ...defaultLinkDeps, ...overrides };
  const done = (async () => {
    try {
      const email = normalisePortalEmail(emailInput);
      // Limit per address. The key is a hash so the rate-limit store does not collect customers' e-mail addresses. Over the limit:
      // do nothing, silently (a visible refusal would tell a stranger that the address was asked for before).
      const limited = await hit(IDENTITY_RULES.customerAccessEmail, hashToken(email));
      if (limited && !limited.allowed) return;
      const known = await prisma.booking.findFirst({ where: { customerEmail: email, redactedAt: null }, select: { id: true } });
      if (!known) return;
      const now = deps.now();
      const token = randomToken();
      await prisma.customerAccessToken.deleteMany({ where: { email, expiresAt: { lt: now } } });
      await prisma.customerAccessToken.create({
        data: { tokenHash: hashToken(token), email, expiresAt: new Date(now.getTime() + PORTAL_TOKEN_TTL_MS) },
      });
      await deps.send({ email }, portalLinkMessage(`${appUrl()}/bookings/${token}`), "customer-portal-link");
    } catch (e) {
      // No address and no token in the report.
      reportError(e, { where: "customer-portal-link" });
    }
  })();
  return { done };
}

/** base64url, 20 to 100 characters. The real ones are 43; a signed manage/pay token has a "." and never passes. */
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{20,100}$/;

/** The (normalised) address a valid, unexpired portal token belongs to, or null. */
export async function resolvePortalToken(token: string | null | undefined, now: Date = new Date()): Promise<{ email: string; expiresAt: Date } | null> {
  if (typeof token !== "string" || !TOKEN_SHAPE.test(token)) return null;
  const row = await prisma.customerAccessToken.findUnique({ where: { tokenHash: hashToken(token) }, select: { email: true, expiresAt: true } });
  if (!row || row.expiresAt <= now) return null;
  return row;
}

/* ---------------------------------------------------------------------------------------------------------------- */
/* The list                                                                                                          */
/* ---------------------------------------------------------------------------------------------------------------- */

export interface PortalBooking {
  /** The booking id: the reference customers already see and quote to support. */
  reference: string;
  influencerName: string;
  serviceTitle: string;
  startTime: string;
  durationMin: number;
  status: string;
  statusText: string;
  /** The customer's self-service link, only for a paid session that has not started. */
  manageUrl: string | null;
  receipt: ReceiptView | null;
}

export interface PortalBookings {
  bookings: PortalBooking[];
  /** Bookings under this address that an erasure would erase now (past or never confirmed). */
  erasable: number;
  /** Bookings an erasure keeps: still upcoming, until they are cancelled. */
  blocked: number;
}

/** Pure: the sentence under a booking's title. `moneyKept` = a captured payment that has not been given back in full. */
export function portalStatusText(args: {
  status: string;
  upcoming: boolean;
  paid: { amountMinor: number; refundedMinor: number; needsRefund: boolean; refundInFlight: boolean } | null;
}): string {
  const { status, upcoming, paid } = args;
  if (status === "CANCELLED") {
    if (!paid) return "Cancelled";
    if (paid.refundedMinor >= paid.amountMinor) return paid.refundInFlight ? "Cancelled, refund on its way" : "Cancelled and refunded";
    if (paid.refundedMinor > 0) return "Cancelled, partly refunded";
    return paid.needsRefund ? "Cancelled, refund due" : "Cancelled, no refund due";
  }
  if (status === "PAID" || status === "SCHEDULED") return upcoming ? "Upcoming" : "Completed";
  if (status === "COMPLETED") return "Completed";
  return paid && paid.refundedMinor < paid.amountMinor ? "Paid, session not confirmed. Contact the host" : "Not completed";
}

/** Same rule as `eraseCustomerData`: live (HELD, PENDING_PAYMENT, PAID, SCHEDULED) and not over yet = kept. */
function isLive(b: { status: string; session: { endTime: Date } }, now: Date): boolean {
  return LIVE_STATUSES.includes(b.status) && b.session.endTime > now;
}

async function erasureCounts(email: string, now: Date): Promise<{ erasable: number; blocked: number }> {
  const rows = await prisma.booking.findMany({
    where: { customerEmail: email, redactedAt: null },
    select: { status: true, session: { select: { endTime: true } } },
    take: COUNT_MAX,
  });
  const blocked = rows.filter((b) => isLive(b, now)).length;
  return { erasable: rows.length - blocked, blocked };
}

/**
 * Every booking made with `email` that was ever paid (or still holds a paid session), newest first, except the ones whose data was
 * erased. Holds and requests that never became a payment are not listed; the data export has them.
 */
export async function loadPortalBookings(email: string, now: Date = new Date()): Promise<PortalBookings> {
  const rows = await prisma.booking.findMany({
    where: {
      customerEmail: email,
      redactedAt: null,
      OR: [{ status: { in: [...PAID_STATUSES] } }, { payments: { some: { status: { in: [...MONEY_STATUSES] } } } }],
    },
    orderBy: { session: { startTime: "desc" } },
    take: PORTAL_LIST_MAX,
    select: {
      id: true,
      status: true,
      customerName: true,
      session: {
        select: { startTime: true, endTime: true, service: { select: { title: true, durationMin: true, influencer: { select: { name: true } } } } },
      },
      payments: {
        where: { status: { in: [...MONEY_STATUSES] } },
        select: { status: true, amountMinor: true, currency: true, createdAt: true, providerPaymentId: true, refundAmountMinor: true, refundStatus: true, needsRefund: true },
      },
    },
  });

  const bookings = rows.map((b): PortalBooking => {
    const upcoming = b.session.startTime > now;
    const first = [...b.payments].sort((x, y) => x.createdAt.getTime() - y.createdAt.getTime())[0];
    const paid = first
      ? {
          amountMinor: first.amountMinor,
          refundedMinor: refundedMinorOf(first),
          needsRefund: b.payments.some((p) => p.needsRefund),
          refundInFlight: first.refundStatus === "requested" || first.refundStatus === "pending",
        }
      : null;
    let manageUrl: string | null = null;
    if ((b.status === "PAID" || b.status === "SCHEDULED") && upcoming) {
      try {
        manageUrl = buildSelfServiceUrl(b.id);
      } catch {
        manageUrl = null; // APP_URL / APP_SECRET missing: no link rather than a failed page
      }
    }
    return {
      reference: b.id,
      influencerName: b.session.service.influencer.name,
      serviceTitle: b.session.service.title,
      startTime: b.session.startTime.toISOString(),
      durationMin: b.session.service.durationMin,
      status: b.status,
      statusText: portalStatusText({ status: b.status, upcoming, paid }),
      manageUrl,
      receipt: buildReceipt(
        { id: b.id, customerName: b.customerName, session: { startTime: b.session.startTime, service: { title: b.session.service.title, influencer: b.session.service.influencer } } },
        b.payments,
      ),
    };
  });
  return { bookings, ...(await erasureCounts(email, now)) };
}

/* ---------------------------------------------------------------------------------------------------------------- */
/* Export                                                                                                            */
/* ---------------------------------------------------------------------------------------------------------------- */

export interface PortalExport {
  exportedAt: string;
  email: string;
  bookings: Array<{
    reference: string;
    createdAt: string;
    status: string;
    influencer: string;
    service: string;
    startTime: string;
    endTime: string;
    name: string;
    email: string;
    phone: string;
    timeZone: string | null;
    whatsappOptIn: boolean;
    intakeAnswers: Array<{ question: string; answer: string }>;
    payments: Array<{ amountMinor: number; currency: string; status: string; refundedMinor: number; createdAt: string; paymentReference: string | null }>;
    messages: Array<{ channel: string; template: string; status: string; sentAt: string | null }>;
  }>;
}

function intakeOf(value: unknown): Array<{ question: string; answer: string }> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (item === null || typeof item !== "object") return [];
    const { label, answer } = item as { label?: unknown; answer?: unknown };
    return [{ question: typeof label === "string" ? label : "", answer: typeof answer === "string" ? answer : answer == null ? "" : String(answer) }];
  });
}

/**
 * Everything stored about `email`, field by field: the customer's own details and answers, their payments (no Razorpay order id)
 * and the messages sent to them (no provider ids, no error text). No internal ids but the booking reference, no tokens, no Meet
 * links, and nothing about other customers (a group session shows only this customer's own booking).
 */
export async function buildPortalExport(email: string, now: Date = new Date()): Promise<PortalExport> {
  const rows = await prisma.booking.findMany({
    where: { customerEmail: email, redactedAt: null },
    orderBy: { createdAt: "asc" },
    take: EXPORT_MAX,
    select: {
      id: true,
      createdAt: true,
      status: true,
      customerName: true,
      customerEmail: true,
      whatsappE164: true,
      whatsappOptIn: true,
      customerTz: true,
      intakeAnswers: true,
      session: { select: { startTime: true, endTime: true, service: { select: { title: true, influencer: { select: { name: true } } } } } },
      payments: {
        orderBy: { createdAt: "asc" },
        select: { amountMinor: true, currency: true, status: true, createdAt: true, providerPaymentId: true, refundAmountMinor: true },
      },
      messages: { orderBy: { createdAt: "asc" }, select: { channel: true, template: true, status: true, sentAt: true } },
    },
  });
  return {
    exportedAt: now.toISOString(),
    email,
    bookings: rows.map((b) => ({
      reference: b.id,
      createdAt: b.createdAt.toISOString(),
      status: b.status,
      influencer: b.session.service.influencer.name,
      service: b.session.service.title,
      startTime: b.session.startTime.toISOString(),
      endTime: b.session.endTime.toISOString(),
      name: b.customerName,
      email: b.customerEmail,
      phone: b.whatsappE164,
      timeZone: b.customerTz,
      whatsappOptIn: b.whatsappOptIn,
      intakeAnswers: intakeOf(b.intakeAnswers),
      payments: b.payments.map((p) => ({
        amountMinor: p.amountMinor,
        currency: p.currency,
        status: p.status,
        refundedMinor: refundedMinorOf(p),
        createdAt: p.createdAt.toISOString(),
        paymentReference: p.providerPaymentId,
      })),
      messages: b.messages.map((m) => ({ channel: String(m.channel).toLowerCase(), template: m.template, status: String(m.status).toLowerCase(), sentAt: m.sentAt ? m.sentAt.toISOString() : null })),
    })),
  };
}

/* ---------------------------------------------------------------------------------------------------------------- */
/* Erasure                                                                                                           */
/* ---------------------------------------------------------------------------------------------------------------- */

export interface PortalErasure {
  erased: number;
  blocked: number;
}

/**
 * Erases the address's personal data from every host's bookings through the same function the host's "Erase" button uses
 * (lib/privacy.ts: upcoming live bookings stay until cancelled, payment rows stay for accounting). Idempotent: a second call finds
 * nothing and changes nothing. When nothing is kept any more the address's access links are deleted too, so the page that was just
 * emptied cannot be opened again; while upcoming bookings remain they stay valid so the customer can cancel and finish the job.
 *
 * Records one system audit row without the address, and e-mails the customer a confirmation, only when something was erased.
 */
export async function erasePortalData(
  email: string,
  now: Date = new Date(),
  deps: { send: typeof sendAccountEmail } = { send: sendAccountEmail },
): Promise<PortalErasure> {
  const rows = await prisma.booking.findMany({
    where: { customerEmail: email, redactedAt: null },
    select: { session: { select: { service: { select: { influencerId: true } } } } },
    take: COUNT_MAX,
  });
  const influencerIds = [...new Set(rows.map((r) => r.session.service.influencerId))];
  let erased = 0;
  let blocked = 0;
  for (const influencerId of influencerIds) {
    const r = await eraseCustomerData(influencerId, email, now);
    erased += r.erased;
    blocked += r.blocked;
  }
  if (blocked === 0) await prisma.customerAccessToken.deleteMany({ where: { email } });
  if (erased > 0) {
    try {
      await recordAudit({ adminId: null, email: "system:customer-request" }, { action: "customer.erased", detail: { erased, blocked } });
    } catch (e) {
      reportError(e, { where: "customer-erase-audit" });
    }
    await deps.send({ email }, portalErasedMessage({ erased, blocked }), "customer-portal-erased");
  }
  return { erased, blocked };
}
