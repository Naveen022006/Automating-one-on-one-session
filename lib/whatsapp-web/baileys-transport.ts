import type * as BaileysTypes from "@whiskeysockets/baileys";
import { describeError, safely, safeEvents } from "./safe";
import {
  WhatsAppWebTransportError,
  type WhatsAppAuthStore,
  type WhatsAppWebCloseInfo,
  type WhatsAppWebDeliveryStatus,
  type WhatsAppWebTransport,
  type WhatsAppWebTransportEvents,
  type WhatsAppWebTransportFactory,
} from "./transport";

/**
 * THE ONLY FILE THAT KNOWS BAILEYS (@whiskeysockets/baileys, pinned in package.json), the unofficial library that speaks WhatsApp's
 * linked-device protocol. Rules that keep it contained:
 *  - the library is loaded with a dynamic import() INSIDE functions, so importing this file loads nothing: tests, `next build`, the
 *    web process and web/vite-server-guard.ts (which does not allow lib/whatsapp-web/* in the browser bundle) never touch it;
 *  - everything it exposes is the neutral interface of lib/whatsapp-web/transport.ts;
 *  - it subscribes to the connection's own events and to the delivery state of messages WE sent. It never subscribes to incoming
 *    messages, chats, contacts or history, and asks the library not to sync history, so nothing a customer writes is read here;
 *  - the library's logger is replaced by a silent one: it can print QR payloads, JIDs (phone numbers) and key material;
 *  - every callback the library calls (its event handlers, our key store) is wrapped (./safe.ts): a throw or a rejection inside one
 *    becomes one log line with the error's name, never an unhandled rejection or an uncaught exception in the worker.
 *
 * Plain behaviour only: the browser identification is the library's default, and nothing here simulates typing, presence or any
 * other human behaviour. Sending is paced by the send queue (lib/whatsapp-web/send-queue.ts).
 */

export type BaileysModule = typeof BaileysTypes;

/** Loads the library. Exported so a test can pass a stand-in instead (the library is never opened by tests). */
export type BaileysLoader = () => Promise<BaileysModule>;

let cachedLoad: Promise<BaileysModule> | null = null;
export const loadBaileys: BaileysLoader = () => {
  cachedLoad ??= import("@whiskeysockets/baileys");
  return cachedLoad;
};

/** True when the library can be loaded on this machine (used by the worker before it starts the manager). */
export async function baileysAvailable(load: BaileysLoader = loadBaileys): Promise<boolean> {
  try {
    const m = await load();
    return typeof m.makeWASocket === "function" && typeof m.initAuthCreds === "function";
  } catch {
    return false;
  }
}

const noop = (): void => {};
const silentLogger = {
  level: "silent",
  child() {
    return silentLogger;
  },
  trace: noop,
  debug: noop,
  info: noop,
  warn: noop,
  error: noop,
};

const SENT_CACHE = 200;

/** Maps the library's disconnect status code onto the neutral close reasons. */
export function mapDisconnect(statusCode: number | undefined, DisconnectReason: BaileysModule["DisconnectReason"]): WhatsAppWebCloseInfo {
  switch (statusCode) {
    case DisconnectReason.loggedOut:
      return { reason: "logged-out", code: "logged-out" };
    case DisconnectReason.badSession:
      return { reason: "logged-out", code: "bad-session" };
    case DisconnectReason.forbidden:
      return { reason: "restricted", code: "forbidden" };
    case DisconnectReason.restartRequired:
      return { reason: "transient", code: "restart-required" };
    case DisconnectReason.connectionReplaced:
      return { reason: "transient", code: "replaced" };
    case DisconnectReason.multideviceMismatch:
      return { reason: "transient", code: "multidevice-mismatch" };
    case DisconnectReason.unavailableService:
      return { reason: "transient", code: "unavailable" };
    case DisconnectReason.timedOut:
      return { reason: "transient", code: "timed-out" };
    case DisconnectReason.connectionClosed:
      return { reason: "transient", code: "connection-closed" };
    default:
      return { reason: "transient", code: "closed" };
  }
}

/** proto.WebMessageInfo.Status: ERROR 0, PENDING 1, SERVER_ACK 2, DELIVERY_ACK 3, READ 4, PLAYED 5. */
export function mapStatus(status: number | null | undefined): WhatsAppWebDeliveryStatus | null {
  switch (status) {
    case 0:
      return "failed";
    case 2:
      return "sent";
    case 3:
      return "delivered";
    case 4:
    case 5:
      return "read";
    default:
      return null;
  }
}

type Sock = ReturnType<BaileysModule["makeWASocket"]>;

export class BaileysTransport implements WhatsAppWebTransport {
  private sock: Sock | null = null;
  private baileys: BaileysModule | null = null;
  private ended = false;
  private open = false;
  private readonly jids = new Map<string, string>();
  private readonly sentIds = new Set<string>();
  private readonly sentMessages = new Map<string, unknown>();

  constructor(
    private readonly load: BaileysLoader = loadBaileys,
    /** One line per contained error (the error's name only). */
    private readonly log: (line: string) => void = () => {},
  ) {}

  async connect(auth: WhatsAppAuthStore, rawEvents: WhatsAppWebTransportEvents): Promise<void> {
    const contained = (what: string) => (e: unknown) => this.log(`adapter: ${what} failed (${describeError(e)})`);
    const events = safeEvents(rawEvents, contained("an event handler"));
    const b = await this.load();
    this.baileys = b;
    const stored = auth.getCreds() as BaileysTypes.AuthenticationCreds | undefined;
    const creds = stored ?? b.initAuthCreds();

    const keys: BaileysTypes.SignalKeyStore = {
      get: async (type, ids) => {
        const out: Record<string, never> = {};
        try {
          const found = auth.getKeys(type, ids);
          for (const id of ids) {
            let value = found[id];
            if (type === "app-state-sync-key" && value) value = b.proto.Message.AppStateSyncKeyData.fromObject(value as never);
            out[id] = value as never;
          }
        } catch (e) {
          contained("reading keys")(e); // the library then sees missing keys, which it handles
        }
        return out;
      },
      set: async (data) => {
        try {
          auth.setKeys(data as unknown as Record<string, Record<string, unknown | null>>);
        } catch (e) {
          contained("saving keys")(e);
        }
      },
      clear: async () => {
        try {
          auth.clearKeys();
        } catch (e) {
          contained("clearing keys")(e);
        }
      },
    };

    const sock = b.makeWASocket({
      auth: { creds, keys },
      logger: silentLogger,
      // The phone keeps ringing and showing notifications as usual while this device is connected.
      markOnlineOnConnect: false,
      // Nothing from the user's chats is wanted: no history, no previews.
      syncFullHistory: false,
      shouldSyncHistoryMessage: () => false,
      generateHighQualityLinkPreview: false,
      // Lets the library answer a recipient's "resend" request for a message we sent a moment ago.
      getMessage: async (key) => (key.id ? (this.sentMessages.get(key.id) as never) : undefined),
    });
    this.sock = sock;

    sock.ev.on("creds.update", safely(() => {
      // Only a linked device has credentials worth keeping: an unfinished scan leaves nothing behind.
      if (creds.me) auth.setCreds(creds);
    }, contained("saving credentials")));

    sock.ev.on("connection.update", safely((update: Parameters<Parameters<Sock["ev"]["on"]>[1]>[0] & { qr?: string; connection?: string; lastDisconnect?: { error?: unknown } }) => {
      if (this.ended) return;
      if (update.qr) events.onQr(update.qr);
      if (update.connection === "open") {
        this.open = true;
        const user = sock.user?.id ? b.jidDecode(sock.user.id)?.user : undefined;
        const browser = b.DEFAULT_CONNECTION_CONFIG.browser;
        // The credentials are final once the connection is open (a first scan has just completed).
        if (creds.me) auth.setCreds(creds);
        events.onOpen({ phoneE164: user ? `+${user}` : "", deviceLabel: browser ? `${browser[1]} (${browser[0]})` : null });
      } else if (update.connection === "close") {
        this.open = false;
        const statusCode = (update.lastDisconnect?.error as { output?: { statusCode?: number } } | undefined)?.output?.statusCode;
        events.onClose(mapDisconnect(statusCode, b.DisconnectReason));
      }
    }, contained("a connection update")) as never);

    // The delivery state of messages WE sent, matched by id. Anything else in this event is ignored.
    sock.ev.on("messages.update", safely((updates: { key?: { id?: string | null; fromMe?: boolean | null }; update?: { status?: unknown } }[]) => {
      for (const u of updates) {
        const id = u.key?.id;
        if (!id || !u.key?.fromMe || !this.sentIds.has(id)) continue;
        const status = mapStatus(u.update?.status as number | undefined);
        if (status) events.onDelivery({ providerMessageId: id, status });
      }
    }, contained("a delivery update")) as never);
  }

  private requireSock(): Sock {
    if (!this.sock || this.ended || !this.open) throw new WhatsAppWebTransportError("not connected", "not-connected", true);
    return this.sock;
  }

  private digits(e164: string): string {
    const d = e164.replace(/\D/g, "");
    if (!/^[1-9]\d{6,14}$/.test(d)) throw new WhatsAppWebTransportError("invalid number", "invalid-number", false);
    return d;
  }

  async numberExists(e164: string): Promise<boolean> {
    const sock = this.requireSock();
    const digits = this.digits(e164);
    try {
      const res = await sock.onWhatsApp(`+${digits}`);
      const hit = res?.find((r) => r.exists);
      if (hit) this.jids.set(e164, hit.jid);
      return Boolean(hit);
    } catch (e) {
      throw this.wrap(e, "number-check-failed");
    }
  }

  async sendText(toE164: string, text: string): Promise<{ providerMessageId: string }> {
    const sock = this.requireSock();
    const digits = this.digits(toE164);
    const jid = this.jids.get(toE164) ?? `${digits}@s.whatsapp.net`;
    try {
      const sent = await sock.sendMessage(jid, { text });
      const id = sent?.key?.id;
      if (!id) throw new WhatsAppWebTransportError("no message id returned", "no-message-id", true);
      this.sentIds.add(id);
      if (sent?.message) this.sentMessages.set(id, sent.message);
      if (this.sentIds.size > SENT_CACHE) {
        const oldest = this.sentIds.values().next().value as string;
        this.sentIds.delete(oldest);
        this.sentMessages.delete(oldest);
      }
      return { providerMessageId: id };
    } catch (e) {
      throw this.wrap(e, "send-failed");
    }
  }

  /** A library error carries the destination in its message, so only a code and the retry advice leave this class. */
  private wrap(e: unknown, code: string): WhatsAppWebTransportError {
    if (e instanceof WhatsAppWebTransportError) return e;
    const status = (e as { output?: { statusCode?: number } } | undefined)?.output?.statusCode;
    if (status === 428 || status === 408) return new WhatsAppWebTransportError("not connected", "not-connected", true);
    return new WhatsAppWebTransportError("WhatsApp refused or failed the request", code, true);
  }

  async logout(): Promise<void> {
    const sock = this.sock;
    if (sock && !this.ended && this.open) {
      try {
        await sock.logout("unlinked from the dashboard");
      } catch {
        /* the device may already be gone; the local login is wiped by the caller either way */
      }
    }
    await this.end();
  }

  async end(): Promise<void> {
    if (this.ended) return;
    this.ended = true;
    this.open = false;
    try {
      await this.sock?.end(undefined);
    } catch {
      /* already closed */
    }
    this.sock = null;
  }
}

/** The factory the worker hands to the manager for real WhatsApp connections. */
export function createBaileysTransportFactory(load: BaileysLoader = loadBaileys, log: (line: string) => void = (l) => console.warn(`[whatsapp-web] ${l}`)): WhatsAppWebTransportFactory {
  return () => new BaileysTransport(load, log);
}
