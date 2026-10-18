import { MemoryKv } from "../../lib/whatsapp-web/kv";
import type { Clock } from "../../lib/whatsapp-web/send-queue";
import { QR_DEFAULTS, type WhatsAppQrConfig } from "../../lib/whatsapp-web/config";
import { FakeTransport } from "../../lib/whatsapp-web/fake-transport";
import type { AuthBlobStorage } from "../../lib/whatsapp-web/auth-state";
import type { SessionPatch, SessionRepo, SessionRow } from "../../lib/whatsapp-web/session-repo";
import { WhatsAppWebManager, type ManagerAlertKind, type ManagerDeps } from "../../worker/whatsapp-web-manager";

/** Lets every pending promise callback run (not timers that the test controls). */
export const settle = async (rounds = 20) => {
  for (let i = 0; i < rounds; i++) await new Promise((r) => setImmediate(r));
};

/** A clock the test moves by hand: sleeping resolves only when time is advanced past the wake-up. */
export class ManualClock implements Clock {
  private t: number;
  private sleepers: { at: number; resolve: () => void }[] = [];
  readonly slept: number[] = [];
  constructor(start = Date.UTC(2026, 10, 9, 10, 0, 0)) {
    this.t = start;
  }
  now = () => this.t;
  sleep = (ms: number) => {
    this.slept.push(ms);
    return new Promise<void>((resolve) => this.sleepers.push({ at: this.t + ms, resolve }));
  };
  /** Moves time forward, waking sleepers in order, letting the code between sleeps run. */
  async advance(ms: number) {
    const target = this.t + ms;
    await settle();
    for (;;) {
      this.sleepers.sort((a, b) => a.at - b.at);
      const next = this.sleepers[0];
      if (!next || next.at > target) break;
      this.sleepers.shift();
      this.t = Math.max(this.t, next.at);
      next.resolve();
      await settle();
    }
    this.t = target;
    await settle();
  }
  /** Runs until `p` settles, advancing time whenever something sleeps. */
  async run<T>(p: Promise<T>, maxMs = 3_600_000): Promise<T> {
    let done = false;
    let value!: T;
    let error: unknown;
    let failed = false;
    p.then(
      (v) => ((value = v), (done = true)),
      (e) => ((error = e), (failed = true), (done = true)),
    );
    let spent = 0;
    for (let i = 0; i < 10_000 && !done; i++) {
      await settle(5);
      if (done) break;
      this.sleepers.sort((a, b) => a.at - b.at);
      const next = this.sleepers.shift();
      if (!next) continue;
      spent += Math.max(0, next.at - this.t);
      if (spent > maxMs) throw new Error("clock ran away");
      this.t = Math.max(this.t, next.at);
      next.resolve();
    }
    if (!done) throw new Error("did not settle");
    if (failed) throw error;
    return value;
  }
}

export type MemoryRow = SessionRow & { authStateEnc: string | null };

export function newRow(influencerId: string, patch: Partial<MemoryRow> = {}): MemoryRow {
  const now = new Date(Date.UTC(2026, 10, 9, 9, 0, 0));
  return {
    influencerId,
    status: "NOT_LINKED",
    wantLinked: false,
    phoneE164: null,
    deviceLabel: null,
    consentAt: null,
    consentVersion: null,
    linkedAt: null,
    lastConnectedAt: null,
    lastErrorCode: null,
    lastErrorText: null,
    suspendedReason: null,
    consecutiveFailures: 0,
    sentTotal: 0,
    createdAt: now,
    updatedAt: now,
    authStateEnc: null,
    ...patch,
  };
}

/** The session table in memory, with the same interface as the Prisma one. */
export class MemoryRepo implements SessionRepo {
  readonly rows = new Map<string, MemoryRow>();
  updates: { influencerId: string; patch: SessionPatch }[] = [];
  add(row: MemoryRow) {
    this.rows.set(row.influencerId, row);
    return row;
  }
  row(id: string): MemoryRow {
    const r = this.rows.get(id);
    if (!r) throw new Error(`no row ${id}`);
    return r;
  }
  async listManageable() {
    return [...this.rows.values()]
      .filter((r) => r.wantLinked || ["PENDING_QR", "LINKED", "RECONNECTING", "SUSPENDED"].includes(r.status) || r.authStateEnc !== null)
      .map(({ authStateEnc, ...row }) => ({ ...row, hasLogin: authStateEnc !== null }))
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  }
  async get(id: string) {
    const r = this.rows.get(id);
    if (!r) return null;
    const { authStateEnc: _drop, ...row } = r;
    return { ...row };
  }
  async update(id: string, patch: SessionPatch) {
    this.updates.push({ influencerId: id, patch });
    const r = this.rows.get(id);
    if (r) Object.assign(r, patch);
  }
  async incrementSent(id: string) {
    const r = this.rows.get(id);
    if (r) r.sentTotal++;
  }
  authStorage(id: string): AuthBlobStorage {
    return {
      load: async () => this.rows.get(id)?.authStateEnc ?? null,
      save: async (sealed) => {
        const r = this.rows.get(id);
        if (r) r.authStateEnc = sealed;
      },
      clear: async () => {
        const r = this.rows.get(id);
        if (r) r.authStateEnc = null;
      },
    };
  }
}

export const testConfig = (patch: Partial<WhatsAppQrConfig> = {}): WhatsAppQrConfig => ({
  enabled: true,
  fake: true,
  maxSessions: QR_DEFAULTS.maxSessions,
  dailyCap: QR_DEFAULTS.dailyCap,
  minGapMs: QR_DEFAULTS.minGapMs,
  keepAuthWhenDisabled: false,
  ...patch,
});

/** A timer pair for the auth store: nothing fires until the test calls fire(). */
export function manualTimers() {
  let next = 1;
  const pending = new Map<number, () => void>();
  return {
    setTimer: (fn: () => void) => {
      const h = next++;
      pending.set(h, fn);
      return h;
    },
    clearTimer: (h: unknown) => void pending.delete(h as number),
    get pending() {
      return pending.size;
    },
    async fire() {
      const fns = [...pending.values()];
      pending.clear();
      for (const f of fns) f();
      await settle();
    },
  };
}

export interface Harness {
  clock: ManualClock;
  kv: MemoryKv;
  repo: MemoryRepo;
  config: WhatsAppQrConfig;
  manager: WhatsAppWebManager;
  /** Every transport the manager created, oldest first. */
  transports: FakeTransport[];
  alerts: { influencerId: string; kind: ManagerAlertKind; detail: string }[];
  deliveries: { influencerId: string; providerMessageId: string; status: string }[];
  logs: string[];
  authTimers: ReturnType<typeof manualTimers>;
  guardAnswer: { allow: boolean };
  guardCalls: { influencerId: string; bookingId: string; toE164: string }[];
  /** The next N transports refuse to start (connect() throws). */
  failConnects: { n: number };
  /** The transport most recently created for an influencer. */
  last(influencerId: string): FakeTransport;
  /** One reconcile pass, then let everything settle. */
  tick(): Promise<void>;
  /** Builds a second manager over the same database and Redis, as a restarted worker would. */
  restart(): Harness;
}

export function harness(opts: { config?: Partial<WhatsAppQrConfig>; repo?: MemoryRepo; kv?: MemoryKv; clock?: ManualClock; guard?: (influencerId: string, bookingId: string, toE164: string) => boolean } = {}): Harness {
  const clock = opts.clock ?? new ManualClock();
  const kv = opts.kv ?? new MemoryKv(clock.now);
  const repo = opts.repo ?? new MemoryRepo();
  const config = testConfig(opts.config);
  const transports: FakeTransport[] = [];
  const alerts: Harness["alerts"] = [];
  const deliveries: Harness["deliveries"] = [];
  const logs: string[] = [];
  const authTimers = manualTimers();
  const guardAnswer = { allow: true };
  const guardCalls: Harness["guardCalls"] = [];
  const failConnects = { n: 0 };
  const deps: ManagerDeps = {
    config: () => config,
    repo,
    kv,
    clock,
    transportFactory: ({ influencerId }) => {
      const t = new FakeTransport(influencerId, { autoConnect: false, log: () => {} });
      transports.push(t);
      if (failConnects.n > 0) {
        failConnects.n--;
        t.connect = async () => {
          throw new Error("cannot start");
        };
      }
      return t;
    },
    guard: async (influencerId, req) => {
      guardCalls.push({ influencerId, bookingId: req.bookingId, toE164: req.toE164 });
      return opts.guard ? opts.guard(influencerId, req.bookingId, req.toE164) : guardAnswer.allow;
    },
    notify: async (influencerId, kind, detail) => void alerts.push({ influencerId, kind, detail }),
    onDelivery: (influencerId, info) => void deliveries.push({ influencerId, ...info }),
    log: (line) => void logs.push(line),
    authDelayMs: 1_000,
    authSetTimer: authTimers.setTimer,
    authClearTimer: authTimers.clearTimer,
  };
  const manager = new WhatsAppWebManager(deps);
  const h: Harness = {
    clock,
    kv,
    repo,
    config,
    manager,
    transports,
    alerts,
    deliveries,
    logs,
    authTimers,
    guardAnswer,
    guardCalls,
    failConnects,
    last(influencerId) {
      const found = [...transports].reverse().find((t) => (t as unknown as { influencerId: string }).influencerId === influencerId);
      if (!found) throw new Error(`no transport for ${influencerId}`);
      return found;
    },
    async tick() {
      await manager.reconcile();
      await settle();
    },
    restart() {
      return harness({ ...opts, repo, kv, clock, config: { ...config } });
    },
  };
  return h;
}

/** Marks a session as wanted, as the dashboard's "start" does. */
export function want(h: Harness, influencerId: string, patch: Partial<MemoryRow> = {}) {
  return h.repo.add(newRow(influencerId, { wantLinked: true, consentAt: new Date(h.clock.now()), consentVersion: "v-test", ...patch }));
}
