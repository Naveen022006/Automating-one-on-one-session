import type { RateLimitStore, WindowCounts } from "./core";

/**
 * Redis store. One Lua script per hit: INCR the current bucket (setting its TTL on first use) and read the
 * previous bucket, atomically. Keys use a `{hash tag}` so both buckets of a key land on the same cluster slot
 * (works on Upstash and Redis Cluster).
 */
const HIT_SCRIPT = `
local cur = redis.call('INCR', KEYS[1])
if cur == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
local prev = redis.call('GET', KEYS[2])
return {cur, tonumber(prev or '0')}
`;

/** The subset of an ioredis client the store uses, so tests can pass a fake. */
export interface RedisLike {
  eval(script: string, numKeys: number, ...args: (string | number)[]): Promise<unknown>;
}

export class RedisStore implements RateLimitStore {
  readonly name = "redis";
  constructor(
    private readonly client: RedisLike,
    private readonly prefix = "rl",
  ) {}

  async hit(key: string, windowStart: number, windowMs: number): Promise<WindowCounts> {
    const k = `${this.prefix}:{${key}}`;
    const res = (await this.client.eval(
      HIT_SCRIPT,
      2,
      `${k}:${windowStart}`,
      `${k}:${windowStart - windowMs}`,
      2 * windowMs,
    )) as [number, number];
    return { current: Number(res[0]), previous: Number(res[1]) };
  }
}

/**
 * Postgres store over the `rate_limit_buckets` table. A single statement upserts the current bucket and reads
 * the previous one, so it is atomic per row and costs one round trip. Rows expire after two windows and are
 * swept by the worker (sweepExpiredBuckets).
 */
export type SqlQuery = <T>(sql: string, ...params: unknown[]) => Promise<T[]>;

export class PostgresStore implements RateLimitStore {
  readonly name = "postgres";
  constructor(private readonly query: SqlQuery) {}

  async hit(key: string, windowStart: number, windowMs: number): Promise<WindowCounts> {
    const rows = await this.query<{ current: number | bigint; previous: number | bigint }>(
      // Times are passed as UTC ISO strings and converted explicitly, so the stored TIMESTAMP(3) values are UTC
      // wall-clock (what Prisma writes) whatever the database session time zone is.
      `WITH cur AS (
         INSERT INTO rate_limit_buckets (key, window_start, count, expires_at)
         VALUES ($1, ($2::timestamptz AT TIME ZONE 'UTC'), 1, ($3::timestamptz AT TIME ZONE 'UTC'))
         ON CONFLICT (key, window_start) DO UPDATE SET count = rate_limit_buckets.count + 1
         RETURNING count
       )
       SELECT (SELECT count FROM cur)::int AS current,
              COALESCE((SELECT count FROM rate_limit_buckets
                        WHERE key = $1 AND window_start = ($4::timestamptz AT TIME ZONE 'UTC')), 0)::int AS previous`,
      key,
      new Date(windowStart).toISOString(),
      new Date(windowStart + 2 * windowMs).toISOString(),
      new Date(windowStart - windowMs).toISOString(),
    );
    const row = rows[0];
    return { current: Number(row?.current ?? 1), previous: Number(row?.previous ?? 0) };
  }
}
