import { createHash } from "node:crypto";
import {
  WhatsAppWebTransportError,
  type WhatsAppAuthStore,
  type WhatsAppWebCloseInfo,
  type WhatsAppWebOpenInfo,
  type WhatsAppWebDeliveryStatus,
  type WhatsAppWebTransport,
  type WhatsAppWebTransportEvents,
  type WhatsAppWebTransportFactory,
} from "./transport";

/**
 * A scriptable stand-in for WhatsApp, for tests AND for local development (WHATSAPP_QR_FAKE=true, never in production, see
 * lib/whatsapp-web/config.ts). Nothing reaches the network.
 *
 * Default behaviour, which is what local development sees: `connect` emits a made-up QR string (a new one every 20 s), then
 * "connects" `connectAfterMs` later (12 s) as a made-up number and remembers that in the auth store, so a restart "restores" the
 * link at once. Messages are logged, not sent.
 *
 * For tests every step can be driven by hand (`emitQr`, `emitOpen`, `emitClose`, `emitDelivery`) and every answer scripted
 * (`exists`, `failSendWith`). `autoConnect: false` turns the automatic QR and connect off.
 */

export interface FakeTransportOptions {
  /** Time from the first QR to "connected". Default 12 000 ms. */
  connectAfterMs?: number;
  /** Time between QR codes. Default 20 000 ms. */
  qrEveryMs?: number;
  /** Do the QR and connect steps by themselves (default true). Tests that script them turn this off. */
  autoConnect?: boolean;
  phoneE164?: string;
  /** Where "sent" messages are logged. Default console.log. Pass a no-op in tests. */
  log?: (line: string) => void;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export interface FakeSentMessage {
  to: string;
  text: string;
  providerMessageId: string;
}

export const FAKE_CREDS = { fake: true, registered: true } as const;

/** A made-up but stable number for an influencer: +91 99999 xxxxx. */
export function fakePhoneFor(influencerId: string): string {
  const digits = createHash("sha256").update(influencerId).digest().readUInt32BE(0) % 100_000;
  return `+9199999${String(digits).padStart(5, "0")}`;
}

export class FakeTransport implements WhatsAppWebTransport {
  readonly sent: FakeSentMessage[] = [];
  readonly existsChecks: string[] = [];
  readonly calls: string[] = [];
  qrCount = 0;
  ended = false;
  loggedOut = false;
  /** Answer of numberExists. Default: every number exists. May throw or reject to script a failure. */
  exists: (e164: string) => boolean | Promise<boolean> = () => true;
  /** When set, the next sendText calls reject with it (one per entry, then normal again). */
  private sendFailures: Error[] = [];
  private events: WhatsAppWebTransportEvents | null = null;
  private auth: WhatsAppAuthStore | null = null;
  private timers: unknown[] = [];
  private seq = 0;

  private readonly connectAfterMs: number;
  private readonly qrEveryMs: number;
  private readonly autoConnect: boolean;
  private readonly phone: string;
  private readonly log: (line: string) => void;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;

  constructor(
    private readonly influencerId: string,
    opts: FakeTransportOptions = {},
  ) {
    this.connectAfterMs = opts.connectAfterMs ?? 12_000;
    this.qrEveryMs = opts.qrEveryMs ?? 20_000;
    this.autoConnect = opts.autoConnect ?? true;
    this.phone = opts.phoneE164 ?? fakePhoneFor(influencerId);
    this.log = opts.log ?? ((line) => console.log(line));
    this.setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = opts.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  }

  async connect(auth: WhatsAppAuthStore, events: WhatsAppWebTransportEvents): Promise<void> {
    this.calls.push("connect");
    this.auth = auth;
    this.events = events;
    if (!this.autoConnect) return;
    if ((auth.getCreds() as { registered?: boolean } | undefined)?.registered) {
      // A link that was made before: "restore" it shortly, without a QR code.
      this.later(() => this.emitOpen({ phoneE164: this.phone, deviceLabel: "Simulator" }), 50);
      return;
    }
    this.emitQr(`fake-qr:${this.influencerId}:${++this.qrCount}`);
    this.scheduleNextQr();
    this.later(() => {
      this.auth?.setCreds({ ...FAKE_CREDS, me: { id: this.phone } });
      this.emitOpen({ phoneE164: this.phone, deviceLabel: "Simulator" });
    }, this.connectAfterMs);
  }

  private scheduleNextQr(): void {
    this.later(() => {
      if (this.ended || this.opened) return;
      this.emitQr(`fake-qr:${this.influencerId}:${++this.qrCount}`);
      this.scheduleNextQr();
    }, this.qrEveryMs);
  }

  private opened = false;

  private later(fn: () => void, ms: number): void {
    this.timers.push(this.setTimer(() => !this.ended && fn(), ms));
  }

  // ---- scripting (tests) -------------------------------------------------------------------------------------------
  emitQr(qr: string): void {
    this.events?.onQr(qr);
  }
  emitOpen(info: WhatsAppWebOpenInfo = { phoneE164: this.phone, deviceLabel: "Simulator" }): void {
    this.opened = true;
    this.events?.onOpen(info);
  }
  emitClose(info: WhatsAppWebCloseInfo): void {
    this.opened = false;
    this.events?.onClose(info);
  }
  emitDelivery(providerMessageId: string, status: WhatsAppWebDeliveryStatus): void {
    this.events?.onDelivery({ providerMessageId, status });
  }
  failSendWith(...errors: Error[]): void {
    this.sendFailures.push(...errors);
  }

  // ---- WhatsAppWebTransport ----------------------------------------------------------------------------------------
  async sendText(toE164: string, text: string): Promise<{ providerMessageId: string }> {
    this.calls.push("sendText");
    if (this.ended || !this.opened) throw new WhatsAppWebTransportError("not connected", "not-connected", true);
    const failure = this.sendFailures.shift();
    if (failure) throw failure;
    const providerMessageId = `FAKE-${this.influencerId.slice(-6)}-${++this.seq}`;
    this.sent.push({ to: toE164, text, providerMessageId });
    this.log(`[whatsapp-web:fake] would send to ${toE164}: ${text}`);
    return { providerMessageId };
  }

  async numberExists(e164: string): Promise<boolean> {
    this.calls.push("numberExists");
    this.existsChecks.push(e164);
    return this.exists(e164);
  }

  async logout(): Promise<void> {
    this.calls.push("logout");
    this.loggedOut = true;
    this.auth?.clearKeys();
    await this.end();
  }

  async end(): Promise<void> {
    this.calls.push("end");
    this.ended = true;
    this.opened = false;
    for (const t of this.timers) this.clearTimer(t);
    this.timers = [];
  }
}

/** The factory the manager uses for WHATSAPP_QR_FAKE=true. */
export const fakeTransportFactory: WhatsAppWebTransportFactory = ({ influencerId }) => new FakeTransport(influencerId);
