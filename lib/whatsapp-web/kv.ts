import IORedis from "ioredis";

/**
 * Short-lived shared state of the QR-code WhatsApp mode: the current QR payload of a linking attempt (published by the worker,
 * read by the web app) and the per-day send counters. Redis in every real deployment (the worker and the web app are different
 * processes), a process-local map when REDIS_URL is unset (tests, and a single-process run). Nothing here is ever written to
 * Postgres, and no key or value is ever logged.
 *
 * Keys are `wa-web:...`; callers pass the whole key through `keys` below.
 */

export interface EphemeralKv {
  get(key: string): Promise<string | null>;
  /** Stores a value that disappears after `ttlMs`. */
  set(key: string, value: string, ttlMs: number): Promise<void>;
  del(key: string): Promise<void>;
  /** Adds 1 to a counter (created at 1) and returns the new value. The expiry is set when the counter is created. */
  incr(key: string, ttlMs: number): Promise<number>;
  /** Subtracts 1 from a counter that exists (never below 0). */
  decr(key: string): Promise<void>;
  getInt(key: string): Promise<number>;
  /** Stores a value only if the key does not exist (a lease). True when this call stored it. */
  setNx(key: string, value: string, ttlMs: number): Promise<boolean>;
  /** Extends the expiry of a key, only while it still holds `value` (the lease is still ours). False when it does not. */
  renew(key: string, value: string, ttlMs: number): Promise<boolean>;
  /** Deletes a key, only while it still holds `value`. */
  delIfEquals(key: string, value: string): Promise<boolean>;
  /** Appends to a short-lived list (a queue of small commands for the worker). */
  rpush(key: string, value: string, ttlMs: number): Promise<void>;
  /** Takes everything in a list, oldest first, and empties it (atomically: two readers never get the same entry). */
  drain(key: string): Promise<string[]>;
  close(): Promise<void>;
}

export const kvKeys = {
  qr: (influencerId: string) => `wa-web:qr:${influencerId}`,
  /** One counter per linked number per Indian calendar day. */
  sent: (influencerId: string, istDate: string) => `wa-web:sent:${influencerId}:${istDate}`,
  /** The lease that lets ONE worker hold the linked sockets at a time. */
  lease: "wa-web:manager:lease",
  /** Requests to forget a customer's contact keys in an influencer's stored login. */
  prune: (influencerId: string) => `wa-web:prune:${influencerId}`,
};

/** How long a QR payload stays readable. WhatsApp rotates the code every ~20 s; the first one lives ~60 s. */
export const QR_TTL_MS = 60_000;
/** Counters live two days, so a day's count is still there when the next one starts. */
export const SENT_COUNTER_TTL_MS = 2 * 24 * 60 * 60 * 1000;

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

/** The Indian calendar date (UTC+5:30, no daylight saving) of an instant, as YYYY-MM-DD. */
export function istDate(nowMs: number): string {
  return new Date(nowMs + IST_OFFSET_MS).toISOString().slice(0, 10);
}

export class MemoryKv implements EphemeralKv {
  private readonly map = new Map<string, { value: string; expiresAt: number }>();
  constructor(private readonly now: () => number = Date.now) {}

  private live(key: string): { value: string; expiresAt: number } | undefined {
    const hit = this.map.get(key);
    if (!hit) return undefined;
    if (hit.expiresAt <= this.now()) {
      this.map.delete(key);
      return undefined;
    }
    return hit;
  }

  async get(key: string) {
    return this.live(key)?.value ?? null;
  }
  async set(key: string, value: string, ttlMs: number) {
    this.map.set(key, { value, expiresAt: this.now() + ttlMs });
  }
  async del(key: string) {
    this.map.delete(key);
  }
  async incr(key: string, ttlMs: number) {
    const hit = this.live(key);
    const next = (hit ? Number(hit.value) : 0) + 1;
    this.map.set(key, { value: String(next), expiresAt: hit ? hit.expiresAt : this.now() + ttlMs });
    return next;
  }
  async decr(key: string) {
    const hit = this.live(key);
    if (hit && Number(hit.value) > 0) hit.value = String(Number(hit.value) - 1);
  }
  async getInt(key: string) {
    const hit = this.live(key);
    return hit ? Number(hit.value) || 0 : 0;
  }
  async setNx(key: string, value: string, ttlMs: number) {
    if (this.live(key)) return false;
    this.map.set(key, { value, expiresAt: this.now() + ttlMs });
    return true;
  }
  async renew(key: string, value: string, ttlMs: number) {
    const hit = this.live(key);
    if (!hit || hit.value !== value) return false;
    hit.expiresAt = this.now() + ttlMs;
    return true;
  }
  async delIfEquals(key: string, value: string) {
    const hit = this.live(key);
    if (!hit || hit.value !== value) return false;
    this.map.delete(key);
    return true;
  }
  async rpush(key: string, value: string, ttlMs: number) {
    const hit = this.live(key);
    const list: string[] = hit ? (JSON.parse(hit.value) as string[]) : [];
    list.push(value);
    this.map.set(key, { value: JSON.stringify(list), expiresAt: this.now() + ttlMs });
  }
  async drain(key: string) {
    const hit = this.live(key);
    this.map.delete(key);
    return hit ? (JSON.parse(hit.value) as string[]) : [];
  }
  async close() {
    this.map.clear();
  }
}

/** The subset of ioredis the store uses, so a test can pass a fake. */
export interface RedisKvClient {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, mode: "PX", ttlMs: number): Promise<unknown>;
  del(key: string): Promise<unknown>;
  eval(script: string, numKeys: number, ...args: (string | number)[]): Promise<unknown>;
  quit(): Promise<unknown>;
}

const INCR_SCRIPT = `
local n = redis.call('INCR', KEYS[1])
if n == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
return n
`;
const SETNX_SCRIPT = `
if redis.call('SET', KEYS[1], ARGV[1], 'NX', 'PX', ARGV[2]) then return 1 end
return 0
`;
const RENEW_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('PEXPIRE', KEYS[1], ARGV[2]) end
return 0
`;
const DEL_IF_EQUALS_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end
return 0
`;
const RPUSH_SCRIPT = `
redis.call('RPUSH', KEYS[1], ARGV[1])
redis.call('PEXPIRE', KEYS[1], ARGV[2])
return 1
`;
const DRAIN_SCRIPT = `
local items = redis.call('LRANGE', KEYS[1], 0, -1)
redis.call('DEL', KEYS[1])
return items
`;
const DECR_SCRIPT = `
local v = tonumber(redis.call('GET', KEYS[1]) or '0')
if v > 0 then redis.call('DECR', KEYS[1]) end
return 1
`;

export class RedisKv implements EphemeralKv {
  constructor(private readonly client: RedisKvClient) {}
  get(key: string) {
    return this.client.get(key);
  }
  async set(key: string, value: string, ttlMs: number) {
    await this.client.set(key, value, "PX", ttlMs);
  }
  async del(key: string) {
    await this.client.del(key);
  }
  async incr(key: string, ttlMs: number) {
    return Number(await this.client.eval(INCR_SCRIPT, 1, key, ttlMs));
  }
  async decr(key: string) {
    await this.client.eval(DECR_SCRIPT, 1, key);
  }
  async getInt(key: string) {
    return Number(await this.client.get(key)) || 0;
  }
  async setNx(key: string, value: string, ttlMs: number) {
    return Number(await this.client.eval(SETNX_SCRIPT, 1, key, value, ttlMs)) === 1;
  }
  async renew(key: string, value: string, ttlMs: number) {
    return Number(await this.client.eval(RENEW_SCRIPT, 1, key, value, ttlMs)) === 1;
  }
  async delIfEquals(key: string, value: string) {
    return Number(await this.client.eval(DEL_IF_EQUALS_SCRIPT, 1, key, value)) === 1;
  }
  async rpush(key: string, value: string, ttlMs: number) {
    await this.client.eval(RPUSH_SCRIPT, 1, key, value, ttlMs);
  }
  async drain(key: string) {
    const items = await this.client.eval(DRAIN_SCRIPT, 1, key);
    return Array.isArray(items) ? items.map(String) : [];
  }
  async close() {
    await this.client.quit().catch(() => {});
  }
}

let shared: EphemeralKv | null = null;

/** The process-wide store: Redis when REDIS_URL is set, otherwise memory (see the note at the top). */
export function getKv(): EphemeralKv {
  if (shared) return shared;
  const url = process.env.REDIS_URL;
  if (url) {
    // Bounded waits: a status poll or a send must not hang because Redis is down.
    const client = new IORedis(url, { maxRetriesPerRequest: 1, commandTimeout: 1_500, connectTimeout: 2_000 });
    client.on("error", () => {}); // an unhandled 'error' event would crash the process; the failing command already rejects
    shared = new RedisKv(client as unknown as RedisKvClient);
  } else {
    shared = new MemoryKv();
  }
  return shared;
}

/** Test hook: replace (or with null, forget) the process-wide store. */
export function setKv(next: EphemeralKv | null): void {
  shared = next;
}
