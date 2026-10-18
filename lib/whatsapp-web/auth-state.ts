import { decryptSecret, encryptSecret } from "../crypto";
import type { WhatsAppAuthStore } from "./transport";

/**
 * The login of a linked WhatsApp device (credentials + Signal keys), kept as ONE encrypted JSON blob per influencer.
 *
 * - Encrypted with lib/crypto.ts (AES-256-GCM, TOKEN_ENCRYPTION_KEY) and bound to the influencer by the AAD `wa-web:<influencerId>`
 *   (`waWebAad`), so a blob copied onto another influencer's row does not decrypt. The column is listed for key rotation in
 *   lib/key-rotation-db.ts, which imports `waWebAad` from here.
 * - Never returned by any API, never logged, deleted on disconnect, logout, kill switch and (FK cascade) account deletion.
 * - Works from memory: the transport reads and writes the in-memory copy synchronously, and writes to the database are COALESCED
 *   (one write about a second after the last change, never two in flight, a final flush on close). Library-neutral: this module
 *   imports nothing of Baileys. Buffers are written the way Baileys' own BufferJSON writes them (`{type:"Buffer",data:base64}`),
 *   so a blob stays readable by that library's own tooling.
 */

export const waWebAad = (influencerId: string) => `wa-web:${influencerId}`;

/** How long writes are collected before one is made. */
export const AUTH_FLUSH_DELAY_MS = 1_000;

const FORMAT = 1;

interface Blob {
  v: number;
  creds?: unknown;
  keys: Record<string, Record<string, unknown>>;
}

/** JSON.stringify replacer for the Buffers and Uint8Arrays a Signal store holds. */
export function authReplacer(_key: string, value: unknown): unknown {
  const v = value as { type?: string; data?: unknown } | null;
  if (Buffer.isBuffer(value) || value instanceof Uint8Array || v?.type === "Buffer") {
    return { type: "Buffer", data: Buffer.from((v?.data as never) || (value as never)).toString("base64") };
  }
  return value;
}

/** JSON.parse reviver: the inverse of `authReplacer`. */
export function authReviver(_key: string, value: unknown): unknown {
  const v = value as { type?: string; data?: unknown } | null;
  if (typeof value === "object" && v !== null && v.type === "Buffer" && typeof v.data === "string") return Buffer.from(v.data, "base64");
  return value;
}

export function serializeAuthBlob(blob: Blob): string {
  return JSON.stringify(blob, authReplacer);
}

export function parseAuthBlob(json: string): Blob {
  const parsed = JSON.parse(json, authReviver) as Blob;
  if (!parsed || typeof parsed !== "object" || parsed.v !== FORMAT || typeof parsed.keys !== "object" || parsed.keys === null) {
    throw new Error("Unrecognised WhatsApp login format");
  }
  return parsed;
}

/** Encrypts a blob for one influencer. */
export function sealAuthBlob(influencerId: string, blob: Blob): string {
  return encryptSecret(serializeAuthBlob(blob), waWebAad(influencerId));
}

/** Decrypts a stored blob. Throws if it was sealed for another influencer, with another key, or is damaged. */
export function openAuthBlob(influencerId: string, sealed: string): Blob {
  return parseAuthBlob(decryptSecret(sealed, waWebAad(influencerId)));
}

/** Where the sealed text lives (Postgres in production, memory in tests). */
export interface AuthBlobStorage {
  load(): Promise<string | null>;
  save(sealed: string): Promise<void>;
  clear(): Promise<void>;
}

export interface EncryptedAuthStateOptions {
  influencerId: string;
  storage: AuthBlobStorage;
  /** Test hooks. */
  delayMs?: number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  /** A failed save is reported here (never with the blob). The state stays dirty and the next change or flush tries again. */
  onSaveError?: (error: unknown) => void;
}

/**
 * The auth store handed to a transport. Create it with `EncryptedAuthState.open()` (loads and decrypts what is stored).
 * After `dispose()` (wipe or close) every write is ignored, so a socket that is still shutting down cannot bring back a login
 * that was just deleted.
 */
export class EncryptedAuthState implements WhatsAppAuthStore {
  private blob: Blob;
  private dirty = false;
  private timer: unknown = null;
  private writing: Promise<void> | null = null;
  private disposed = false;
  private readonly delayMs: number;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;

  private constructor(
    private readonly opts: EncryptedAuthStateOptions,
    blob: Blob,
  ) {
    this.blob = blob;
    this.delayMs = opts.delayMs ?? AUTH_FLUSH_DELAY_MS;
    this.setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = opts.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  }

  /** Loads the stored login, or starts empty when there is none. A stored login that cannot be decrypted is an error. */
  static async open(opts: EncryptedAuthStateOptions): Promise<EncryptedAuthState> {
    const sealed = await opts.storage.load();
    const blob = sealed ? openAuthBlob(opts.influencerId, sealed) : { v: FORMAT, keys: {} };
    return new EncryptedAuthState(opts, blob);
  }

  /** True once credentials exist (a device was linked, or a link is in progress). */
  get hasCreds(): boolean {
    return this.blob.creds !== undefined;
  }

  get isDisposed(): boolean {
    return this.disposed;
  }

  getCreds(): unknown | undefined {
    return this.blob.creds;
  }

  setCreds(creds: unknown): void {
    if (this.disposed) return;
    this.blob.creds = creds;
    this.markDirty();
  }

  getKeys(type: string, ids: string[]): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    const bucket = this.blob.keys[type];
    for (const id of ids) out[id] = bucket && Object.prototype.hasOwnProperty.call(bucket, id) ? bucket[id] : undefined;
    return out;
  }

  setKeys(data: Record<string, Record<string, unknown | null>>): void {
    if (this.disposed) return;
    for (const [type, entries] of Object.entries(data)) {
      for (const [id, value] of Object.entries(entries)) {
        if (value === null || value === undefined) {
          if (this.blob.keys[type]) delete this.blob.keys[type][id];
        } else {
          (this.blob.keys[type] ??= {})[id] = value;
        }
      }
    }
    this.markDirty();
  }

  clearKeys(): void {
    if (this.disposed) return;
    this.blob.keys = {};
    this.markDirty();
  }

  /**
   * Lets the manager (never the web process: the login has ONE writer) remove entries from the key tables in place, for example a
   * customer's contact keys (lib/whatsapp-web/prune.ts). `change` returns how many entries it removed; a change goes through the same
   * coalesced write as the library's own. Returns that number.
   */
  mutateKeys(change: (keys: Record<string, Record<string, unknown>>) => number): number {
    if (this.disposed) return 0;
    const removed = change(this.blob.keys);
    if (removed > 0) this.markDirty();
    return removed;
  }

  private markDirty(): void {
    this.dirty = true;
    if (this.timer !== null) return; // coalesce: one pending write covers every change until it runs
    this.timer = this.setTimer(() => {
      this.timer = null;
      void this.flush();
    }, this.delayMs);
  }

  /** Writes now if anything changed. Resolves when the stored copy is current (or the write failed: see onSaveError). */
  async flush(): Promise<void> {
    if (this.timer !== null) {
      this.clearTimer(this.timer);
      this.timer = null;
    }
    // Never two writes in flight: wait for the running one, then write again if more changed meanwhile.
    while (this.writing) await this.writing;
    if (this.disposed || !this.dirty) return;
    this.dirty = false;
    const write = (async () => {
      try {
        await this.opts.storage.save(sealAuthBlob(this.opts.influencerId, this.blob));
      } catch (error) {
        this.dirty = true;
        this.opts.onSaveError?.(error);
        // Try again later even if nothing else changes (the database may only have blinked).
        if (!this.disposed && this.timer === null) {
          this.timer = this.setTimer(() => {
            this.timer = null;
            void this.flush();
          }, Math.max(this.delayMs, 5_000));
        }
      }
    })();
    this.writing = write;
    try {
      await write;
    } finally {
      this.writing = null;
    }
  }

  /** Stops accepting changes, cancels the pending write and removes the stored login. */
  async wipe(): Promise<void> {
    this.disposed = true;
    this.dirty = false;
    if (this.timer !== null) {
      this.clearTimer(this.timer);
      this.timer = null;
    }
    while (this.writing) await this.writing;
    this.blob = { v: FORMAT, keys: {} };
    await this.opts.storage.clear();
  }

  /**
   * Stops accepting changes and drops what is pending WITHOUT writing it, leaving the stored login as it is. For a worker that has
   * lost its lease on the linked numbers: another worker owns the login now, and a late write from here would overwrite its newer state.
   */
  abandon(): void {
    this.disposed = true;
    this.dirty = false;
    if (this.timer !== null) {
      this.clearTimer(this.timer);
      this.timer = null;
    }
  }

  /** Flushes what is pending, then stops accepting changes (the login stays stored). */
  async close(): Promise<void> {
    await this.flush();
    this.disposed = true;
  }
}
