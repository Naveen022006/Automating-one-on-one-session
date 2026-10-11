import type { Prisma, PrismaClient } from "@/generated/prisma/client";
import { isLocalAppUrl } from "./provider-endpoints";

/**
 * Removing dummy rows that tests and QA runs left in a shared development database (npm run data:cleanup-test).
 *
 * This file has two halves:
 *   1. PURE classifiers (no database): decide, from a name alone, whether a row is positively test data, protected, or
 *      neither. The rule is deliberately narrow: anything not positively identified is KEPT.
 *   2. planCleanup (read only) and applyCleanup (one transaction), which use the classifiers on the real tables.
 *
 * WHAT COUNTS AS TEST DATA (the documented pattern list)
 *   e-mail (administrator, customer):  the address is lowercase, ends in exactly "@example.com", and its local part
 *       - contains a run of 13 to 16 digits that reads as a millisecond timestamp (2017 to 2099): that is how this
 *         repo's tests and QA runs name their rows (`routes-x-1766000000000@example.com`, `lock-<ts>@...`, `mfa-a-<ts>@...`,
 *         `core-c1-<ts>@...`, `rec<ts>_3@...`), or
 *       - starts with `qa-`, `qac<word>-` or `spa-parity-` (hand-made QA runs, which carry no timestamp).
 *   influencer slug:  lowercase slug that
 *       - is `spa-parity-<n>`, or starts with `qa-` / `qac<word>-`, or
 *       - starts with one of TEST_SLUG_PREFIXES (the first word of the slugs the tests in tests/ generate: ap, ap2, pay,
 *         hs, rd, rec, core, routes, ... ) followed by `-` and has a timestamp run somewhere in the slug.
 *     An influencer is deleted only when ALSO its own e-mail address ends in @example.com (two independent signals),
 *     or when its e-mail is a test e-mail and its slug carries a timestamp. One signal alone is "ambiguous": kept.
 *   webhook event id:  `evt_<ts>...`, `evt_rec_<ts>...`, `recovery:pay_<letters>_<ts>...` (the shapes written by
 *       tests/payments.test.ts and tests/payment-recovery.test.ts), `evt_qa_...`, and `recovery:<id>` where <id> is the
 *       Razorpay payment id of a payment that is being deleted. Real Razorpay event ids never match.
 *
 * PROTECTED (always wins over every pattern, compared case-insensitively and trimmed): the `demo` influencer and its user
 * `demo@example.com`; the administrators admin@example.com, admin1@example.com and admin2@example.com.
 *
 * NEVER TOUCHED: admin_audit_logs (append-only; deleting an administrator only clears the audit rows' admin link through
 * the foreign key, the copied e-mail stays), the demo influencer and its data, protected administrators, queues and Redis,
 * and any row the rules above do not positively identify.
 */

// ---------------------------------------------------------------------------------------------------------------------
// Pure classifiers
// ---------------------------------------------------------------------------------------------------------------------

export const PROTECTED_ADMIN_EMAILS: readonly string[] = ["admin@example.com", "admin1@example.com", "admin2@example.com"];
export const PROTECTED_INFLUENCER_SLUGS: readonly string[] = ["demo"];
/** E-mails of protected accounts (the demo influencer's profile and login). Also protects any influencer that uses one. */
export const PROTECTED_INFLUENCER_EMAILS: readonly string[] = ["demo@example.com"];

/** First word of the slugs that tests/*.test.ts and QA runs generate (`<word>-...<timestamp>...`). */
export const TEST_SLUG_PREFIXES: ReadonlySet<string> = new Set([
  "ap", "ap2", "pay", "hs", "rd", "rec", "msg", "mg", "pl", "po", "cs", "gt", "kr", "wa", "mp", "test", "setup",
  "routes", "core", "mfa", "lock", "sec", "money", "adm", "dup", "owner", "spa", "cleanup",
]);

const norm = (s: string) => s.trim().toLowerCase();

/** True when the string contains a standalone run of 13 to 16 digits whose first 13 read as a plausible epoch in ms. */
export function hasTimestamp(s: string): boolean {
  for (const m of s.match(/(?<!\d)\d{13,16}(?!\d)/g) ?? []) {
    const ms = Number(m.slice(0, 13));
    if (ms >= 1_500_000_000_000 && ms <= 4_100_000_000_000) return true;
  }
  return false;
}

export function isProtectedAdminEmail(email: string): boolean {
  return PROTECTED_ADMIN_EMAILS.includes(norm(email));
}

export function isProtectedInfluencerSlug(slug: string, extra: readonly string[] = []): boolean {
  const s = norm(slug);
  return PROTECTED_INFLUENCER_SLUGS.includes(s) || extra.some((e) => norm(e) === s);
}

export function isProtectedInfluencerEmail(email: string): boolean {
  return PROTECTED_INFLUENCER_EMAILS.includes(norm(email));
}

const QA_PREFIX = /^(?:qa-|qac[a-z0-9]*-)[a-z0-9]/;

/** Shared rule for administrator and customer addresses (see the header). Never true for a protected address. */
function looksLikeTestEmail(email: string): boolean {
  const m = /^([a-z0-9][a-z0-9._+-]*)@example\.com$/.exec(email);
  if (!m) return false;
  if (isProtectedAdminEmail(email) || isProtectedInfluencerEmail(email)) return false;
  const local = m[1];
  return hasTimestamp(local) || QA_PREFIX.test(local) || /^spa-parity-[a-z0-9]/.test(local);
}

export function isTestAdminEmail(email: string): boolean {
  return looksLikeTestEmail(email);
}

export function isTestCustomerEmail(email: string): boolean {
  return looksLikeTestEmail(email);
}

/** A test influencer / user login address (same rule; named separately so call sites read well). */
export function isTestInfluencerEmail(email: string): boolean {
  return looksLikeTestEmail(email);
}

export function isTestInfluencerSlug(slug: string, extraProtectedSlugs: readonly string[] = []): boolean {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) return false;
  if (isProtectedInfluencerSlug(slug, extraProtectedSlugs)) return false;
  if (/^spa-parity-\d+$/.test(slug) || QA_PREFIX.test(slug)) return true;
  const dash = slug.indexOf("-");
  if (dash < 1) return false;
  return TEST_SLUG_PREFIXES.has(slug.slice(0, dash)) && hasTimestamp(slug);
}

const WEBHOOK_TS = "(?<!\\d)\\d{13,16}(?!\\d)";
const TEST_WEBHOOK_PATTERNS: readonly RegExp[] = [
  new RegExp(`^evt_(?:rec_)?${WEBHOOK_TS}(?:_[a-z0-9]+)*$`),
  new RegExp(`^recovery:pay_[a-z_]+${WEBHOOK_TS}[a-z0-9_]*$`),
  /^evt_qa[_-][a-z0-9_-]+$/,
];

/** Webhook event ids written by this repo's tests and QA runs. `linkedPaymentIds` are Razorpay payment ids being deleted. */
export function isTestWebhookEventId(eventId: string, linkedPaymentIds: ReadonlySet<string> = new Set()): boolean {
  for (const re of TEST_WEBHOOK_PATTERNS) {
    if (re.test(eventId)) {
      const ts = eventId.match(/(?<!\d)\d{13,16}(?!\d)/)?.[0];
      return ts === undefined || hasTimestamp(ts);
    }
  }
  return eventId.startsWith("recovery:") && linkedPaymentIds.has(eventId.slice("recovery:".length));
}

export type InfluencerVerdict =
  | { kind: "protected"; reason: string }
  | { kind: "test"; reason: string }
  | { kind: "ambiguous"; reason: string }
  | { kind: "unmatched" };

/** Combines the two independent signals (slug and e-mail). `userEmail` is the login of the influencer, if any. */
export function classifyInfluencer(
  row: { slug: string; email: string; userEmail?: string | null },
  extraProtectedSlugs: readonly string[] = [],
): InfluencerVerdict {
  if (isProtectedInfluencerSlug(row.slug, extraProtectedSlugs)) return { kind: "protected", reason: "protected slug" };
  if (isProtectedInfluencerEmail(row.email) || (row.userEmail && isProtectedInfluencerEmail(row.userEmail))) {
    return { kind: "protected", reason: "protected e-mail" };
  }
  const slugMatch = isTestInfluencerSlug(row.slug, extraProtectedSlugs);
  const emailMatch = isTestInfluencerEmail(row.email);
  const exampleDomain = row.email.endsWith("@example.com");
  const userOk = row.userEmail == null || row.userEmail.endsWith("@example.com");
  if (slugMatch && exampleDomain && userOk) return { kind: "test", reason: "test slug and @example.com address" };
  if (emailMatch && hasTimestamp(row.slug) && userOk) return { kind: "test", reason: "test e-mail and timestamped slug" };
  if (slugMatch) return { kind: "ambiguous", reason: "slug looks like test data but the address is not @example.com" };
  if (emailMatch) return { kind: "ambiguous", reason: "address looks like test data but the slug does not" };
  return { kind: "unmatched" };
}

export type AdminVerdict = "protected" | "test" | "unmatched";

export function classifyAdmin(email: string): AdminVerdict {
  if (isProtectedAdminEmail(email)) return "protected";
  return isTestAdminEmail(email) ? "test" : "unmatched";
}

export function emailDomain(email: string): string {
  const at = email.lastIndexOf("@");
  return at < 0 || at === email.length - 1 ? "(no domain)" : email.slice(at + 1).toLowerCase();
}

// ---------------------------------------------------------------------------------------------------------------------
// Command line and apply guards (pure)
// ---------------------------------------------------------------------------------------------------------------------

export const CONFIRM_VALUE = "DELETE-TEST-DATA";

export type CleanupArgs = { apply: boolean; confirm: string | null; help: boolean; unknown: string[] };

export function parseCleanupArgs(argv: readonly string[]): CleanupArgs {
  const out: CleanupArgs = { apply: false, confirm: null, help: false, unknown: [] };
  for (const a of argv) {
    if (a === "--apply") out.apply = true;
    else if (a === "--help" || a === "-h") out.help = true;
    else if (a.startsWith("--confirm=")) out.confirm = a.slice("--confirm=".length);
    else out.unknown.push(a);
  }
  return out;
}

/** Why --apply must be refused (empty = allowed). Needs the typed confirmation, a non-production process and a local APP_URL. */
export function applyProblems(env: Record<string, string | undefined>, confirm: string | null | undefined): string[] {
  const problems: string[] = [];
  if (confirm !== CONFIRM_VALUE) problems.push(`the typed confirmation is missing: add --confirm=${CONFIRM_VALUE}`);
  if ((env.NODE_ENV ?? "").trim().toLowerCase() === "production") problems.push("NODE_ENV is production");
  if (env.VERCEL || env.AWS_LAMBDA_FUNCTION_NAME || env.NETLIFY) problems.push("this looks like a hosted (serverless) environment");
  if (!isLocalAppUrl(env.APP_URL)) problems.push("APP_URL is not set to a local address (localhost, 127.0.0.1, [::1], *.localhost)");
  return problems;
}

// ---------------------------------------------------------------------------------------------------------------------
// Planning (read only)
// ---------------------------------------------------------------------------------------------------------------------

export type Db = PrismaClient | Prisma.TransactionClient;

export const TABLES = [
  "influencers", "users", "auth_sessions", "password_reset_tokens", "email_verification_tokens", "services",
  "availability_rules", "blocked_dates", "google_tokens", "payout_accounts", "whatsapp_connections",
  "whatsapp_registration_pins", "payouts", "sessions", "bookings", "payments", "refunds", "messages",
  "admin_users", "admin_sessions", "admin_recovery_codes", "webhook_events",
] as const;
export type TableName = (typeof TABLES)[number];
export type Counts = Record<TableName, number>;

export type CleanupOptions = {
  /**
   * Narrowing filter for tests: when set, a row is considered only if its identifying text (influencer slug, administrator
   * or customer e-mail, webhook event id) CONTAINS this string, on top of being classified as test data. A test passes its
   * own unique run id, so it can never touch anyone else's rows.
   */
  mustContain?: string;
  /** Additional influencer slugs to treat as protected (never deleted; their test-looking bookings are cleaned like demo's). Tests only. */
  extraProtectedSlugs?: readonly string[];
};

export type KeptBooking = {
  idPrefix: string;
  status: string;
  createdAt: Date;
  emailDomain: string;
  influencerSlug: string;
  reason: string;
};

export type CleanupPlan = {
  counts: Counts;
  influencers: { id: string; slug: string; email: string }[];
  admins: { id: string; email: string }[];
  kept: {
    protectedInfluencers: string[];
    protectedAdmins: string[];
    ambiguousInfluencers: { slug: string; reason: string }[];
    unmatchedInfluencers: string[];
    unmatchedAdmins: string[];
    bookings: KeptBooking[];
  };
  /** Audit rows written by the admins to be deleted: they stay (the copied e-mail remains), only the admin link is cleared. */
  auditRowsOfDeletedAdmins: number;
  /** The primary keys behind the counts (internal: never printed). */
  ids: {
    influencers: string[];
    userIds: string[];
    services: string[];
    sessions: string[];
    bookings: string[];
    payments: string[];
    refunds: string[];
    payouts: string[];
    phoneNumberIds: string[];
    admins: string[];
    webhookEvents: string[];
  };
};

const CHUNK = 2000;

function chunks<T>(list: readonly T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += CHUNK) out.push(list.slice(i, i + CHUNK) as T[]);
  return out;
}

async function sumOver(list: readonly string[], f: (part: string[]) => Promise<number>): Promise<number> {
  let n = 0;
  for (const part of chunks(list)) n += await f(part);
  return n;
}

async function collectOver<T>(list: readonly string[], f: (part: string[]) => Promise<T[]>): Promise<T[]> {
  const out: T[] = [];
  for (const part of chunks(list)) out.push(...(await f(part)));
  return out;
}

export function emptyCounts(): Counts {
  return Object.fromEntries(TABLES.map((t) => [t, 0])) as Counts;
}

/** Reads the database and decides what would be deleted and what is kept. Writes nothing. */
export async function planCleanup(db: Db, options: CleanupOptions = {}): Promise<CleanupPlan> {
  const extra = options.extraProtectedSlugs ?? [];
  const has = (text: string) => !options.mustContain || text.includes(options.mustContain);

  const counts = emptyCounts();
  const kept: CleanupPlan["kept"] = {
    protectedInfluencers: [], protectedAdmins: [], ambiguousInfluencers: [], unmatchedInfluencers: [], unmatchedAdmins: [], bookings: [],
  };

  // ---- influencers -------------------------------------------------------------------------------------------------
  const allInfluencers = await db.influencer.findMany({
    select: { id: true, slug: true, email: true, user: { select: { id: true, email: true } } },
    orderBy: { slug: "asc" },
  });
  const testInfluencers: { id: string; slug: string; email: string; userId: string | null }[] = [];
  const protectedIds: string[] = [];
  const slugById = new Map<string, string>();
  for (const inf of allInfluencers) {
    slugById.set(inf.id, inf.slug);
    const verdict = classifyInfluencer({ slug: inf.slug, email: inf.email, userEmail: inf.user?.email ?? null }, extra);
    if (verdict.kind === "protected") {
      protectedIds.push(inf.id);
      if (has(inf.slug)) kept.protectedInfluencers.push(inf.slug);
      continue;
    }
    if (!has(inf.slug)) continue;
    if (verdict.kind === "test") testInfluencers.push({ id: inf.id, slug: inf.slug, email: inf.email, userId: inf.user?.id ?? null });
    else if (verdict.kind === "ambiguous") kept.ambiguousInfluencers.push({ slug: inf.slug, reason: verdict.reason });
    else kept.unmatchedInfluencers.push(inf.slug);
  }
  const infIds = testInfluencers.map((i) => i.id);
  const userIds = testInfluencers.flatMap((i) => (i.userId ? [i.userId] : []));
  counts.influencers = infIds.length;
  counts.users = userIds.length;

  // ---- everything that hangs off the test influencers --------------------------------------------------------------
  const services = await collectOver(infIds, (part) => db.service.findMany({ where: { influencerId: { in: part } }, select: { id: true } }));
  const serviceIds = services.map((s) => s.id);
  const sessions = await collectOver(serviceIds, (part) => db.session.findMany({ where: { serviceId: { in: part } }, select: { id: true } }));
  const sessionIds = sessions.map((s) => s.id);
  const bookings = await collectOver(sessionIds, (part) => db.booking.findMany({ where: { sessionId: { in: part } }, select: { id: true } }));
  const bookingIds = bookings.map((b) => b.id);

  counts.services = serviceIds.length;
  counts.sessions = sessionIds.length;
  counts.auth_sessions = await sumOver(userIds, (p) => db.authSession.count({ where: { userId: { in: p } } }));
  counts.password_reset_tokens = await sumOver(userIds, (p) => db.passwordResetToken.count({ where: { userId: { in: p } } }));
  counts.email_verification_tokens = await sumOver(userIds, (p) => db.emailVerificationToken.count({ where: { userId: { in: p } } }));
  counts.availability_rules = await sumOver(infIds, (p) => db.availabilityRule.count({ where: { influencerId: { in: p } } }));
  counts.blocked_dates = await sumOver(infIds, (p) => db.blockedDate.count({ where: { influencerId: { in: p } } }));
  counts.google_tokens = await sumOver(infIds, (p) => db.googleToken.count({ where: { influencerId: { in: p } } }));
  counts.payout_accounts = await sumOver(infIds, (p) => db.payoutAccount.count({ where: { influencerId: { in: p } } }));
  const connections = await collectOver(infIds, (p) => db.whatsAppConnection.findMany({ where: { influencerId: { in: p } }, select: { phoneNumberId: true } }));
  const phoneNumberIds = connections.map((c) => c.phoneNumberId);
  counts.whatsapp_connections = phoneNumberIds.length;
  // Registration PINs are keyed by phone number id, not influencer: only the ones of a connection being deleted.
  counts.whatsapp_registration_pins = await sumOver(phoneNumberIds, (p) => db.whatsAppRegistrationPin.count({ where: { phoneNumberId: { in: p } } }));
  const payoutRows = await collectOver(infIds, (p) => db.payout.findMany({ where: { influencerId: { in: p } }, select: { id: true } }));
  const payoutIds = payoutRows.map((p) => p.id);
  counts.payouts = payoutIds.length;

  // ---- bookings on PROTECTED influencers (for example the demo influencer) that a QA run made ----------------------
  const demoBookingIds: string[] = [];
  const demoSessionIds = new Set<string>();
  if (protectedIds.length > 0) {
    const rows = await collectOver(protectedIds, (p) =>
      db.booking.findMany({
        where: { session: { service: { influencerId: { in: p } } } },
        select: {
          id: true, status: true, createdAt: true, customerEmail: true, sessionId: true,
          session: { select: { service: { select: { influencerId: true } } } },
          payments: { select: { payoutId: true } },
        },
      }),
    );
    for (const b of rows) {
      const slug = slugById.get(b.session.service.influencerId) ?? "?";
      const base = { idPrefix: b.id.slice(0, 8), status: b.status, createdAt: b.createdAt, emailDomain: emailDomain(b.customerEmail), influencerSlug: slug };
      if (options.mustContain && !b.customerEmail.includes(options.mustContain)) continue;
      if (!isTestCustomerEmail(b.customerEmail)) {
        kept.bookings.push({ ...base, reason: "customer e-mail does not look like test data" });
      } else if (b.payments.some((p) => p.payoutId)) {
        kept.bookings.push({ ...base, reason: "test-looking customer, but its payment is part of a payout" });
      } else {
        demoBookingIds.push(b.id);
        demoSessionIds.add(b.sessionId);
      }
    }
  }

  // ---- test-looking customers on influencers that are neither test nor protected: reported, never deleted --------------
  const knownIds = new Set([...infIds, ...protectedIds]);
  const strays = await db.booking.findMany({
    where: { customerEmail: { endsWith: "@example.com" }, session: { service: { influencerId: { notIn: [...knownIds] } } } },
    select: {
      id: true, status: true, createdAt: true, customerEmail: true,
      session: { select: { service: { select: { influencerId: true } } } },
    },
  });
  for (const b of strays) {
    if (!isTestCustomerEmail(b.customerEmail) || !has(b.customerEmail)) continue;
    kept.bookings.push({
      idPrefix: b.id.slice(0, 8), status: b.status, createdAt: b.createdAt, emailDomain: emailDomain(b.customerEmail),
      influencerSlug: slugById.get(b.session.service.influencerId) ?? "?",
      reason: "test-looking customer on an influencer that is not identified as test data",
    });
  }

  // Sessions on protected influencers that would be left with no bookings at all once the test bookings are gone.
  const orphanSessionIds: string[] = [];
  if (demoSessionIds.size > 0) {
    const doomed = new Set(demoBookingIds);
    const siblings = await collectOver([...demoSessionIds], (p) => db.booking.findMany({ where: { sessionId: { in: p } }, select: { id: true, sessionId: true } }));
    const stillUsed = new Set(siblings.filter((b) => !doomed.has(b.id)).map((b) => b.sessionId));
    for (const s of demoSessionIds) if (!stillUsed.has(s)) orphanSessionIds.push(s);
  }

  const allBookingIds = [...bookingIds, ...demoBookingIds];
  const allSessionIds = [...sessionIds, ...orphanSessionIds];
  counts.sessions = allSessionIds.length;
  counts.bookings = allBookingIds.length;
  const payments = await collectOver(allBookingIds, (p) => db.payment.findMany({ where: { bookingId: { in: p } }, select: { id: true, providerPaymentId: true } }));
  const paymentIds = payments.map((p) => p.id);
  counts.payments = paymentIds.length;
  const refunds = await collectOver(paymentIds, (p) => db.refund.findMany({ where: { paymentId: { in: p } }, select: { id: true } }));
  const refundIds = refunds.map((r) => r.id);
  counts.refunds = refundIds.length;
  counts.messages = await sumOver(allBookingIds, (p) => db.message.count({ where: { bookingId: { in: p } } }));

  // ---- administrators ----------------------------------------------------------------------------------------------
  const admins = await db.adminUser.findMany({ select: { id: true, email: true }, orderBy: { email: "asc" } });
  const testAdmins: { id: string; email: string }[] = [];
  for (const a of admins) {
    const verdict = classifyAdmin(a.email);
    if (verdict === "protected") kept.protectedAdmins.push(a.email);
    else if (!has(a.email)) continue;
    else if (verdict === "test") testAdmins.push(a);
    else kept.unmatchedAdmins.push(a.email);
  }
  const adminIds = testAdmins.map((a) => a.id);
  counts.admin_users = adminIds.length;
  counts.admin_sessions = await sumOver(adminIds, (p) => db.adminSession.count({ where: { adminId: { in: p } } }));
  counts.admin_recovery_codes = await sumOver(adminIds, (p) => db.adminRecoveryCode.count({ where: { adminId: { in: p } } }));
  const auditRowsOfDeletedAdmins = await sumOver(adminIds, (p) => db.adminAuditLog.count({ where: { adminId: { in: p } } }));

  // ---- webhook events: only ids that match the test shapes or belong to a payment being deleted ---------------------
  const linkedPaymentIds = new Set(payments.flatMap((p) => (p.providerPaymentId ? [p.providerPaymentId] : [])));
  const candidates = await db.webhookEvent.findMany({
    where: { OR: [{ eventId: { startsWith: "evt_" } }, { eventId: { startsWith: "recovery:" } }] },
    select: { id: true, eventId: true },
  });
  const webhookEventIds = candidates.filter((e) => has(e.eventId) && isTestWebhookEventId(e.eventId, linkedPaymentIds)).map((e) => e.id);
  counts.webhook_events = webhookEventIds.length;

  return {
    counts,
    influencers: testInfluencers.map(({ id, slug, email }) => ({ id, slug, email })),
    admins: testAdmins,
    kept,
    auditRowsOfDeletedAdmins,
    ids: {
      influencers: infIds, userIds, services: serviceIds, sessions: allSessionIds, bookings: allBookingIds, payments: paymentIds,
      refunds: refundIds, payouts: payoutIds, phoneNumberIds, admins: adminIds, webhookEvents: webhookEventIds,
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Apply (one transaction)
// ---------------------------------------------------------------------------------------------------------------------

export type ApplyOptions = CleanupOptions & {
  /** The environment to check the guards against: the real process.env from the command line. */
  env: Record<string, string | undefined>;
  confirm: string | null | undefined;
};

export class CleanupRefused extends Error {}

async function deleteOver(list: readonly string[], f: (part: string[]) => Promise<{ count: number }>): Promise<number> {
  let n = 0;
  for (const part of chunks(list)) n += (await f(part)).count;
  return n;
}

/**
 * Deletes the planned rows inside ONE transaction, children before parents (every relation here cascades except
 * payouts -> influencers, which is RESTRICT, so payouts go first). The plan is rebuilt inside the transaction, and if any
 * table's deleted count differs from the plan the whole transaction is rolled back. Throws CleanupRefused (before any
 * query) when a guard fails. Returns the deleted counts. Does not touch admin_audit_logs.
 */
export async function applyCleanup(prisma: PrismaClient, options: ApplyOptions): Promise<{ plan: CleanupPlan; deleted: Counts }> {
  const problems = applyProblems(options.env, options.confirm);
  if (problems.length > 0) throw new CleanupRefused(`Refusing to delete: ${problems.join("; ")}.`);

  return prisma.$transaction(
    async (tx) => {
      const plan = await planCleanup(tx, options);
      const { ids } = plan;
      const d = emptyCounts();

      d.refunds = await deleteOver(ids.refunds, (p) => tx.refund.deleteMany({ where: { id: { in: p } } }));
      d.payments = await deleteOver(ids.payments, (p) => tx.payment.deleteMany({ where: { id: { in: p } } }));
      d.messages = await deleteOver(ids.bookings, (p) => tx.message.deleteMany({ where: { bookingId: { in: p } } }));
      d.bookings = await deleteOver(ids.bookings, (p) => tx.booking.deleteMany({ where: { id: { in: p } } }));
      d.sessions = await deleteOver(ids.sessions, (p) => tx.session.deleteMany({ where: { id: { in: p } } }));
      d.payouts = await deleteOver(ids.payouts, (p) => tx.payout.deleteMany({ where: { id: { in: p } } }));
      d.services = await deleteOver(ids.influencers, (p) => tx.service.deleteMany({ where: { influencerId: { in: p } } }));
      d.availability_rules = await deleteOver(ids.influencers, (p) => tx.availabilityRule.deleteMany({ where: { influencerId: { in: p } } }));
      d.blocked_dates = await deleteOver(ids.influencers, (p) => tx.blockedDate.deleteMany({ where: { influencerId: { in: p } } }));
      d.google_tokens = await deleteOver(ids.influencers, (p) => tx.googleToken.deleteMany({ where: { influencerId: { in: p } } }));
      d.payout_accounts = await deleteOver(ids.influencers, (p) => tx.payoutAccount.deleteMany({ where: { influencerId: { in: p } } }));
      d.whatsapp_registration_pins = await deleteOver(ids.phoneNumberIds, (p) => tx.whatsAppRegistrationPin.deleteMany({ where: { phoneNumberId: { in: p } } }));
      d.whatsapp_connections = await deleteOver(ids.influencers, (p) => tx.whatsAppConnection.deleteMany({ where: { influencerId: { in: p } } }));
      d.auth_sessions = await deleteOver(ids.userIds, (p) => tx.authSession.deleteMany({ where: { userId: { in: p } } }));
      d.password_reset_tokens = await deleteOver(ids.userIds, (p) => tx.passwordResetToken.deleteMany({ where: { userId: { in: p } } }));
      d.email_verification_tokens = await deleteOver(ids.userIds, (p) => tx.emailVerificationToken.deleteMany({ where: { userId: { in: p } } }));
      d.users = await deleteOver(ids.userIds, (p) => tx.user.deleteMany({ where: { id: { in: p } } }));
      d.influencers = await deleteOver(ids.influencers, (p) => tx.influencer.deleteMany({ where: { id: { in: p } } }));
      d.admin_sessions = await deleteOver(ids.admins, (p) => tx.adminSession.deleteMany({ where: { adminId: { in: p } } }));
      d.admin_recovery_codes = await deleteOver(ids.admins, (p) => tx.adminRecoveryCode.deleteMany({ where: { adminId: { in: p } } }));
      d.admin_users = await deleteOver(ids.admins, (p) => tx.adminUser.deleteMany({ where: { id: { in: p } } }));
      d.webhook_events = await deleteOver(ids.webhookEvents, (p) => tx.webhookEvent.deleteMany({ where: { id: { in: p } } }));

      const off = TABLES.filter((t) => d[t] !== plan.counts[t]);
      if (off.length > 0) {
        throw new Error(`Rolled back: the rows deleted differ from the plan for ${off.join(", ")} (data changed while running). Nothing was deleted; run the dry run again.`);
      }
      return { plan, deleted: d };
    },
    { timeout: 120_000, maxWait: 30_000 },
  );
}

// ---------------------------------------------------------------------------------------------------------------------
// Report (never prints hashes, tokens, encrypted values, or a customer's full address)
// ---------------------------------------------------------------------------------------------------------------------

const MAX_LISTED = 200;

function listCapped(lines: string[], label: string): string[] {
  if (lines.length <= MAX_LISTED) return lines;
  return [...lines.slice(0, MAX_LISTED), `  ... and ${lines.length - MAX_LISTED} more ${label}`];
}

export function formatCounts(title: string, counts: Counts): string[] {
  const width = Math.max(...TABLES.map((t) => t.length));
  const lines = [title];
  for (const t of TABLES) lines.push(`  ${t.padEnd(width)}  ${String(counts[t]).padStart(6)}`);
  lines.push(`  ${"admin_audit_logs".padEnd(width)}  ${String(0).padStart(6)}  (never touched)`);
  return lines;
}

export function formatPlan(plan: CleanupPlan): string[] {
  const out: string[] = [];
  out.push(...formatCounts("Rows that would be deleted (per table):", plan.counts));
  out.push("");
  out.push(`Influencers that would be deleted (${plan.influencers.length}), by slug:`);
  out.push(...listCapped(plan.influencers.map((i) => `  ${i.slug}`), "influencers"));
  out.push("");
  out.push(`Administrators that would be deleted (${plan.admins.length}):`);
  out.push(...listCapped(plan.admins.map((a) => `  ${a.email}`), "administrators"));
  out.push(`  (${plan.auditRowsOfDeletedAdmins} audit-log rows written by them stay: they keep their copied e-mail, only the admin link is cleared)`);
  out.push("");
  out.push("KEPT, protected:");
  out.push(`  influencers: ${plan.kept.protectedInfluencers.join(", ") || "(none found)"}`);
  out.push(`  administrators: ${plan.kept.protectedAdmins.join(", ") || "(none found)"}`);
  out.push("");
  out.push(`KEPT, ambiguous influencers (${plan.kept.ambiguousInfluencers.length}), one signal only, decide by hand:`);
  out.push(...listCapped(plan.kept.ambiguousInfluencers.map((i) => `  ${i.slug}  -- ${i.reason}`), "influencers"));
  out.push(`KEPT, influencers with no test signal (${plan.kept.unmatchedInfluencers.length}): ${plan.kept.unmatchedInfluencers.slice(0, 50).join(", ") || "(none)"}${plan.kept.unmatchedInfluencers.length > 50 ? ", ..." : ""}`);
  out.push(`KEPT, administrators with no test signal (${plan.kept.unmatchedAdmins.length}): ${plan.kept.unmatchedAdmins.join(", ") || "(none)"}`);
  out.push("");
  out.push(`KEPT, bookings not deleted (${plan.kept.bookings.length}), id prefix / status / created / customer e-mail domain / influencer:`);
  out.push(
    ...listCapped(
      plan.kept.bookings.map((b) => `  ${b.idPrefix}  ${b.status.padEnd(15)} ${b.createdAt.toISOString().slice(0, 10)}  @${b.emailDomain}  [${b.influencerSlug}]  ${b.reason}`),
      "bookings",
    ),
  );
  return out;
}
