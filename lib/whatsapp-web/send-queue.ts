import { within } from "../timeout";
import { istDate, kvKeys, SENT_COUNTER_TTL_MS, type EphemeralKv } from "./kv";
import type { WhatsAppWebSendRequest, WhatsAppWebSendResult } from "./send";
import { WhatsAppWebTransportError, type WhatsAppWebTransport } from "./transport";

/**
 * The outgoing queue of ONE linked number. Plain throttling to protect the influencer's number and avoid spam, nothing else:
 *
 *  - first in, first out, one send at a time, at least `minGapMs` between two sends (a fixed gap, no randomness);
 *  - a cap per Indian calendar day (`dailyCap`), counted in Redis so it survives a restart and is the same for every reader;
 *  - the number is checked to be on WhatsApp before the first message to it (and the answer is remembered for a while);
 *  - only booking messages: a request is refused unless `guard` confirms a real booking of this influencer with this number;
 *  - a circuit breaker: `breakerThreshold` failed sends in a row open it, and from then on everything is refused (non-retryable)
 *    so the caller falls back to the official connection, SMS or e-mail at once. The manager reacts to `onTrip` by suspending
 *    the number and telling the influencer.
 *
 * It never reads anything incoming. All waiting goes through the injected `clock`, so tests run in no time.
 */

export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export const realClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

export type QueuedSend = Pick<WhatsAppWebSendRequest, "toE164" | "text" | "bookingId" | "key">;

export interface SendQueueDeps {
  influencerId: string;
  /** The open transport, or null while the number is not connected. Read at the moment of each send. */
  transport: () => WhatsAppWebTransport | null;
  kv: EphemeralKv;
  clock: Clock;
  minGapMs: number;
  dailyCap: number;
  /** Failed sends in a row that open the breaker. Default 3. */
  breakerThreshold?: number;
  /** True when this influencer really has a booking with this number that a message may be about. */
  guard: (req: QueuedSend) => Promise<boolean>;
  /** A message went out. */
  onSent?: (info: { providerMessageId: string }) => void | Promise<void>;
  /** The consecutive-failure count changed (for the dashboard). */
  onFailureCount?: (count: number) => void;
  /** The breaker opened. `reason` is a short machine code. */
  onTrip?: (reason: string) => void;
  /** Failed sends, for logs. Never receives a message text. */
  onError?: (info: { code: string; retryable: boolean }) => void;
  initialFailures?: number;
  /** Longest wait for the transport, per call. Default 30 s. */
  callTimeoutMs?: number;
  maxPending?: number;
}

const E164 = /^\+[1-9]\d{6,14}$/;
const RECENT_LIMIT = 200;
const KNOWN_LIMIT = 1_000;

interface Item {
  req: QueuedSend;
  resolve: (r: WhatsAppWebSendResult) => void;
}

const fail = (reason: string, retryable: boolean): WhatsAppWebSendResult => ({ ok: false, reason, retryable });

export class SendQueue {
  private readonly items: Item[] = [];
  private readonly inflight = new Map<string, Promise<WhatsAppWebSendResult>>();
  private readonly recentOk = new Map<string, WhatsAppWebSendResult>();
  /** Numbers already checked: true = on WhatsApp, false = not. */
  private readonly known = new Map<string, boolean>();
  private running = false;
  private stopped = false;
  private nextAllowedAt = 0;
  private failures: number;
  private open = false;
  private readonly threshold: number;
  private readonly callTimeoutMs: number;
  private readonly maxPending: number;

  constructor(private readonly d: SendQueueDeps) {
    this.threshold = d.breakerThreshold ?? 3;
    this.callTimeoutMs = d.callTimeoutMs ?? 30_000;
    this.maxPending = d.maxPending ?? 500;
    this.failures = d.initialFailures ?? 0;
    if (this.failures >= this.threshold) this.open = true;
  }

  get pending(): number {
    return this.items.length;
  }
  get tripped(): boolean {
    return this.open;
  }
  get consecutiveFailures(): number {
    return this.failures;
  }

  /** Queues one booking message. Always resolves; never rejects. */
  enqueue(req: QueuedSend): Promise<WhatsAppWebSendResult> {
    if (!E164.test(req.toE164)) return Promise.resolve(fail("invalid-number", false));
    if (!req.text.trim()) return Promise.resolve(fail("empty-text", false));
    if (!req.bookingId || !req.key) return Promise.resolve(fail("missing-booking", false));
    if (this.open) return Promise.resolve(fail("circuit-open", false));
    if (this.stopped) return Promise.resolve(fail("not-connected", true));
    const done = this.recentOk.get(req.key);
    if (done) return Promise.resolve(done);
    const running = this.inflight.get(req.key);
    if (running) return running;
    if (this.items.length >= this.maxPending) return Promise.resolve(fail("queue-full", true));

    const promise = new Promise<WhatsAppWebSendResult>((resolve) => this.items.push({ req, resolve }));
    this.inflight.set(req.key, promise);
    void promise.then((r) => {
      this.inflight.delete(req.key);
      if (r.ok) {
        this.recentOk.set(req.key, r);
        if (this.recentOk.size > RECENT_LIMIT) this.recentOk.delete(this.recentOk.keys().next().value as string);
      }
    });
    void this.drain();
    return promise;
  }

  /** Refuses everything still waiting (retryable: the number is going away) and everything that comes later. */
  stop(): void {
    this.stopped = true;
    this.flushPending(fail("not-connected", true));
  }

  private flushPending(result: WhatsAppWebSendResult): void {
    for (const item of this.items.splice(0)) item.resolve(result);
  }

  private async drain(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while (this.items.length > 0) {
        const item = this.items.shift()!;
        let result: WhatsAppWebSendResult;
        try {
          result = await this.process(item.req);
        } catch (e) {
          // Defensive: process() answers instead of throwing. A bug here must not wedge the queue.
          this.d.onError?.({ code: e instanceof Error ? e.name : "error", retryable: true });
          result = fail("queue-error", true);
        }
        item.resolve(result);
      }
    } finally {
      this.running = false;
    }
  }

  private async countToday(): Promise<number | null> {
    try {
      return await this.d.kv.incr(kvKeys.sent(this.d.influencerId, istDate(this.d.clock.now())), SENT_COUNTER_TTL_MS);
    } catch {
      return null;
    }
  }

  private async refund(): Promise<void> {
    try {
      await this.d.kv.decr(kvKeys.sent(this.d.influencerId, istDate(this.d.clock.now())));
    } catch {
      /* the count may stay one too high, which only errs on the safe side */
    }
  }

  private async process(req: QueuedSend): Promise<WhatsAppWebSendResult> {
    if (this.open) return fail("circuit-open", false);
    if (this.stopped || !this.d.transport()) return fail("not-connected", true);

    let allowed: boolean;
    try {
      allowed = await this.d.guard(req);
    } catch {
      return fail("guard-unavailable", true);
    }
    if (!allowed) return fail("no-booking", false);

    // Count first, so two readers can never both take the last place of the day.
    const today = await this.countToday();
    if (today === null) return fail("limits-unavailable", true);
    if (today > this.d.dailyCap) {
      await this.refund();
      return fail("daily-cap", false);
    }

    const wait = this.nextAllowedAt - this.d.clock.now();
    if (wait > 0) await this.d.clock.sleep(wait);
    const transport = this.d.transport();
    if (this.stopped || this.open || !transport) {
      await this.refund();
      return fail(this.open ? "circuit-open" : "not-connected", !this.open);
    }

    let result: WhatsAppWebSendResult;
    try {
      let exists = this.known.get(req.toE164);
      if (exists === undefined) {
        exists = await within(transport.numberExists(req.toE164), this.callTimeoutMs, "WhatsApp number check");
        this.remember(req.toE164, exists);
      }
      if (!exists) {
        await this.refund();
        return fail("not-on-whatsapp", false);
      }
      const sent = await within(transport.sendText(req.toE164, req.text), this.callTimeoutMs, "WhatsApp send");
      this.setFailures(0);
      result = { ok: true, providerMessageId: sent.providerMessageId };
      try {
        await this.d.onSent?.({ providerMessageId: sent.providerMessageId });
      } catch {
        /* bookkeeping must not turn a sent message into a failure */
      }
    } catch (e) {
      await this.refund();
      const code = e instanceof WhatsAppWebTransportError ? e.code : "send-failed";
      const retryable = e instanceof WhatsAppWebTransportError ? e.retryable : true;
      this.d.onError?.({ code, retryable });
      // "not connected" is the connection dropping, which the manager handles by reconnecting; it is not a failed send.
      if (code !== "not-connected") {
        this.setFailures(this.failures + 1);
        if (this.failures >= this.threshold && !this.open) {
          this.open = true;
          this.flushPending(fail("circuit-open", false));
          this.d.onTrip?.(`${this.threshold}-failed-sends`);
          return fail("circuit-open", false);
        }
      }
      result = fail(code, retryable);
    } finally {
      this.nextAllowedAt = this.d.clock.now() + this.d.minGapMs;
    }
    return result;
  }

  private remember(e164: string, exists: boolean): void {
    this.known.set(e164, exists);
    if (this.known.size > KNOWN_LIMIT) this.known.delete(this.known.keys().next().value as string);
  }

  private setFailures(n: number): void {
    if (n === this.failures) return;
    this.failures = n;
    this.d.onFailureCount?.(n);
  }
}
