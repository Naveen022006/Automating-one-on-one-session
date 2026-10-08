/**
 * Rate limiting core: a sliding-window-counter algorithm over a pluggable store.
 *
 * The window is split into fixed buckets of `windowMs`. Each hit increments the current bucket; the effective
 * count is `previous * (1 - elapsed/windowMs) + current`, which approximates a true sliding window without
 * storing every request (two integers per key). This file is dependency-free (no Redis/Prisma imports) so it is
 * unit-testable on its own; the real stores live in ./stores.ts.
 */

export interface WindowCounts {
  /** Hits in the current fixed bucket, including this one. */
  current: number;
  /** Hits in the previous fixed bucket. */
  previous: number;
}

export interface RateLimitStore {
  readonly name: string;
  /** Atomically records one hit for `key` in the bucket starting at `windowStart` and returns both bucket counts. */
  hit(key: string, windowStart: number, windowMs: number): Promise<WindowCounts>;
}

export interface RateLimitRule {
  /** Stable name; part of the storage key, so renaming a rule resets its counters. */
  name: string;
  /** Maximum requests allowed per window. */
  limit: number;
  windowMs: number;
}

export interface RateLimitResult {
  allowed: boolean;
  limit: number;
  /** Requests left in the current window (never negative). */
  remaining: number;
  /** Seconds until the current bucket rolls over. */
  resetSec: number;
  /** Seconds the client should wait before retrying (only meaningful when !allowed). */
  retryAfterSec: number;
  /** Which store answered, or "none" when every store failed and the request was let through. */
  store: string;
}

/** Pure: turns raw bucket counts into an allow/deny decision. Exported for tests. */
export function evaluate(rule: RateLimitRule, counts: WindowCounts, now: number, windowStart: number): Omit<RateLimitResult, "store"> {
  const elapsed = (now - windowStart) / rule.windowMs;
  const weighted = counts.previous * (1 - elapsed) + counts.current;
  const allowed = weighted <= rule.limit;
  const resetMs = windowStart + rule.windowMs - now;
  const resetSec = Math.max(1, Math.ceil(resetMs / 1000));
  let retryAfterSec = 0;
  if (!allowed) {
    // How long until the previous bucket's weight has decayed enough to admit one more request in this window.
    // If the current bucket alone is over the limit, the client has to wait for the next bucket.
    if (counts.current > rule.limit || counts.previous === 0) {
      retryAfterSec = resetSec;
    } else {
      const needed = weighted - rule.limit; // excess weight that must decay away
      const decayMs = (needed / counts.previous) * rule.windowMs;
      retryAfterSec = Math.max(1, Math.min(resetSec, Math.ceil(decayMs / 1000)));
    }
  }
  return {
    allowed,
    limit: rule.limit,
    remaining: Math.max(0, Math.floor(rule.limit - weighted)),
    resetSec,
    retryAfterSec,
  };
}

export function windowStartFor(now: number, windowMs: number): number {
  return Math.floor(now / windowMs) * windowMs;
}

/**
 * Checks and records one hit for `identifier` under `rule`. Never throws: if the store fails the request is
 * allowed (fail open) and the failure is reported through `onError`. Availability of the booking/payment flow
 * matters more than strict limiting during a Redis + database outage, and every sensitive endpoint has its own
 * defence (password hashing cost, signed tokens, payment provider checks).
 */
export async function consume(
  store: RateLimitStore,
  rule: RateLimitRule,
  identifier: string,
  opts: { now?: number; onError?: (e: unknown) => void } = {},
): Promise<RateLimitResult> {
  const now = opts.now ?? Date.now();
  const windowStart = windowStartFor(now, rule.windowMs);
  const key = `${rule.name}:${identifier}`;
  try {
    const counts = await store.hit(key, windowStart, rule.windowMs);
    return { ...evaluate(rule, counts, now, windowStart), store: store.name };
  } catch (e) {
    opts.onError?.(e);
    return {
      allowed: true,
      limit: rule.limit,
      remaining: rule.limit,
      resetSec: Math.max(1, Math.ceil((windowStart + rule.windowMs - now) / 1000)),
      retryAfterSec: 0,
      store: "none",
    };
  }
}

/** In-process store. Used by tests and as a last-resort local store; NOT shared across processes. */
export class MemoryStore implements RateLimitStore {
  readonly name = "memory";
  private buckets = new Map<string, { count: number; expiresAt: number }>();

  async hit(key: string, windowStart: number, windowMs: number): Promise<WindowCounts> {
    const now = Date.now();
    if (this.buckets.size > 10_000) this.sweep(now);
    const curKey = `${key}:${windowStart}`;
    const cur = this.buckets.get(curKey);
    const current = (cur && cur.expiresAt > now ? cur.count : 0) + 1;
    this.buckets.set(curKey, { count: current, expiresAt: windowStart + 2 * windowMs });
    const prev = this.buckets.get(`${key}:${windowStart - windowMs}`);
    return { current, previous: prev && prev.expiresAt > now ? prev.count : 0 };
  }

  private sweep(now: number) {
    for (const [k, v] of this.buckets) if (v.expiresAt <= now) this.buckets.delete(k);
  }
}

/**
 * Tries `primary` (Redis) and falls back to `secondary` (Postgres) when it errors. After a primary failure the
 * primary is skipped for `cooldownMs` so a Redis outage does not add a timeout to every request.
 */
export class FailoverStore implements RateLimitStore {
  private primaryDownUntil = 0;

  constructor(
    private readonly primary: RateLimitStore,
    private readonly secondary: RateLimitStore,
    private readonly opts: { cooldownMs?: number; onFailover?: (e: unknown) => void } = {},
  ) {}

  get name(): string {
    return Date.now() < this.primaryDownUntil ? this.secondary.name : this.primary.name;
  }

  async hit(key: string, windowStart: number, windowMs: number): Promise<WindowCounts> {
    if (Date.now() >= this.primaryDownUntil) {
      try {
        return await this.primary.hit(key, windowStart, windowMs);
      } catch (e) {
        this.primaryDownUntil = Date.now() + (this.opts.cooldownMs ?? 30_000);
        this.opts.onFailover?.(e);
      }
    }
    return this.secondary.hit(key, windowStart, windowMs);
  }
}

/** Standard rate limit response headers (IETF RateLimit header fields draft + Retry-After). */
export function rateLimitHeaders(r: RateLimitResult): Record<string, string> {
  const h: Record<string, string> = {
    "RateLimit-Limit": String(r.limit),
    "RateLimit-Remaining": String(r.remaining),
    "RateLimit-Reset": String(r.resetSec),
  };
  if (!r.allowed) h["Retry-After"] = String(r.retryAfterSec);
  return h;
}
