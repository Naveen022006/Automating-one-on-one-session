import type { RateLimitRule } from "./core";

/**
 * Every API rate limit in one place. The proxy (proxy.ts) applies `GLOBAL_API_RULE` plus the first matching
 * route rule to every /api request, keyed by client IP (or by login session for the dashboard). Route handlers
 * add identity-based limits (per email) through `IDENTITY_RULES` where the identity is only known after parsing
 * the body. Limits can be scaled for load tests with RATE_LIMIT_MULTIPLIER.
 */

const MIN = 60_000;
const HOUR = 60 * MIN;

export type RouteKey = "ip" | "session-or-ip";

export interface RouteRule extends RateLimitRule {
  methods?: string[];
  /** Matched against the request pathname. */
  pattern: RegExp;
  by: RouteKey;
}

/** Applies to every /api request on top of the route rule. Generous; it only stops floods and scrapers. */
export const GLOBAL_API_RULE: RateLimitRule = { name: "api", limit: 300, windowMs: MIN };

/**
 * Orchestrator and load-balancer probes (liveness /api/health, readiness /api/ready). Matched before everything else
 * and exempt from the global per-IP ceiling, because a probe must never be refused for an unrelated reason (a shared
 * IP behind a load balancer would otherwise compete with real traffic for the 300/min budget). They are counted in
 * process memory (`local`), so probing keeps working while Redis and Postgres are down. The limits are far above
 * any real probe schedule (one every 1-10 s per prober) and only stop a flood from a single address. Readiness
 * touches the database, hence the tighter limit.
 */
export const PROBE_RULES: RouteRule[] = [
  { name: "health", pattern: /^\/api\/health$/, methods: ["GET", "HEAD"], limit: 6000, windowMs: MIN, by: "ip", local: true },
  { name: "ready", pattern: /^\/api\/ready$/, methods: ["GET", "HEAD"], limit: 1200, windowMs: MIN, by: "ip", local: true },
];

/** First match wins, so list the most specific patterns first. */
export const ROUTE_RULES: RouteRule[] = [
  // --- Accounts (Phase 7 B2): login, register, reset are brute-force targets.
  { name: "auth-login", pattern: /^\/api\/auth\/login$/, methods: ["POST"], limit: 10, windowMs: 15 * MIN, by: "ip" },
  { name: "auth-register", pattern: /^\/api\/auth\/register$/, methods: ["POST"], limit: 5, windowMs: HOUR, by: "ip" },
  { name: "auth-forgot", pattern: /^\/api\/auth\/forgot-password$/, methods: ["POST"], limit: 5, windowMs: HOUR, by: "ip" },
  { name: "auth-reset", pattern: /^\/api\/auth\/reset-password$/, methods: ["POST"], limit: 10, windowMs: HOUR, by: "ip" },
  { name: "auth-verify", pattern: /^\/api\/auth\/(verify-email|resend-verification)$/, methods: ["POST"], limit: 10, windowMs: HOUR, by: "ip" },
  // The SPA asks "who am I?" on landing, login, register, verify-email and every guarded page load, so it gets its own,
  // much wider budget. Listed before auth-other, whose 60 per 15 minutes would be used up by ordinary browsing.
  { name: "auth-session", pattern: /^\/api\/auth\/session$/, methods: ["GET"], limit: 120, windowMs: MIN, by: "session-or-ip" },
  { name: "auth-other", pattern: /^\/api\/auth\//, limit: 60, windowMs: 15 * MIN, by: "session-or-ip" },

  // --- Administrator console: sign-in is a brute-force target, everything else is low volume.
  { name: "admin-login", pattern: /^\/api\/admin\/auth\/login$/, methods: ["POST"], limit: 8, windowMs: 15 * MIN, by: "ip" },
  // Second step of sign-in (authenticator or recovery code): a 6-digit code is guessable, so this is as tight as the password step.
  // The admin MFA rules are failClosed: if no rate-limit store is up they refuse (503) instead of allowing unlimited guesses.
  { name: "admin-mfa", pattern: /^\/api\/admin\/auth\/mfa$/, methods: ["POST"], limit: 10, windowMs: 15 * MIN, by: "ip", failClosed: true },
  // Enrolling, regenerating recovery codes and turning off 2FA all check a password and a code.
  { name: "admin-security", pattern: /^\/api\/admin\/security\//, methods: ["POST"], limit: 30, windowMs: HOUR, by: "ip", failClosed: true },
  { name: "admin-payout-account", pattern: /^\/api\/admin\/influencers\/[^/]+\/payout-account$/, methods: ["POST"], limit: 30, windowMs: HOUR, by: "ip" },
  // Reconciliation calls Razorpay once per payment; payouts and fees move money. Tight, low-volume limits.
  { name: "admin-reconcile", pattern: /^\/api\/admin\/payments\/reconcile$/, methods: ["POST"], limit: 20, windowMs: HOUR, by: "ip" },
  // Payouts and fees, plus the admin refund of a captured payment and the platform-side cancellation of a booking.
  { name: "admin-money", pattern: /^\/api\/admin\/(payouts\/|influencers\/[^/]+\/(payouts|fee)$|payments\/[^/]+\/(unreconcile|refund)$|bookings\/[^/]+\/cancel$)/, methods: ["POST", "PATCH"], limit: 60, windowMs: HOUR, by: "ip" },
  // Suspending, reinstating and approving an influencer (the status endpoint also answers GET, which stays under `admin`).
  { name: "admin-moderation", pattern: /^\/api\/admin\/influencers\/[^/]+\/status$/, methods: ["POST"], limit: 60, windowMs: HOUR, by: "ip" },
  // Account help by hand while the platform sends no e-mail (doc/15): verifying an address and handing over a password-reset link.
  { name: "admin-account-help", pattern: /^\/api\/admin\/influencers\/[^/]+\/(verify-email|reset-link)$/, methods: ["POST"], limit: 30, windowMs: HOUR, by: "ip" },
  // CSV exports carry personal data and run wide queries; the finance report aggregates the whole database. HEAD is answered by
  // the GET handler (it would run the same query), so it shares the rule, like the other view endpoints below.
  { name: "admin-export", pattern: /^\/api\/admin\/exports\/(payments|bookings|payouts|audit)$/, methods: ["GET", "HEAD"], limit: 30, windowMs: HOUR, by: "ip" },
  { name: "admin-reports", pattern: /^\/api\/admin\/reports$/, methods: ["GET", "HEAD"], limit: 30, windowMs: 10 * MIN, by: "ip" },
  // The optional QR-code WhatsApp mode, platform side (status of every linked number, and the actions that disconnect one). Changes are
  // low volume; reads stay under `admin`.
  { name: "admin-whatsapp-web", pattern: /^\/api\/admin\/whatsapp-web(\/|$)/, methods: ["POST", "PATCH", "PUT", "DELETE"], limit: 30, windowMs: HOUR, by: "ip" },
  { name: "admin", pattern: /^\/api\/admin\//, limit: 120, windowMs: MIN, by: "ip" },

  // --- Public booking flow. Holds reserve a seat, so they are tightly limited to stop seat squatting.
  { name: "hold", pattern: /^\/api\/bookings\/hold$/, methods: ["POST"], limit: 10, windowMs: 10 * MIN, by: "ip" },
  { name: "checkout", pattern: /^\/api\/checkout$/, methods: ["POST"], limit: 20, windowMs: 10 * MIN, by: "ip" },
  { name: "booking-resend", pattern: /^\/api\/bookings\/[^/]+\/resend$/, methods: ["POST"], limit: 3, windowMs: HOUR, by: "ip" },
  // The confirmation page polls every 2 s for up to 2 minutes (~60 requests).
  { name: "booking-status", pattern: /^\/api\/bookings\/[^/]+(\/ics)?$/, methods: ["GET"], limit: 120, windowMs: 5 * MIN, by: "ip" },
  { name: "slots", pattern: /^\/api\/slots(\/days)?$/, limit: 120, windowMs: MIN, by: "ip" },
  // Customer portal ("find your bookings"): the e-mail request is a spam/enumeration target, the token routes read or erase one
  // address's data. The erase and export rules are listed before the portal view, which only matches the bare token path.
  { name: "customer-access", pattern: /^\/api\/customer\/access$/, methods: ["POST"], limit: 5, windowMs: HOUR, by: "ip" },
  { name: "customer-erase", pattern: /^\/api\/customer\/portal\/[^/]+\/erase$/, methods: ["POST"], limit: 5, windowMs: HOUR, by: "ip" },
  { name: "customer-export", pattern: /^\/api\/customer\/portal\/[^/]+\/export$/, methods: ["GET", "HEAD"], limit: 10, windowMs: HOUR, by: "ip" },
  { name: "customer-portal", pattern: /^\/api\/customer\/portal\/[^/]+$/, methods: ["GET", "HEAD"], limit: 60, windowMs: 10 * MIN, by: "ip" },
  // Page loads of the SPA's customer screens (these GET endpoints are what the server-rendered pages used to do inline).
  // Keyed by IP, with headroom for a popular booking page behind a shared NAT; RATE_LIMIT_MULTIPLIER is the lever.
  { name: "public-profile", pattern: /^\/api\/public\/profiles\/[^/]+$/, methods: ["GET", "HEAD"], limit: 120, windowMs: MIN, by: "ip" },
  // Same budget as the booking status poll: tokens are signed (not guessable), and a customer behind a shared NAT must not be
  // locked out of paying while their hold runs down.
  { name: "pay-view", pattern: /^\/api\/pay\/[^/]+$/, methods: ["GET", "HEAD"], limit: 120, windowMs: 5 * MIN, by: "ip" },
  // Data export and erasure through the manage link (doc/15, 4.12): they read or erase everything stored about an address, so they get the
  // portal's tight budgets. Listed before the general self-service rules.
  { name: "manage-data", pattern: /^\/api\/manage\/[^/]+\/data$/, methods: ["GET", "HEAD"], limit: 10, windowMs: HOUR, by: "ip" },
  { name: "manage-erase", pattern: /^\/api\/manage\/[^/]+\/erase$/, methods: ["POST"], limit: 5, windowMs: HOUR, by: "ip" },
  // Listed before self-service so that opening the manage page does not use up the 20 per 10 minutes meant for actions.
  { name: "self-service-view", pattern: /^\/api\/manage\/[^/]+$/, methods: ["GET", "HEAD"], limit: 60, windowMs: 10 * MIN, by: "ip" },
  { name: "self-service", pattern: /^\/api\/manage\//, limit: 20, windowMs: 10 * MIN, by: "ip" },

  // --- Worker liveness for uptime monitors (also the watchdog that alerts when the worker stops). Cheap, public.
  { name: "health-watchdog", pattern: /^\/api\/health\/watchdog$/, methods: ["GET"], limit: 30, windowMs: MIN, by: "ip" },

  // --- Provider webhooks: high ceiling (providers burst and retry); signatures are still verified.
  { name: "webhooks", pattern: /^\/api\/webhooks\//, limit: 600, windowMs: MIN, by: "ip" },

  // --- Google OAuth round trip.
  { name: "google-oauth", pattern: /^\/api\/google\//, limit: 20, windowMs: 10 * MIN, by: "session-or-ip" },

  // --- Influencer dashboard. Refunds move money, so they get their own tight limit.
  { name: "dashboard-refund", pattern: /^\/api\/dashboard\/bookings\/[^/]+\/refund$/, methods: ["POST"], limit: 10, windowMs: HOUR, by: "session-or-ip" },
  { name: "dashboard-payout-account", pattern: /^\/api\/dashboard\/payout-account$/, methods: ["PUT"], limit: 10, windowMs: HOUR, by: "session-or-ip" },
  // Saving a Google client calls Google's token endpoint to check the pasted pair (doc/15), and removing one revokes tokens: keep both low.
  { name: "dashboard-google-client", pattern: /^\/api\/dashboard\/google-client$/, methods: ["POST"], limit: 10, windowMs: HOUR, by: "session-or-ip" },
  { name: "dashboard-whatsapp", pattern: /^\/api\/dashboard\/whatsapp$/, methods: ["POST", "DELETE"], limit: 20, windowMs: HOUR, by: "session-or-ip" },
  // The optional QR-code WhatsApp mode. The linking screen polls the status every 2 s while it waits for the scan (30 a minute), so
  // reads get twice that; starting, cancelling, disconnecting and the test message are rare (and a test message is a real send).
  { name: "dashboard-whatsapp-web-read", pattern: /^\/api\/dashboard\/whatsapp-web$/, methods: ["GET", "HEAD"], limit: 60, windowMs: MIN, by: "session-or-ip" },
  { name: "dashboard-whatsapp-web", pattern: /^\/api\/dashboard\/whatsapp-web(\/|$)/, methods: ["POST", "PUT", "PATCH", "DELETE"], limit: 10, windowMs: MIN, by: "session-or-ip" },
  { name: "dashboard-export", pattern: /^\/api\/dashboard\/earnings\/export$/, limit: 20, windowMs: HOUR, by: "session-or-ip" },
  { name: "dashboard", pattern: /^\/api\/dashboard\//, limit: 120, windowMs: MIN, by: "session-or-ip" },
];

/** Identity-based limits enforced inside route handlers once the body is parsed. */
export const IDENTITY_RULES = {
  /**
   * Keyed by email AND client IP, so a stranger hammering someone's email from their own IP cannot lock the real
   * owner out; distributed guessing is still capped by the per-IP rule and the hashing cost.
   */
  loginEmail: { name: "auth-login-email-ip", limit: 5, windowMs: 15 * MIN },
  /** Password re-entry for sensitive actions / change password, keyed by user id + IP (separate from login). */
  reauthUser: { name: "auth-reauth-user-ip", limit: 10, windowMs: 15 * MIN },
  adminLoginEmail: { name: "admin-login-email-ip", limit: 5, windowMs: 15 * MIN },
  /** Password re-entry by a signed-in admin (change password, and 2FA setup/enable/regenerate/disable). Fails closed. */
  adminReauth: { name: "admin-password-user-ip", limit: 10, windowMs: 15 * MIN, failClosed: true },
  /** Second sign-in step, keyed by admin id AND client IP (the id comes from the verified pending token). Fails closed. */
  adminMfaIp: { name: "admin-mfa-admin-ip", limit: 6, windowMs: 15 * MIN, failClosed: true },
  /** Second sign-in step per admin from ANY IP, so guessing spread over many addresses is still capped. Fails closed. */
  adminMfaAdmin: { name: "admin-mfa-admin", limit: 30, windowMs: HOUR, failClosed: true },
  /** Code checks on the Security page (enable, regenerate recovery codes, disable), keyed by admin id + IP. Fails closed. */
  adminMfaManage: { name: "admin-mfa-manage-admin-ip", limit: 10, windowMs: 15 * MIN, failClosed: true },
  /** Everything on the Security page per admin from ANY IP (password and code guesses spread over addresses). Fails closed. */
  adminMfaManageAdmin: { name: "admin-mfa-manage-admin", limit: 30, windowMs: HOUR, failClosed: true },
  /** "Save and check" of a Google client calls Google: per influencer from ANY address or device, on top of the per-session route rule. */
  googleClientCheck: { name: "google-client-check", limit: 12, windowMs: HOUR },
  forgotEmail: { name: "auth-forgot-email", limit: 3, windowMs: HOUR },
  resendVerificationEmail: { name: "auth-verify-email", limit: 3, windowMs: HOUR },
  holdEmail: { name: "hold-email", limit: 5, windowMs: 10 * MIN },
  /**
   * Booking REQUESTS per destination phone number (E.164), whoever sends them: a request makes the host's linked WhatsApp message that
   * number straight away ("request received"), so a stranger's number must not be messaged on demand over and over (a flood would
   * also burn the linked number's daily limit). Counted for services that need approval only; ordinary holds send nothing before payment.
   */
  holdPhone: { name: "hold-phone", limit: 3, windowMs: 24 * HOUR },
  bookingResend: { name: "booking-resend-id", limit: 3, windowMs: HOUR },
  /** "Find your bookings": per e-mail address, so one inbox cannot be mail-bombed from many addresses. */
  customerAccessEmail: { name: "customer-access-email", limit: 3, windowMs: HOUR },
  /** The manage-link data export and erasure (doc/15, 4.12), per BOOKING (keyed by a hash of its id) on top of the per-IP rules: a leaked link cannot be hammered from many addresses. */
  manageDataBooking: { name: "manage-data-booking", limit: 5, windowMs: HOUR },
  manageEraseBooking: { name: "manage-erase-booking", limit: 3, windowMs: HOUR },
} satisfies Record<string, RateLimitRule>;

export function scaled(rule: RateLimitRule, multiplier: number): RateLimitRule {
  if (multiplier === 1) return rule;
  return { ...rule, limit: Math.max(1, Math.round(rule.limit * multiplier)) };
}

export function matchRouteRule(method: string, pathname: string): RouteRule | null {
  for (const r of [...PROBE_RULES, ...ROUTE_RULES]) {
    if (r.methods && !r.methods.includes(method)) continue;
    if (r.pattern.test(pathname)) return r;
  }
  return null;
}
