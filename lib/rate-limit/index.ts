import { NextResponse } from "next/server";
import {
  consume,
  FailoverStore,
  MemoryStore,
  rateLimitHeaders,
  type RateLimitResult,
  type RateLimitRule,
  type RateLimitStore,
} from "./core";
import { scaled } from "./policies";
import { PostgresStore, RedisStore, type RedisLike } from "./stores";

export { clientIp } from "./client-ip";
export { IDENTITY_RULES, GLOBAL_API_RULE, matchRouteRule } from "./policies";
export type { RateLimitResult, RateLimitRule } from "./core";

/**
 * Store selection (RATE_LIMIT_STORE):
 *   - unset / "auto": Redis when REDIS_URL is set, failing over to Postgres if Redis errors; Postgres otherwise.
 *   - "redis":        Redis only (fails open if Redis is down).
 *   - "postgres":     the `rate_limit_buckets` table only.
 *   - "memory":       per-process memory (tests/local only; not shared between instances).
 * RATE_LIMIT_ENABLED=false turns limiting off entirely (e.g. for load tests against a staging copy).
 */

let store: RateLimitStore | null = null;
let lastErrorLog = 0;

function logThrottled(message: string, e: unknown) {
  const now = Date.now();
  if (now - lastErrorLog < 60_000) return;
  lastErrorLog = now;
  console.error(`[rate-limit] ${message}:`, e instanceof Error ? e.message : e);
}

async function redisClient(): Promise<RedisLike> {
  const { default: IORedis } = await import("ioredis");
  // Separate from the BullMQ connection: fail fast (500 ms) so a Redis outage falls over to Postgres instead of
  // stalling every API request.
  return new IORedis(process.env.REDIS_URL!, {
    maxRetriesPerRequest: 1,
    commandTimeout: 500,
    connectTimeout: 2_000,
    enableAutoPipelining: true,
  }) as unknown as RedisLike;
}

function postgresStore(): PostgresStore {
  return new PostgresStore(async <T,>(sql: string, ...params: unknown[]) => {
    const { prisma } = await import("@/lib/db");
    return prisma.$queryRawUnsafe<T[]>(sql, ...params);
  });
}

/** Wraps a store whose construction is async (dynamic imports) so callers see a plain RateLimitStore. */
class LazyStore implements RateLimitStore {
  private inner: Promise<RateLimitStore> | null = null;
  constructor(
    readonly name: string,
    private readonly make: () => Promise<RateLimitStore>,
  ) {}
  async hit(key: string, windowStart: number, windowMs: number) {
    if (!this.inner) this.inner = this.make().catch((e) => ((this.inner = null), Promise.reject(e)));
    return (await this.inner).hit(key, windowStart, windowMs);
  }
}

export function getStore(): RateLimitStore {
  if (store) return store;
  const mode = (process.env.RATE_LIMIT_STORE ?? "auto").toLowerCase();
  const redis = new LazyStore("redis", async () => new RedisStore(await redisClient()));
  const pg = postgresStore();
  if (mode === "memory") store = new MemoryStore();
  else if (mode === "postgres") store = pg;
  else if (mode === "redis") store = redis;
  else if (process.env.REDIS_URL) {
    store = new FailoverStore(redis, pg, {
      onFailover: (e) => logThrottled("Redis unavailable, using Postgres for rate limits", e),
    });
  } else store = pg;
  return store;
}

/** Test hook: replace the store (e.g. with a MemoryStore). */
export function setStore(next: RateLimitStore | null): void {
  store = next;
}

export function rateLimitingEnabled(): boolean {
  return process.env.RATE_LIMIT_ENABLED !== "false";
}

function multiplier(): number {
  const m = Number(process.env.RATE_LIMIT_MULTIPLIER ?? "1");
  return Number.isFinite(m) && m > 0 ? m : 1;
}

/** Records one hit for `identifier` against `rule`. Never throws (fails open). */
export async function hit(rule: RateLimitRule, identifier: string): Promise<RateLimitResult | null> {
  if (!rateLimitingEnabled()) return null;
  return consume(getStore(), scaled(rule, multiplier()), identifier, {
    onError: (e) => logThrottled(`store error for ${rule.name}`, e),
  });
}

export function tooManyRequests(result: RateLimitResult, message = "Too many requests. Please wait and try again."): NextResponse {
  return NextResponse.json(
    { error: message, retryAfterSec: result.retryAfterSec },
    { status: 429, headers: rateLimitHeaders(result) },
  );
}

/**
 * For route handlers: applies an identity-based rule (e.g. per email). Returns a 429 response to send, or null
 * to continue. The identifier is normalised (trimmed, lowercased) so "A@x.com" and "a@x.com" share a bucket.
 */
export async function enforce(rule: RateLimitRule, identifier: string, message?: string): Promise<NextResponse | null> {
  const result = await hit(rule, identifier.trim().toLowerCase());
  if (result && !result.allowed) return tooManyRequests(result, message);
  return null;
}

export { rateLimitHeaders };

// sweepExpiredBuckets lives in ./sweep (imported by the worker) so this module, which proxy.ts loads, does not
// pull Prisma in statically.
