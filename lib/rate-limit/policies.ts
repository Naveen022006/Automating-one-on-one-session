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
  { name: "admin-money", pattern: /^\/api\/admin\/(payouts\/|influencers\/[^/]+\/(payouts|fee)$|payments\/[^/]+\/unreconcile$)/, methods: ["POST", "PATCH"], limit: 60, windowMs: HOUR, by: "ip" },
  { name: "admin", pattern: /^\/api\/admin\//, limit: 120, windowMs: MIN, by: "ip" },

  // --- Public booking flow. Holds reserve a seat, so they are tightly limited to stop seat squatting.
  { name: "hold", pattern: /^\/api\/bookings\/hold$/, methods: ["POST"], limit: 10, windowMs: 10 * MIN, by: "ip" },
  { name: "checkout", pattern: /^\/api\/checkout$/, methods: ["POST"], limit: 20, windowMs: 10 * MIN, by: "ip" },
  { name: "booking-resend", pattern: /^\/api\/bookings\/[^/]+\/resend$/, methods: ["POST"], limit: 3, windowMs: HOUR, by: "ip" },
  // The confirmation page polls every 2 s for up to 2 minutes (~60 requests).
  { name: "booking-status", pattern: /^\/api\/bookings\/[^/]+(\/ics)?$/, methods: ["GET"], limit: 120, windowMs: 5 * MIN, by: "ip" },
  { name: "booking-actions", pattern: /^\/api\/bookings\/[^/]+\/(cancel|reschedule)$/, limit: 30, windowMs: 10 * MIN, by: "session-or-ip" },
  { name: "slots", pattern: /^\/api\/slots(\/days)?$/, limit: 120, windowMs: MIN, by: "ip" },
  // Page loads of the SPA's customer screens (these GET endpoints are what the server-rendered pages used to do inline).
  // Keyed by IP, with headroom for a popular booking page behind a shared NAT; RATE_LIMIT_MULTIPLIER is the lever.
  { name: "public-profile", pattern: /^\/api\/public\/profiles\/[^/]+$/, methods: ["GET"], limit: 120, windowMs: MIN, by: "ip" },
  { name: "pay-view", pattern: /^\/api\/pay\/[^/]+$/, methods: ["GET"], limit: 30, windowMs: 10 * MIN, by: "ip" },
  // Listed before self-service so that opening the manage page does not use up the 20 per 10 minutes meant for actions.
  { name: "self-service-view", pattern: /^\/api\/manage\/[^/]+$/, methods: ["GET"], limit: 60, windowMs: 10 * MIN, by: "ip" },
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
  { name: "dashboard-whatsapp", pattern: /^\/api\/dashboard\/whatsapp$/, methods: ["POST", "DELETE"], limit: 20, windowMs: HOUR, by: "session-or-ip" },
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
  forgotEmail: { name: "auth-forgot-email", limit: 3, windowMs: HOUR },
  resendVerificationEmail: { name: "auth-verify-email", limit: 3, windowMs: HOUR },
  holdEmail: { name: "hold-email", limit: 5, windowMs: 10 * MIN },
  bookingResend: { name: "booking-resend-id", limit: 3, windowMs: HOUR },
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
