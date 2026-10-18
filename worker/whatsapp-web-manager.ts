import { randomBytes } from "node:crypto";
import { EncryptedAuthState, type AuthBlobStorage } from "../lib/whatsapp-web/auth-state";
import type { WhatsAppQrConfig } from "../lib/whatsapp-web/config";
import { kvKeys, QR_FIRST_LIFE_MS, QR_ROTATE_MS, QR_TTL_MS, type EphemeralKv } from "../lib/whatsapp-web/kv";
import { jidUser, pruneAllExcept, pruneContacts } from "../lib/whatsapp-web/prune";
import { parsePruneRequests } from "../lib/whatsapp-web/prune-requests";
import { realClock, SendQueue, type Clock, type GuardAnswer, type QueuedSend } from "../lib/whatsapp-web/send-queue";
import { SELF_TEST_BOOKING_ID, type WhatsAppWebSendRequest, type WhatsAppWebSendResult } from "../lib/whatsapp-web/send";
import type { SessionRepo, SessionRow } from "../lib/whatsapp-web/session-repo";
import type {
  WhatsAppWebCloseInfo,
  WhatsAppWebDeliveryStatus,
  WhatsAppWebOpenInfo,
  WhatsAppWebTransport,
  WhatsAppWebTransportFactory,
} from "../lib/whatsapp-web/transport";

/**
 * Keeps the QR-linked WhatsApp sockets alive. It runs inside the ONE worker process (worker/index.ts) and is the only thing that
 * ever opens a connection to WhatsApp: web instances only set `wantLinked` and read the status and the QR code.
 *
 * Every 2 s `reconcile()` makes the world match the database:
 *  - a session that is wanted gets exactly one live transport (at most `maxSessions`; the rest stay NOT_LINKED with an explanation);
 *  - a transient close reconnects with exponential backoff (2 s, 4 s, ... capped at 5 min); the phone logging the device out
 *    wipes the stored login and marks LOGGED_OUT; WhatsApp refusing the number marks SUSPENDED;
 *  - a session that is no longer wanted is unlinked on the phone's side (logout), its login wiped, and marked NOT_LINKED;
 *  - turning the platform switch off disconnects everything and (unless told to keep them) deletes every stored login;
 *  - a linking attempt that nobody scans within 5 minutes is cancelled, so a forgotten page does not keep asking WhatsApp for codes.
 * LINKED sessions are restored when the worker starts (RECONNECTING until the socket is open). On SIGTERM the stored logins are
 * flushed and the sockets closed.
 *
 * The current QR payload is published to the shared store for 60 s (never to Postgres, never to a log). Incoming messages do not
 * exist for this class: the transport interface has no event for them.
 *
 * Everything outside (database, Redis, clock, transport, booking check, alerts) is injected, so the tests run it in-process
 * against fakes. `createManager()` at the bottom of the file builds the real one.
 */

export const RECONCILE_EVERY_MS = 2_000;
export const BACKOFF_BASE_MS = 2_000;
export const BACKOFF_CAP_MS = 5 * 60_000;
/** After another session took over this login we wait at least this long before trying again, so two never fight. */
export const REPLACED_MIN_BACKOFF_MS = 60_000;
export const PAIRING_WINDOW_MS = 5 * 60_000;
/**
 * How long the lease that lets ONE worker hold the linked sockets lasts without being renewed. Two workers on the same login (a rolling
 * deploy that starts the new one first, a second `npm run worker`) would overwrite each other's saved login and end in a logout, so
 * before any socket is opened the manager takes this lease (SET NX PX in the shared store), renews it on every pass (2 s) and gives
 * it back on shutdown. A worker that does not hold it stays idle and says so once. A crashed holder is replaced once the lease runs out.
 */
export const LEASE_TTL_MS = 20_000;
/** How often the lease is renewed, on a timer of its own (not once per reconcile pass, which can take longer than the lease). */
export const LEASE_RENEW_EVERY_MS = 5_000;
/** How often a connected number looks for "forget this customer" requests, and how often it forgets every contact without a booking. */
export const PRUNE_REQUESTS_EVERY_MS = 10_000;
export const PRUNE_ALL_EVERY_MS = 6 * 60 * 60_000;
export const HEARTBEAT_TTL_MS = 15_000;
export const SHUTDOWN_BUDGET_MS = 8_000;
/**
 * How many worker jobs one linked number may hold at the same time. The message and reminder workers run a few jobs at once and each
 * send waits in the number's queue at a fixed gap; without a cap a group session's reminders would occupy every slot (other
 * influencers' messages included). A job beyond the cap is refused at once ("busy", retryable) and the message goes the next way.
 */
export const MAX_JOBS_PER_SESSION = 2;

export type ManagerAlertKind = "logged-out" | "suspended";

export interface ManagerDeps {
  /** Read on every reconcile, so a test can flip the platform switch. */
  config: () => WhatsAppQrConfig;
  repo: SessionRepo;
  kv: EphemeralKv;
  clock?: Clock;
  transportFactory: WhatsAppWebTransportFactory;
  /** A real booking of this influencer with this number? (lib/whatsapp-web/booking-guard.ts) */
  guard: (influencerId: string, req: QueuedSend) => Promise<GuardAnswer>;
  /** Tell the influencer something happened (an e-mail through the account-email path). Failures are logged, never thrown. */
  notify: (influencerId: string, kind: ManagerAlertKind, detail: string) => Promise<void>;
  /** The delivery state of a message this number sent. */
  onDelivery?: (influencerId: string, info: { providerMessageId: string; status: WhatsAppWebDeliveryStatus }) => void;
  /** One line per notable event; never a QR payload, a login, a message text or a customer number. */
  log?: (line: string) => void;
  /** Longest wait for one call to the transport (default SEND_CALL_TIMEOUT_MS). Tests shorten it. */
  callTimeoutMs?: number;
  /** This worker's name in the lease. Default: a random one per manager. */
  workerId?: string;
  /**
   * The phone numbers (digits) of the customers who still have a non-erased booking with this influencer. Without it the periodic
   * clean-up of other contacts' keys in the stored login (lib/whatsapp-web/prune.ts) does not run; erase requests are still honoured.
   */
  keepContacts?: (influencerId: string) => Promise<Iterable<string>>;
  /** Test hooks for the auth store's write coalescing. */
  authDelayMs?: number;
  authSetTimer?: (fn: () => void, ms: number) => unknown;
  authClearTimer?: (handle: unknown) => void;
}

type Phase = "connecting" | "open" | "backoff" | "stopping";

interface Live {
  influencerId: string;
  generation: number;
  transport: WhatsAppWebTransport | null;
  auth: EncryptedAuthState;
  queue: SendQueue;
  phase: Phase;
  /** This process saw the socket open (so an unlink on the phone's side is possible and makes sense). */
  openedOnce: boolean;
  /** The link existed before this socket started (a restored or resumed login), as opposed to a first scan. */
  hadLogin: boolean;
  attempts: number;
  reconnectAt: number | null;
  pairingDeadline: number | null;
  linkedAt: Date | null;
  /** The number linked on this device (from the database, then from the open socket). */
  phoneE164: string | null;
  statusKnown: SessionRow["status"];
  /** Jobs inside `send()` right now (see MAX_JOBS_PER_SESSION). */
  activeSends: number;
  /** QR codes this connection has produced so far (the first lives 60 s, the next ones about 20 s). */
  qrCount: number;
  nextPruneRequestsAt: number;
  nextPruneAllAt: number;
  /** Database writes and event handlers of one session run one after the other. */
  chain: Promise<void>;
}

const ok = (): void => {};

export class WhatsAppWebManager {
  private readonly lives = new Map<string, Live>();
  private readonly clock: Clock;
  private readonly log: (line: string) => void;
  private timer: ReturnType<typeof setInterval> | null = null;
  private leaseTimer: ReturnType<typeof setInterval> | null = null;
  private reconciling: Promise<void> | null = null;
  private closed = false;
  private readonly workerId: string;
  private holdsLease = false;
  private leaseRenewedAt = 0;
  private idleLogged = false;

  constructor(private readonly d: ManagerDeps) {
    this.workerId = d.workerId ?? `worker-${randomBytes(8).toString("hex")}`;
    this.clock = d.clock ?? realClock;
    this.log = d.log ?? ((line) => console.log(`[whatsapp-web] ${line}`));
  }

  // ---- lifecycle -----------------------------------------------------------------------------------------------------------

  /** Starts the 2-second loop (the first pass runs at once). */
  start(): void {
    if (this.timer || this.closed) return;
    const tick = () => void this.reconcile().catch((e) => this.log(`reconcile failed: ${errorName(e)}`));
    tick();
    this.timer = setInterval(tick, RECONCILE_EVERY_MS);
    this.leaseTimer = setInterval(() => void this.maintainLease().catch((e) => this.log(`lease renewal failed: ${errorName(e)}`)), LEASE_RENEW_EVERY_MS);
  }

  /** Stops the loop, flushes every stored login and closes every socket. The sessions stay as they are in the database. */
  async shutdown(): Promise<void> {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.leaseTimer) clearInterval(this.leaseTimer);
    this.leaseTimer = null;
    if (this.reconciling) await this.reconciling.catch(ok);
    const work = Promise.all(
      [...this.lives.values()].map(async (live) => {
        live.phase = "stopping";
        live.queue.stop();
        await live.chain.catch(ok);
        await live.auth.close().catch(ok);
        await live.transport?.end().catch(ok);
      }),
    );
    await Promise.race([work, this.clock.sleep(SHUTDOWN_BUDGET_MS)]);
    this.lives.clear();
    // Last: another worker may take the numbers over from here.
    if (this.holdsLease) {
      this.holdsLease = false;
      await this.d.kv.delIfEquals(kvKeys.lease, this.workerId).catch(ok);
    }
  }

  /** True while this worker is the one that may hold the sockets. */
  get leaseHeld(): boolean {
    return this.holdsLease;
  }

  // ---- what the rest of the worker asks ------------------------------------------------------------------------------------

  /** Numbers whose socket is open right now. */
  get openCount(): number {
    return [...this.lives.values()].filter((l) => l.phase === "open").length;
  }

  /** True when a message for this influencer could go out through their linked number right now. */
  isReady(influencerId: string): boolean {
    const live = this.lives.get(influencerId);
    return Boolean(live && live.phase === "open" && !live.queue.tripped && this.d.config().enabled && this.leaseValid());
  }

  /** Queues one booking message on the influencer's linked number. Never throws. */
  async send(req: WhatsAppWebSendRequest): Promise<WhatsAppWebSendResult> {
    if (!this.d.config().enabled) return { ok: false, reason: "qr-disabled", retryable: false };
    const live = this.lives.get(req.influencerId);
    if (!live || live.phase === "stopping") return { ok: false, reason: "not-linked", retryable: false };
    if (live.queue.tripped) return { ok: false, reason: "circuit-open", retryable: false };
    // A worker that cannot show a valid lease must not send: another worker may own this login by now.
    if (live.phase !== "open" || !this.leaseValid()) return { ok: false, reason: "not-connected", retryable: true };
    if (live.activeSends >= MAX_JOBS_PER_SESSION) return { ok: false, reason: "busy", retryable: true };
    live.activeSends += 1;
    try {
      return await live.queue.enqueue({ toE164: req.toE164, text: req.text, bookingId: req.bookingId, key: req.key, kind: req.kind, deadlineAtMs: req.deadlineAtMs });
    } finally {
      live.activeSends -= 1;
    }
  }

  // ---- the reconcile loop --------------------------------------------------------------------------------------------------

  /** One pass. Passes never overlap: a call while one runs waits for it and returns. */
  reconcile(): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (this.reconciling) return this.reconciling;
    const run = this.pass().finally(() => {
      this.reconciling = null;
    });
    this.reconciling = run;
    return run;
  }

  /**
   * The lease is valid while it was renewed (or taken) less than LEASE_TTL_MS ago. The time is that of the START of the successful call,
   * so a slow answer never makes it look younger than it is. Sends and login saves require it (see `send` and `guardedStorage`).
   */
  private leaseValid(): boolean {
    return this.holdsLease && this.clock.now() - this.leaseRenewedAt < LEASE_TTL_MS;
  }

  /** Renewed recently enough to start anything new (a store that stops answering lets running sockets live a while, but starts nothing). */
  private leaseFresh(): boolean {
    return this.holdsLease && this.clock.now() - this.leaseRenewedAt < 2 * LEASE_RENEW_EVERY_MS;
  }

  private leaseOp: Promise<void> | null = null;

  /**
   * Renews the lease. Runs on its own timer every LEASE_RENEW_EVERY_MS (independent of the reconcile pass, which can take longer than the
   * lease: every logout waits up to 10 s and the rows are handled one after another) and at the start of each pass. If it cannot be
   * renewed because another worker has it, every socket is closed at once WITHOUT writing the login (the new owner has the newer state).
   * If it ran out but nobody took it, it is taken back and nothing else changes. A store that does not answer changes nothing until
   * the lease would have run out, then the sockets are closed. Calls never overlap.
   */
  maintainLease(): Promise<void> {
    if (!this.holdsLease) return Promise.resolve();
    if (this.leaseOp) return this.leaseOp;
    const op = this.renewLease().finally(() => {
      this.leaseOp = null;
    });
    this.leaseOp = op;
    return op;
  }

  private async renewLease(): Promise<void> {
    const startedAt = this.clock.now();
    try {
      if (await this.d.kv.renew(kvKeys.lease, this.workerId, LEASE_TTL_MS)) {
        this.leaseRenewedAt = startedAt;
        return;
      }
      // Not renewed: it ran out (this process was stalled for longer than the lease) or another worker took it. If nobody did, take it
      // straight back and carry on; if somebody did, close every socket now.
      if (await this.d.kv.setNx(kvKeys.lease, this.workerId, LEASE_TTL_MS)) {
        this.leaseRenewedAt = startedAt;
        this.log("the lease on the linked numbers had run out; nobody else had taken it, holding it again");
        return;
      }
      await this.loseLease("the lease on the linked numbers was lost to another worker; closing every socket");
    } catch {
      if (this.clock.now() - this.leaseRenewedAt >= LEASE_TTL_MS) await this.loseLease("the lease could not be renewed in time; closing every socket");
    }
  }

  private async loseLease(why: string): Promise<void> {
    if (!this.holdsLease) return;
    this.holdsLease = false;
    this.log(why);
    await this.abandonAll();
  }

  /** Takes the lease when nobody holds it. False means "stay idle this pass" (logged once). */
  private async acquireLease(): Promise<boolean> {
    const startedAt = this.clock.now();
    try {
      if (await this.d.kv.setNx(kvKeys.lease, this.workerId, LEASE_TTL_MS)) {
        this.holdsLease = true;
        this.leaseRenewedAt = startedAt;
        this.idleLogged = false;
        this.log("holding the lease on the linked numbers");
        return true;
      }
      if (!this.idleLogged) {
        this.idleLogged = true;
        this.log("another worker holds the lease on the linked numbers; staying idle");
      }
    } catch {
      /* the store does not answer: no lease, no socket */
    }
    return false;
  }

  /** The stored login, with writes that need a valid lease: without it the write is skipped and the sockets are closed. */
  private guardedStorage(influencerId: string): AuthBlobStorage {
    const inner = this.d.repo.authStorage(influencerId);
    return {
      load: () => inner.load(),
      clear: () => inner.clear(),
      save: async (sealed) => {
        if (!this.leaseValid()) {
          void this.loseLease("a login save was refused because the lease is no longer valid; closing every socket");
          return; // skipped: whoever holds the numbers now has the newer login
        }
        await inner.save(sealed);
      },
    };
  }

  /** Closes every socket without touching the stored logins or the sessions' status (another worker takes them over). */
  private async abandonAll(): Promise<void> {
    for (const live of [...this.lives.values()]) {
      live.phase = "stopping";
      live.generation++;
      live.queue.stop();
      live.auth.abandon();
      await live.transport?.end().catch(ok);
      live.transport = null;
      this.lives.delete(live.influencerId);
    }
  }

  private async pass(): Promise<void> {
    const cfg = this.d.config();
    if (cfg.enabled) {
      if (this.holdsLease) await this.maintainLease();
      if (!this.holdsLease && !(await this.acquireLease())) return;
    } else if (this.holdsLease) {
      this.holdsLease = false;
      await this.d.kv.delIfEquals(kvKeys.lease, this.workerId).catch(ok);
    }
    const rows = await this.d.repo.listManageable();
    const byId = new Map(rows.map((r) => [r.influencerId, r]));
    // The heartbeat tells the web app that a manager is looking after the sessions (otherwise it says the worker is not running).
    if (cfg.enabled) await this.d.kv.set("wa-web:manager:alive", String(this.clock.now()), HEARTBEAT_TTL_MS).catch(ok);
    else await this.d.kv.del("wa-web:manager:alive").catch(ok);

    // Sockets whose row is gone (the influencer was deleted): close them, there is nothing left to update.
    for (const live of [...this.lives.values()]) {
      // (An influencer who was deleted: the device is unlinked on the phone too where the socket is open, so it does not stay in
      // the phone's "Linked devices" list with nobody able to remove it.)
      if (!byId.has(live.influencerId)) await this.teardown(live, { logout: live.openedOnce, wipe: true, status: null });
    }

    if (!cfg.enabled) {
      await this.disableAll(rows, cfg);
      return;
    }

    // Sessions that already had a login come first, so a full house never turns an established number away for a new one.
    const ordered = [...rows].sort((a, b) => Number(Boolean(b.linkedAt)) - Number(Boolean(a.linkedAt)));
    for (const row of ordered) {
      try {
        await this.reconcileRow(row, cfg);
      } catch (e) {
        this.log(`session ${row.influencerId}: ${errorName(e)}`);
      }
    }
  }

  private async reconcileRow(row: SessionRow, cfg: WhatsAppQrConfig): Promise<void> {
    const live = this.lives.get(row.influencerId);

    if (!row.wantLinked) {
      if (live) await this.teardown(live, { logout: live.openedOnce, wipe: true, status: "NOT_LINKED" });
      else await this.wipeIdle(row);
      return;
    }

    if (row.status === "SUSPENDED" || row.status === "LOGGED_OUT") {
      // Stopped on purpose; only the influencer pressing "start" again (which resets the status) brings it back.
      if (live) await this.teardown(live, { logout: false, wipe: false, status: null });
      return;
    }

    if (!live) {
      if (this.lives.size >= cfg.maxSessions) {
        if (row.lastErrorCode !== "max-sessions" || row.status !== "NOT_LINKED") {
          await this.d.repo.update(row.influencerId, {
            status: "NOT_LINKED",
            lastErrorCode: "max-sessions",
            lastErrorText: "Too many numbers are linked on this platform right now. Try again later.",
          });
        }
        return;
      }
      if (!this.leaseFresh()) return; // the lease could not be confirmed a moment ago: start nothing new
      await this.startSession(row);
      return;
    }

    if (live.pairingDeadline !== null && this.clock.now() >= live.pairingDeadline) {
      this.log(`session ${row.influencerId}: the QR code was not scanned in time, link cancelled`);
      await this.teardown(live, {
        logout: false,
        wipe: true,
        status: "NOT_LINKED",
        extra: { wantLinked: false, lastErrorCode: "qr-expired", lastErrorText: "The QR code was not scanned in time. Start again to get a new one." },
      });
      return;
    }

    if (live.phase === "backoff" && live.reconnectAt !== null && this.clock.now() >= live.reconnectAt && this.leaseFresh()) {
      await this.connect(live);
    }
    await this.maintainContacts(live);
  }

  /**
   * Customers' contact keys in the stored login (they are named after the customer's phone number): drops the contacts of customers
   * who asked to be erased (requests published by lib/privacy.ts, taken here so the worker stays the only writer of the login), and
   * every PRUNE_ALL_EVERY_MS drops each contact that has no non-erased booking with this influencer. Never throws.
   */
  private async maintainContacts(live: Live): Promise<void> {
    if (live.phase === "stopping" || live.auth.isDisposed) return;
    const now = this.clock.now();
    const id = live.influencerId;
    try {
      if (now >= live.nextPruneRequestsAt) {
        live.nextPruneRequestsAt = now + PRUNE_REQUESTS_EVERY_MS;
        const phones = parsePruneRequests(await this.d.kv.drain(kvKeys.prune(id)));
        if (phones.length > 0) {
          const removed = live.auth.mutateLogin(({ keys, creds }) => pruneContacts(keys, phones, creds));
          this.log(`session ${id}: forgot ${removed} stored key(s) of ${phones.length} erased customer(s)`);
        }
      }
      if (this.d.keepContacts && now >= live.nextPruneAllAt && live.auth.hasCreds) {
        live.nextPruneAllAt = now + PRUNE_ALL_EVERY_MS;
        const keep = [...(await this.d.keepContacts(id))];
        const me = (live.auth.getCreds() as { me?: { id?: unknown; lid?: unknown } } | undefined)?.me;
        const own = [live.phoneE164, jidUser(me?.id), jidUser(me?.lid)].filter((v): v is string => typeof v === "string" && v !== "");
        const removed = live.auth.mutateLogin(({ keys, creds }) => pruneAllExcept(keys, [...keep, ...own], creds));
        if (removed > 0) this.log(`session ${id}: forgot ${removed} stored key(s) of contacts without a booking`);
      }
    } catch (e) {
      this.log(`session ${id}: contact clean-up failed (${errorName(e)})`);
    }
  }

  // ---- starting a session --------------------------------------------------------------------------------------------------

  private async startSession(row: SessionRow): Promise<void> {
    const id = row.influencerId;
    let auth: EncryptedAuthState;
    try {
      auth = await EncryptedAuthState.open({
        influencerId: id,
        storage: this.guardedStorage(id),
        delayMs: this.d.authDelayMs,
        setTimer: this.d.authSetTimer,
        clearTimer: this.d.authClearTimer,
        onSaveError: (e) => this.log(`session ${id}: could not save the login (${errorName(e)})`),
      });
    } catch (e) {
      // The stored login cannot be read (most likely the encryption key changed). Do not delete it: an operator may be able to
      // fix the key. Stop this number; the influencer can disconnect (which wipes) and link again.
      this.log(`session ${id}: the stored login cannot be decrypted (${errorName(e)})`);
      await this.d.repo.update(id, {
        status: "SUSPENDED",
        suspendedReason: "The stored WhatsApp login could not be read. Disconnect and link the number again.",
        lastErrorCode: "auth-unreadable",
        lastErrorText: "The stored WhatsApp login could not be read.",
      });
      await this.d.notify(id, "suspended", "The stored WhatsApp login could not be read. Disconnect and link the number again.").catch(ok);
      return;
    }

    const hadLogin = auth.hasCreds;
    const live: Live = {
      influencerId: id,
      generation: 0,
      transport: null,
      auth,
      phase: "connecting",
      openedOnce: false,
      hadLogin,
      attempts: 0,
      reconnectAt: null,
      pairingDeadline: hadLogin ? null : this.clock.now() + PAIRING_WINDOW_MS,
      linkedAt: row.linkedAt,
      phoneE164: row.phoneE164,
      statusKnown: row.status,
      activeSends: 0,
      qrCount: 0,
      nextPruneRequestsAt: 0,
      nextPruneAllAt: 0,
      chain: Promise.resolve(),
      queue: new SendQueue({
        influencerId: id,
        transport: () => (live.phase === "open" ? live.transport : null),
        kv: this.d.kv,
        clock: this.clock,
        minGapMs: this.d.config().minGapMs,
        dailyCap: this.d.config().dailyCap,
        initialFailures: row.consecutiveFailures,
        // A message must be about a real booking of this influencer with this number. The one exception is a test to their own
        // linked number (SELF_TEST_BOOKING_ID).
        guard: async (req) => (req.bookingId === SELF_TEST_BOOKING_ID ? live.phoneE164 !== null && req.toE164 === live.phoneE164 : this.d.guard(id, req)),
        onSent: () => this.d.repo.incrementSent(id),
        callTimeoutMs: this.d.callTimeoutMs,
        // Two sends in a row got no answer: reconnect, as if the connection had dropped.
        onStall: () => {
          this.log(`session ${id}: two sends in a row got no answer; reconnecting`);
          this.enqueueWork(live, () => this.handleClose(live, { reason: "transient", code: "send-stalled" }));
        },
        onFailureCount: (n) => this.enqueueWork(live, () => this.d.repo.update(id, { consecutiveFailures: n })),
        onTrip: (reason) =>
          this.enqueueWork(live, () =>
            this.suspend(live, "send-failures", "Sending from this number failed three times in a row, so it was paused. Messages go by the other channels.", reason),
          ),
        onError: (info) => this.log(`session ${id}: a send failed (${info.code})`),
      }),
    };
    this.lives.set(id, live);
    await this.maintainContacts(live); // before the socket exists: a restored login is cleaned first
    // A restored or resumed login shows as "reconnecting" until the socket is open; a first link shows "waiting for scan" once a code exists.
    if (hadLogin) await this.d.repo.update(id, { status: "RECONNECTING", lastErrorCode: null, lastErrorText: null });
    else await this.d.repo.update(id, { lastErrorCode: null, lastErrorText: null });
    live.statusKnown = hadLogin ? "RECONNECTING" : row.status;
    await this.connect(live);
  }

  /** Creates a fresh transport for a session and starts connecting. Events of an older transport are ignored. */
  private async connect(live: Live): Promise<void> {
    const old = live.transport;
    live.transport = null;
    if (old) await old.end().catch(ok);
    const gen = ++live.generation;
    live.phase = "connecting";
    live.qrCount = 0;
    live.reconnectAt = null;
    const current = () => gen === live.generation && live.phase !== "stopping";
    const transport = this.d.transportFactory({ influencerId: live.influencerId });
    live.transport = transport;
    try {
      await transport.connect(live.auth, {
        onQr: (qr) => current() && this.enqueueWork(live, () => this.handleQr(live, qr)),
        onOpen: (info) => current() && this.enqueueWork(live, () => this.handleOpen(live, info)),
        onClose: (info) => current() && this.enqueueWork(live, () => this.handleClose(live, info)),
        onDelivery: (info) => {
          if (current()) {
            try {
              this.d.onDelivery?.(live.influencerId, info);
            } catch {
              /* a bad handler must not break the connection */
            }
          }
        },
      });
    } catch (e) {
      if (current()) this.enqueueWork(live, () => this.handleClose(live, { reason: "transient", code: "connect-failed" }));
      this.log(`session ${live.influencerId}: connect failed (${errorName(e)})`);
    }
  }

  private enqueueWork(live: Live, work: () => Promise<void>): void {
    live.chain = live.chain.then(work).catch((e) => this.log(`session ${live.influencerId}: ${errorName(e)}`));
  }

  // ---- events from the transport -------------------------------------------------------------------------------------------

  private async handleQr(live: Live, qr: string): Promise<void> {
    if (live.phase === "stopping") return;
    const lifeMs = live.qrCount++ === 0 ? QR_FIRST_LIFE_MS : QR_ROTATE_MS;
    await this.d.kv.set(kvKeys.qr(live.influencerId), JSON.stringify({ qr, issuedAt: this.clock.now(), lifeMs }), QR_TTL_MS).catch((e) => this.log(`session ${live.influencerId}: could not publish the code (${errorName(e)})`));
    if (live.statusKnown !== "PENDING_QR") {
      live.statusKnown = "PENDING_QR";
      await this.d.repo.update(live.influencerId, { status: "PENDING_QR", lastErrorCode: null, lastErrorText: null });
    }
  }

  private async handleOpen(live: Live, info: WhatsAppWebOpenInfo): Promise<void> {
    if (live.phase === "stopping") return;
    const firstLink = !live.hadLogin && !live.openedOnce && live.statusKnown !== "LINKED";
    live.phase = "open";
    live.openedOnce = true;
    live.attempts = 0;
    live.reconnectAt = null;
    live.pairingDeadline = null;
    // Make sure the login is stored before we tell anyone the number is linked.
    await live.auth.flush();
    await this.d.kv.del(kvKeys.qr(live.influencerId)).catch(ok);
    const now = new Date(this.clock.now());
    if (firstLink || !live.linkedAt) live.linkedAt = now;
    live.phoneE164 = info.phoneE164;
    live.statusKnown = "LINKED";
    await this.d.repo.update(live.influencerId, {
      status: "LINKED",
      phoneE164: info.phoneE164,
      deviceLabel: info.deviceLabel,
      linkedAt: live.linkedAt,
      lastConnectedAt: now,
      lastErrorCode: null,
      lastErrorText: null,
    });
  }

  private async handleClose(live: Live, info: WhatsAppWebCloseInfo): Promise<void> {
    if (live.phase === "stopping") return;
    const dead = live.transport;
    live.transport = null;
    if (dead) await dead.end().catch(ok);

    if (info.reason === "logged-out") return this.loggedOut(live, info.code);
    if (info.reason === "restricted") {
      return this.suspend(live, "whatsapp-restricted", "WhatsApp is restricting this number, so sending from it was stopped. Messages go by the other channels.", info.code);
    }

    // Transient: reconnect. A restart WhatsApp asks for right after a scan is part of linking and is done at once.
    const immediate = info.code === "restart-required";
    if (!immediate) live.attempts += 1;
    let delay = immediate ? 0 : Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** (live.attempts - 1));
    if (info.code === "replaced") delay = Math.max(delay, REPLACED_MIN_BACKOFF_MS);
    live.phase = "backoff";
    live.reconnectAt = this.clock.now() + delay;
    if (live.statusKnown === "LINKED") {
      live.statusKnown = "RECONNECTING";
      await this.d.repo.update(live.influencerId, { status: "RECONNECTING", lastErrorCode: info.code, lastErrorText: "The connection to WhatsApp was lost. Reconnecting." });
    }
    this.log(`session ${live.influencerId}: connection closed (${info.code}), retry in ${Math.round(delay / 1000)} s`);
    if (immediate) await this.connect(live);
  }

  // ---- ending a session ----------------------------------------------------------------------------------------------------

  /** The phone removed this device: the login is useless, delete it, stop, and tell the influencer. */
  private async loggedOut(live: Live, code: string): Promise<void> {
    const wasLinked = live.openedOnce || live.hadLogin || live.statusKnown === "LINKED" || live.statusKnown === "RECONNECTING";
    await this.teardown(live, {
      inChain: true,
      logout: false,
      wipe: true,
      status: "LOGGED_OUT",
      extra: {
        wantLinked: false,
        lastErrorCode: "logged-out",
        lastErrorText: "WhatsApp logged this device out (it was removed from Linked devices, or WhatsApp ended the login). Link the number again to use it.",
      },
    });
    this.log(`session ${live.influencerId}: logged out (${code})`);
    if (wasLinked) await this.d.notify(live.influencerId, "logged-out", "WhatsApp logged out the linked device. Booking messages now go through your official WhatsApp connection, SMS or e-mail until you link the number again.").catch(ok);
  }

  /** Stops sending from this number and says why. The login stays stored so that the influencer can resume without a new scan. */
  private async suspend(live: Live, code: string, text: string, detail: string): Promise<void> {
    if (live.phase === "stopping") return;
    live.phase = "stopping";
    live.queue.stop();
    await live.auth.flush().catch(ok);
    await live.auth.close().catch(ok);
    await live.transport?.end().catch(ok);
    live.transport = null;
    this.lives.delete(live.influencerId);
    await this.d.kv.del(kvKeys.qr(live.influencerId)).catch(ok);
    await this.d.repo.update(live.influencerId, { status: "SUSPENDED", suspendedReason: text, lastErrorCode: code, lastErrorText: text });
    this.log(`session ${live.influencerId}: suspended (${code}: ${detail})`);
    await this.d.notify(live.influencerId, "suspended", text).catch(ok);
  }

  private async teardown(
    live: Live,
    how: { logout: boolean; wipe: boolean; status: SessionRow["status"] | null; extra?: Partial<Parameters<SessionRepo["update"]>[1]>; inChain?: boolean },
  ): Promise<void> {
    // Let what is already being written for this session finish first (unless we ARE that work).
    if (!how.inChain) await live.chain.catch(ok);
    live.phase = "stopping";
    live.generation++; // anything the old transport still says is ignored
    live.queue.stop();
    const transport = live.transport;
    live.transport = null;
    if (transport) {
      if (how.logout) await Promise.race([transport.logout().catch(ok), this.clock.sleep(10_000)]);
      await transport.end().catch(ok);
    }
    // A login that could not be deleted must not be reported as gone: the row keeps its status (so it is looked at again, and the delete
    // is retried) and only a logout by the phone is recorded anyway, because that session cannot be used.
    let wiped = true;
    if (how.wipe) {
      wiped = await live.auth.wipe().then(
        () => true,
        (e) => {
          this.log(`session ${live.influencerId}: could not delete the stored login (${errorName(e)}); will try again`);
          return false;
        },
      );
    } else await live.auth.close().catch(ok);
    this.lives.delete(live.influencerId);
    await this.d.kv.del(kvKeys.qr(live.influencerId)).catch(ok);
    if (how.status && (wiped || how.status === "LOGGED_OUT")) {
      await this.d.repo.update(live.influencerId, {
        status: how.status,
        ...(how.status === "NOT_LINKED" ? { phoneE164: null, deviceLabel: null, linkedAt: null, lastErrorCode: null, lastErrorText: null, suspendedReason: null, consecutiveFailures: 0 } : {}),
        ...(how.status === "LOGGED_OUT" ? { deviceLabel: null, suspendedReason: null, consecutiveFailures: 0 } : {}),
        ...how.extra,
      });
    }
  }

  /** A session that is not wanted and has no socket in this process, but still shows a link or holds a login: clean it up. */
  private async wipeIdle(row: SessionRow): Promise<void> {
    if ((row.status === "NOT_LINKED" || row.status === "LOGGED_OUT") && !row.wantLinked) {
      // Nothing to show or change; a login may still be stored from a delete that failed. Delete it (a failure is logged by the
      // caller and tried again on the next pass, because the row keeps being listed while a login is stored).
      if (row.hasLogin) await this.d.repo.authStorage(row.influencerId).clear();
      return;
    }
    await this.d.repo.authStorage(row.influencerId).clear();
    await this.d.kv.del(kvKeys.qr(row.influencerId)).catch(ok);
    await this.d.repo.update(row.influencerId, {
      status: "NOT_LINKED",
      phoneE164: null,
      deviceLabel: null,
      linkedAt: null,
      lastErrorCode: null,
      lastErrorText: null,
      suspendedReason: null,
      consecutiveFailures: 0,
    });
  }

  /** The platform switch is off: nothing may stay connected. Unless told to keep them, every stored login is deleted. */
  private async disableAll(rows: SessionRow[], cfg: WhatsAppQrConfig): Promise<void> {
    for (const live of [...this.lives.values()]) {
      await this.teardown(live, { logout: !cfg.keepAuthWhenDisabled && live.openedOnce, wipe: !cfg.keepAuthWhenDisabled, status: cfg.keepAuthWhenDisabled ? null : "NOT_LINKED", extra: cfg.keepAuthWhenDisabled ? undefined : { wantLinked: false } });
    }
    if (cfg.keepAuthWhenDisabled) return;
    for (const row of rows) {
      if (this.lives.has(row.influencerId)) continue;
      try {
        await this.d.repo.authStorage(row.influencerId).clear();
        await this.d.kv.del(kvKeys.qr(row.influencerId)).catch(ok);
        await this.d.repo.update(row.influencerId, {
          status: "NOT_LINKED",
          wantLinked: false,
          phoneE164: null,
          deviceLabel: null,
          linkedAt: null,
          lastErrorCode: null,
          lastErrorText: null,
          suspendedReason: null,
          consecutiveFailures: 0,
        });
      } catch (e) {
        this.log(`session ${row.influencerId}: ${errorName(e)}`);
      }
    }
  }
}

function errorName(e: unknown): string {
  return e instanceof Error ? e.name : "error";
}
