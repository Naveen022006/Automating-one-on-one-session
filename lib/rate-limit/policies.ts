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

/** First match wins, so list the most specific patterns first. */
export const ROUTE_RULES: RouteRule[] = [
  // --- Accounts (Phase 7 B2): login, register, reset are brute-force targets.
  { name: "auth-login", pattern: /^\/api\/auth\/login$/, methods: ["POST"], limit: 10, windowMs: 15 * MIN, by: "ip" },
  { name: "auth-register", pattern: /^\/api\/auth\/register$/, methods: ["POST"], limit: 5, windowMs: HOUR, by: "ip" },
  { name: "auth-forgot", pattern: /^\/api\/auth\/forgot-password$/, methods: ["POST"], limit: 5, windowMs: HOUR, by: "ip" },
  { name: "auth-reset", pattern: /^\/api\/auth\/reset-password$/, methods: ["POST"], limit: 10, windowMs: HOUR, by: "ip" },
  { name: "auth-verify", pattern: /^\/api\/auth\/(verify-email|resend-verification)$/, methods: ["POST"], limit: 10, windowMs: HOUR, by: "ip" },
  { name: "auth-other", pattern: /^\/api\/auth\//, limit: 60, windowMs: 15 * MIN, by: "session-or-ip" },

  // --- Administrator console: sign-in is a brute-force target, everything else is low volume.
  { name: "admin-login", pattern: /^\/api\/admin\/auth\/login$/, methods: ["POST"], limit: 8, windowMs: 15 * MIN, by: "ip" },
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
  { name: "self-service", pattern: /^\/api\/manage\//, limit: 20, windowMs: 10 * MIN, by: "ip" },

  // --- Provider webhooks: high ceiling (providers burst and retry); signatures are still verified.
  { name: "webhooks", pattern: /^\/api\/webhooks\//, limit: 600, windowMs: MIN, by: "ip" },

  // --- Google OAuth round trip.
  { name: "google-oauth", pattern: /^\/api\/google\//, limit: 20, windowMs: 10 * MIN, by: "session-or-ip" },

  // --- Influencer dashboard. Refunds move money, so they get their own tight limit.
  { name: "dashboard-refund", pattern: /^\/api\/dashboard\/bookings\/[^/]+\/refund$/, methods: ["POST"], limit: 10, windowMs: HOUR, by: "session-or-ip" },
  { name: "dashboard-payout-account", pattern: /^\/api\/dashboard\/payout-account$/, methods: ["PUT"], limit: 10, windowMs: HOUR, by: "session-or-ip" },
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
  adminReauth: { name: "admin-password-user-ip", limit: 10, windowMs: 15 * MIN },
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
  for (const r of ROUTE_RULES) {
    if (r.methods && !r.methods.includes(method)) continue;
    if (r.pattern.test(pathname)) return r;
  }
  return null;
}
