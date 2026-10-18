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
  close(): Promise<void>;
}

export const kvKeys = {
  qr: (influencerId: string) => `wa-web:qr:${influencerId}`,
  /** One counter per linked number per Indian calendar day. */
  sent: (influencerId: string, istDate: string) => `wa-web:sent:${influencerId}:${istDate}`,
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
