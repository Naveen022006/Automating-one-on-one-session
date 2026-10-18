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
 *  - only booking messages: a request is refused unless `guard` confirms a real booking of this influencer with this number, and
 *    the guard is asked again immediately before a send that had to wait (a booking cancelled while queued is not messaged);
 *  - every message may carry a deadline (`deadlineAtMs`), checked again immediately before the send: a message that waited past it is
 *    dropped as "expired" and never sent. A request whose expected wait (the queue ahead of it, at the fixed gap) is longer than
 *    `maxExpectedWaitMs`, or already past its deadline, is refused at once ("busy" / "expired") instead of occupying a worker slot;
 *  - a circuit breaker: `breakerThreshold` failed sends in a row open it, and from then on everything is refused (non-retryable)
 *    so the caller falls back to the official connection, SMS or e-mail at once. The manager reacts to `onTrip` by suspending
 *    the number and telling the influencer;
 *  - a send that does not answer within `callTimeoutMs` is UNKNOWN, not failed: WhatsApp may still deliver it. It is reported as
 *    "unknown-delivery" (never retried, never sent another way), keeps its place in the day's count, and does not count towards the
 *    breaker.
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

export type QueuedSend = Pick<WhatsAppWebSendRequest, "toE164" | "text" | "bookingId" | "key" | "kind" | "deadlineAtMs">;

/** The booking check's answer: see lib/whatsapp-web/booking-guard.ts ("not-sendable": the booking changed while the message waited). */
export type GuardAnswer = boolean | "not-sendable";

/** A send that did not answer in time. Its outcome is unknown. */
class SendTimedOut extends Error {}

function raceSend<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new SendTimedOut(`WhatsApp send timed out after ${ms} ms`)), ms);
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

/** A request that would wait longer than this is refused at once, so it never holds a worker slot. */
export const MAX_EXPECTED_WAIT_MS = 20_000;

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
  guard: (req: QueuedSend) => Promise<GuardAnswer>;
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
  /** Longest wait a new request may expect (the queue ahead of it, at the fixed gap). Default MAX_EXPECTED_WAIT_MS. */
  maxExpectedWaitMs?: number;
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
  private readonly maxExpectedWait: number;

  constructor(private readonly d: SendQueueDeps) {
    this.threshold = d.breakerThreshold ?? 3;
    this.callTimeoutMs = d.callTimeoutMs ?? 30_000;
    this.maxPending = d.maxPending ?? 500;
    this.maxExpectedWait = d.maxExpectedWaitMs ?? MAX_EXPECTED_WAIT_MS;
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

  /** How long a request enqueued now would wait before its send: what is left of the gap, plus one gap per message ahead of it. */
  expectedWaitMs(): number {
    const ahead = this.items.length + (this.running ? 1 : 0);
    return Math.max(0, this.nextAllowedAt - this.d.clock.now()) + ahead * this.d.minGapMs;
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
    const expected = this.expectedWaitMs();
    if (req.deadlineAtMs !== undefined && this.d.clock.now() + expected >= req.deadlineAtMs) return Promise.resolve(fail("expired", false));
    if (expected > this.maxExpectedWait) return Promise.resolve(fail("busy", true));

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

  /** Takes one place of today's count. The key is returned with the count so a refund goes back to the SAME day's counter. */
  private async countToday(): Promise<{ count: number; key: string } | null> {
    const key = kvKeys.sent(this.d.influencerId, istDate(this.d.clock.now()));
    try {
      return { count: await this.d.kv.incr(key, SENT_COUNTER_TTL_MS), key };
    } catch {
      return null;
    }
  }

  private async refund(key: string): Promise<void> {
    try {
      await this.d.kv.decr(key);
    } catch {
      /* the count may stay one too high, which only errs on the safe side */
    }
  }

  private expired(req: QueuedSend): boolean {
    return req.deadlineAtMs !== undefined && this.d.clock.now() >= req.deadlineAtMs;
  }

  private async ask(req: QueuedSend): Promise<WhatsAppWebSendResult | null> {
    let allowed: GuardAnswer;
    try {
      allowed = await this.d.guard(req);
    } catch {
      return fail("guard-unavailable", true);
    }
    if (allowed === "not-sendable") return fail("not-sendable", false);
    return allowed ? null : fail("no-booking", false);
  }

  private async process(req: QueuedSend): Promise<WhatsAppWebSendResult> {
    if (this.open) return fail("circuit-open", false);
    if (this.stopped || !this.d.transport()) return fail("not-connected", true);

    if (this.expired(req)) return fail("expired", false);
    const refused = await this.ask(req);
    if (refused) return refused;

    // Count first, so two readers can never both take the last place of the day.
    const today = await this.countToday();
    if (today === null) return fail("limits-unavailable", true);
    if (today.count > this.d.dailyCap) {
      await this.refund(today.key);
      return fail("daily-cap", false);
    }

    const wait = this.nextAllowedAt - this.d.clock.now();
    if (wait > 0) {
      await this.d.clock.sleep(wait);
      // It waited: it may be too late now, and the booking may have changed. Both are checked again immediately before the send.
      const late = this.expired(req) ? fail("expired", false) : await this.ask(req);
      if (late) {
        await this.refund(today.key);
        return late;
      }
    }
    const transport = this.d.transport();
    if (this.stopped || this.open || !transport) {
      await this.refund(today.key);
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
        await this.refund(today.key);
        return fail("not-on-whatsapp", false);
      }
      const sent = await raceSend(transport.sendText(req.toE164, req.text), this.callTimeoutMs);
      this.setFailures(0);
      result = { ok: true, providerMessageId: sent.providerMessageId };
      try {
        await this.d.onSent?.({ providerMessageId: sent.providerMessageId });
      } catch {
        /* bookkeeping must not turn a sent message into a failure */
      }
    } catch (e) {
      if (e instanceof SendTimedOut) {
        // No answer is not a failure: the message may still be delivered. Its place in today's count stays taken, the breaker is left
        // alone, and the caller must not send it another way (it could arrive twice).
        this.d.onError?.({ code: "send-timeout", retryable: false });
        return fail("unknown-delivery", false);
      }
      await this.refund(today.key);
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
