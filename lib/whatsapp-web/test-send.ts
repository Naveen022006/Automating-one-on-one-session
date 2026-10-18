import { BRAND_NAME } from "@/lib/brand";
import { prisma } from "@/lib/db";
import { readQrConfig } from "./config";
import { getKv, type EphemeralKv } from "./kv";
import { whatsAppWebTestText } from "./messages";
import { SELF_TEST_BOOKING_ID, sendWhatsAppWebText, type WhatsAppWebSendRequest, type WhatsAppWebSendResult } from "./send";

/**
 * The "send me a test message" button of the QR-code WhatsApp card. One message, to the influencer's OWN linked number and nobody
 * else's (the send queue refuses any other destination for the self-test booking id), at most one a minute.
 *
 * The web app holds no WhatsApp socket, so it cannot send. It asks the worker through a one-job queue (lib/whatsapp-web/test-queue.ts)
 * and waits a few seconds for the answer in the shared store; if the worker is slower than that the answer is "pending" and the
 * message may still arrive. Nothing about the destination travels through the queue: the worker reads the linked number from the
 * influencer's own session row.
 */

export const TEST_COOLDOWN_MS = 60_000;
export const TEST_RESULT_TTL_MS = 5 * 60_000;
/** How long the request waits for the worker's answer, and how often it looks. The send queue's own gap between messages is 4 s. */
export const TEST_WAIT_MS = 12_000;
export const TEST_POLL_MS = 300;

export const testKeys = {
  cooldown: (influencerId: string) => `wa-web:test:cooldown:${influencerId}`,
  result: (influencerId: string) => `wa-web:test:result:${influencerId}`,
};

export interface TestJob {
  influencerId: string;
  requestId: string;
}

export type TestSendOutcome = { state: "sent" } | { state: "failed"; reason: string; message: string } | { state: "pending" };

export type TestSendRefusal = {
  ok: false;
  code: "disabled" | "not-linked" | "cooldown" | "unavailable";
  message: string;
  retryAfterSec?: number;
};

export interface TestSendDeps {
  kv?: EphemeralKv;
  /** Puts the job on the worker's queue. Throws when the queue is not reachable. */
  enqueue?: (job: TestJob) => Promise<void>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  waitMs?: number;
  pollMs?: number;
  newRequestId?: () => string;
}

let enqueueOverride: ((job: TestJob) => Promise<void>) | null = null;
/** Test hook: replaces the queue (null puts the real one back). */
export function setTestEnqueue(fn: ((job: TestJob) => Promise<void>) | null): void {
  enqueueOverride = fn;
}

/** What the influencer reads when a test message could not be sent. */
export function describeTestFailure(reason: string): string {
  switch (reason) {
    case "daily-cap":
      return "The daily limit for this number is used up. Try again tomorrow.";
    case "not-connected":
    case "not-linked":
    case "manager-not-running":
      return "The number is not connected to WhatsApp right now. Try again in a minute.";
    case "circuit-open":
      return "Sending from this number is paused after repeated failures.";
    case "queue-full":
      return "Too many messages are waiting. Try again in a minute.";
    default:
      return "The test message could not be sent. Try again in a minute.";
  }
}

const linkedNumber = (influencerId: string) =>
  prisma.whatsAppWebSession.findUnique({ where: { influencerId }, select: { status: true, wantLinked: true, phoneE164: true } });

/**
 * The web side. `{ ok: true, outcome }` once a job was queued (the outcome may still be "pending"); a refusal otherwise.
 * The cooldown is taken only for a request that really goes to the worker, and a second request inside the minute is refused
 * before anything is queued.
 */
export async function requestTestSend(influencerId: string, deps: TestSendDeps = {}): Promise<{ ok: true; outcome: TestSendOutcome } | TestSendRefusal> {
  if (!readQrConfig().enabled) return { ok: false, code: "disabled", message: "Linking WhatsApp by QR code is not available." };
  const row = await linkedNumber(influencerId);
  if (!row || row.status !== "LINKED" || !row.wantLinked || !row.phoneE164) {
    return { ok: false, code: "not-linked", message: "Link your WhatsApp number first." };
  }

  const kv = deps.kv ?? getKv();
  const claimed = await kv.incr(testKeys.cooldown(influencerId), TEST_COOLDOWN_MS).catch(() => 1);
  if (claimed > 1) {
    return { ok: false, code: "cooldown", message: "A test message was sent a moment ago. Wait a minute before sending another.", retryAfterSec: Math.ceil(TEST_COOLDOWN_MS / 1000) };
  }

  const requestId = (deps.newRequestId ?? (() => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`))();
  const enqueue = deps.enqueue ?? enqueueOverride ?? (async (job: TestJob) => (await import("./test-queue")).enqueueTestJob(job));
  try {
    await kv.del(testKeys.result(influencerId));
    await enqueue({ influencerId, requestId });
  } catch {
    await kv.del(testKeys.cooldown(influencerId)).catch(() => {});
    return { ok: false, code: "unavailable", message: "The background worker is not available, so the test message could not be sent. Try again in a minute." };
  }

  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const deadline = now() + (deps.waitMs ?? TEST_WAIT_MS);
  for (;;) {
    const raw = await kv.get(testKeys.result(influencerId)).catch(() => null);
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as { requestId?: string; ok?: boolean; reason?: string };
        if (parsed.requestId === requestId) {
          return { ok: true, outcome: parsed.ok ? { state: "sent" } : { state: "failed", reason: String(parsed.reason ?? "send-error"), message: describeTestFailure(String(parsed.reason ?? "")) } };
        }
      } catch {
        /* an unreadable answer is treated as no answer yet */
      }
    }
    if (now() >= deadline) return { ok: true, outcome: { state: "pending" } };
    await sleep(deps.pollMs ?? TEST_POLL_MS);
  }
}

/**
 * The worker side: sends the test text to the linked number and stores the answer for the waiting request. The destination is read from
 * the database here, never taken from the job. Never throws.
 */
export async function runTestSend(
  job: TestJob,
  deps: { kv?: EphemeralKv; send?: (req: WhatsAppWebSendRequest) => Promise<WhatsAppWebSendResult> } = {},
): Promise<void> {
  const kv = deps.kv ?? getKv();
  const send = deps.send ?? sendWhatsAppWebText;
  let result: WhatsAppWebSendResult;
  try {
    const row = await linkedNumber(job.influencerId);
    if (!row || row.status !== "LINKED" || !row.wantLinked || !row.phoneE164) result = { ok: false, reason: "not-linked", retryable: false };
    else {
      result = await send({
        influencerId: job.influencerId,
        toE164: row.phoneE164,
        text: whatsAppWebTestText(BRAND_NAME),
        bookingId: SELF_TEST_BOOKING_ID,
        key: `${SELF_TEST_BOOKING_ID}:${job.requestId}`,
      });
    }
  } catch {
    result = { ok: false, reason: "send-error", retryable: true };
  }
  const answer = JSON.stringify({ requestId: job.requestId, ok: result.ok, ...(result.ok ? {} : { reason: result.reason }) });
  await kv.set(testKeys.result(job.influencerId), answer, TEST_RESULT_TTL_MS).catch(() => {});
}
