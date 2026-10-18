import { isLocalAppUrl } from "../provider-endpoints";

/**
 * Settings of the optional "link WhatsApp by QR code" mode (doc/14-whatsapp-qr-*.md), read from the environment. Pure: nothing is
 * cached and nothing is logged, every call reads the record it is given. An unset OR EMPTY variable means the default (never 0).
 * lib/env.ts validates the same variables at start-up and says what is wrong with a bad value; this reader is deliberately
 * forgiving and falls back to the default, so a bad value can never turn a safety limit off.
 */

export type EnvRecord = Record<string, string | undefined>;

export const QR_DEFAULTS = {
  /** Sockets one worker keeps open (each is a live connection to WhatsApp and some memory). */
  maxSessions: 10,
  /** Messages one linked number may send per Indian calendar day. */
  dailyCap: 150,
  /** Fixed minimum time between two sends from the same number. */
  minGapMs: 4_000,
} as const;

/** The smallest spacing the variable accepts: below this a number would send in bursts, which is what gets numbers banned. */
export const QR_MIN_GAP_FLOOR_MS = 1_000;
/**
 * The largest spacing that is honoured. A request that would wait longer than 20 s for its turn is refused at once as "busy" (the send
 * queue, so it never holds a worker job), and with a gap of 20 s or more every message that arrives inside the gap would be: almost
 * everything would silently go the other way. A larger value is lowered to this one, with a warning at start-up (`qrGapClamp`).
 */
export const QR_MIN_GAP_CEILING_MS = 14_000;

export interface WhatsAppQrConfig {
  /** Platform switch (WHATSAPP_QR_ENABLED). Off by default: nothing connects, nothing is sent this way. */
  enabled: boolean;
  /** The local simulator (WHATSAPP_QR_FAKE). Only ever true outside production with a local APP_URL. */
  fake: boolean;
  maxSessions: number;
  dailyCap: number;
  minGapMs: number;
  /** Keep the encrypted login when the platform switch is turned off (default: wipe it). */
  keepAuthWhenDisabled: boolean;
}

function text(env: EnvRecord, name: string): string | undefined {
  const v = env[name]?.trim();
  return v ? v : undefined;
}

function flag(env: EnvRecord, name: string): boolean {
  return text(env, name)?.toLowerCase() === "true";
}

function wholeNumber(env: EnvRecord, name: string, fallback: number, min: number, max: number): number {
  const raw = text(env, name);
  if (raw === undefined || !/^\d+$/.test(raw)) return fallback;
  const n = Number(raw);
  return Number.isSafeInteger(n) && n >= min && n <= max ? n : fallback;
}

/** Why a requested WHATSAPP_QR_FAKE=true is not honoured, or null when it is (or was not asked for). */
export function qrFakeRefusal(env: EnvRecord = process.env): string | null {
  if (!flag(env, "WHATSAPP_QR_FAKE")) return null;
  if (env.NODE_ENV === "production") return "WHATSAPP_QR_FAKE is refused in production";
  if (!isLocalAppUrl(env.APP_URL)) return "WHATSAPP_QR_FAKE needs APP_URL to be set to a local address (localhost, 127.0.0.1, [::1], *.localhost)";
  return null;
}

/** Why WHATSAPP_QR_MIN_GAP_MS is lowered, or null when it is used as it is. For the start-up warning (lib/env.ts). */
export function qrGapClamp(env: EnvRecord = process.env): string | null {
  const raw = text(env, "WHATSAPP_QR_MIN_GAP_MS");
  if (raw === undefined || !/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n <= QR_MIN_GAP_CEILING_MS || n > 3_600_000) return null;
  return `is lowered to ${QR_MIN_GAP_CEILING_MS} ms: a gap of 20 s or more would make every message that arrives inside it go another way at once`;
}

export function readQrConfig(env: EnvRecord = process.env): WhatsAppQrConfig {
  return {
    enabled: flag(env, "WHATSAPP_QR_ENABLED"),
    fake: flag(env, "WHATSAPP_QR_FAKE") && qrFakeRefusal(env) === null,
    maxSessions: wholeNumber(env, "WHATSAPP_QR_MAX_SESSIONS", QR_DEFAULTS.maxSessions, 1, 1_000),
    dailyCap: wholeNumber(env, "WHATSAPP_QR_DAILY_CAP", QR_DEFAULTS.dailyCap, 1, 10_000),
    minGapMs: Math.min(QR_MIN_GAP_CEILING_MS, wholeNumber(env, "WHATSAPP_QR_MIN_GAP_MS", QR_DEFAULTS.minGapMs, QR_MIN_GAP_FLOOR_MS, 3_600_000)),
    keepAuthWhenDisabled: flag(env, "WHATSAPP_QR_KEEP_AUTH_WHEN_DISABLED"),
  };
}
