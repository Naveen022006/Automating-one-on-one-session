import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import path from "node:path";
import { GOOGLE_ACCOUNTS, seedMeta } from "./fixtures";

/**
 * The mock's whole world: the fake Google and Meta accounts and tokens, and what the demo made with them: calendar events, mail,
 * WhatsApp messages, SMS and the logs the inbox pages show. The credentials and accounts are fake, but the booking data is NOT:
 * customer names, email addresses, phone numbers and message bodies are whatever was typed into the demo's booking form. It is kept
 * in memory and written to one JSON file in a per-user directory of the OS temp directory (mode 0700, the file 0600; never inside
 * the repository), so a restart keeps what the app stored a token for; `--reset` deletes it. A token the app stored that is
 * unknown to the mock after a reset is answered like a revoked one, which shows the app's real reconnect states.
 */

export interface MockAccount {
  email: string;
  name: string;
  sub: string;
}

export interface PendingDecision {
  clientId: string;
  redirectUri: string;
  state: string;
  /** Every scope the app asked for (identity scopes included). */
  scopes: string[];
  accessType: string;
  /** include_granted_scopes=true: what an earlier grant of this account allowed is part of the new token (incremental consent). */
  includeGranted: boolean;
  loginHint: string | null;
  expiresAt: number;
}

export interface AuthCode {
  clientId: string;
  redirectUri: string;
  email: string;
  /** The scopes the user actually allowed (identity scopes included). */
  scopes: string[];
  offline: boolean;
  includeGranted: boolean;
  expiresAt: number;
  used: boolean;
}

export interface Grant {
  clientId: string;
  email: string;
  scopes: string[];
  createdAt: string;
  revokedAt: string | null;
}

export interface MockEvent {
  id: string;
  /** The number inside the etag ("3"); bumped by every change. */
  etag: number;
  /** Bumped when the time changes (like Google's sequence). */
  seq: number;
  status: "confirmed" | "cancelled";
  summary: string;
  description: string;
  start: { dateTime: string; timeZone: string };
  end: { dateTime: string; timeZone: string };
  attendees: { email: string; displayName?: string; responseStatus: string }[];
  conference: { requestId: string; status: "success" | "pending" | "failure"; code: string | null; readyAt: number | null } | null;
  created: string;
  updated: string;
  deletedAt: string | null;
  /** Gone for good: reads answer 410. The id can never be inserted again, purged or not. */
  purged: boolean;
  history: string[];
}

export interface MockInvite {
  at: string;
  account: string;
  eventId: string;
  to: string;
  kind: "invite" | "update" | "cancel";
}

export interface MockMail {
  id: string;
  threadId: string;
  at: string;
  /** The Google account whose Gmail sent it. */
  account: string;
  /** Bare addresses, and the decoded header values for display. */
  from: string;
  fromDisplay: string;
  to: string;
  toDisplay: string;
  replyTo: string | null;
  subject: string;
  text: string;
  html: string;
  /** The From address is not the connected account: Gmail would rewrite it (or refuse). */
  fromRewritten: boolean;
}

export interface MockTemplate {
  id: string;
  name: string;
  language: string;
  category: string;
  status: "PENDING" | "APPROVED" | "REJECTED" | "PAUSED" | "DISABLED" | "FLAGGED";
  rejectedReason: string | null;
  body: string;
  examples: string[];
  createdAt: string;
  /** When the review timer decides (null: no timer is running). */
  decideAt: string | null;
  /** What the timer will decide, so a restart can resume it. */
  planned?: { status: "APPROVED" | "REJECTED"; reason: string | null };
}

export interface MockWaba {
  id: string;
  name: string;
  phoneIds: string[];
  /** Meta app ids subscribed to this account's webhooks. */
  subscribedApps: string[];
  templates: Record<string, MockTemplate>;
}

export interface MockPhone {
  id: string;
  wabaId: string;
  display: string;
  verifiedName: string;
  quality: "GREEN";
  registered: boolean;
  pin: string | null;
  wrongAttempts: number;
  lockedUntil: string | null;
}

export interface MockMetaToken {
  appId: string;
  type: "SYSTEM_USER";
  scopes: string[];
  wabaIds: string[];
  /** Unix seconds, or null for a token that never expires. */
  expiresAt: number | null;
  revokedAt: string | null;
  label: string;
}

export interface MockWhatsAppMessage {
  id: string;
  phoneId: string;
  wabaId: string;
  to: string;
  template: string;
  language: string;
  params: string[];
  rendered: string;
  at: string;
  /** The status timeline; `webhook` says how the delivery of that status to the app went. */
  statuses: { status: string; at: string; webhook?: string }[];
}

export interface WebhookLogEntry {
  id: string;
  at: string;
  kind: string;
  attempt: number;
  status: number | null;
  error: string | null;
  bodyPreview: string;
}

export interface FaultSetting {
  value: string;
  once: boolean;
}

export interface RequestLogEntry {
  at: string;
  method: string;
  /** Path and query with secrets redacted. */
  path: string;
  status: number;
  ms: number;
  fault: string | null;
  /** "Bearer MOCK-NOT-REAL-…abcdef", or "Bearer <unknown token, not logged>"; a token the mock did not mint is never recorded. */
  auth: string | null;
  ifMatch: boolean;
}

export interface MockState {
  version: 1;
  createdAt: string;
  google: {
    accounts: Record<string, MockAccount>;
    pendingDecisions: Record<string, PendingDecision>;
    codes: Record<string, AuthCode>;
    grants: Record<string, Grant>;
    refreshTokens: Record<string, string>;
    accessTokens: Record<string, { grantId: string; expiresAt: number }>;
    calendars: Record<string, Record<string, MockEvent>>;
    invites: MockInvite[];
    sentMail: Record<string, MockMail[]>;
  };
  meta: {
    wabas: Record<string, MockWaba>;
    phones: Record<string, MockPhone>;
    tokens: Record<string, MockMetaToken>;
    esCodes: Record<string, { appId: string; wabaId: string; phoneId: string; used: boolean; expiresAt: number }>;
    messages: Record<string, MockWhatsAppMessage>;
  };
  sms: { id: string; at: string; to: string; body: string }[];
  webhooks: { target: string; log: WebhookLogEntry[] };
  requests: RequestLogEntry[];
  activity: { at: string; text: string; link?: string }[];
  faults: Record<string, FaultSetting>;
}

export const REQUEST_LOG_MAX = 300;
export const ACTIVITY_MAX = 500;
export const WEBHOOK_LOG_MAX = 300;

export function emptyState(now = Date.now()): MockState {
  return {
    version: 1,
    createdAt: new Date(now).toISOString(),
    google: {
      accounts: Object.fromEntries(GOOGLE_ACCOUNTS.map((a) => [a.email, { ...a }])),
      pendingDecisions: {},
      codes: {},
      grants: {},
      refreshTokens: {},
      accessTokens: {},
      calendars: {},
      invites: [],
      sentMail: {},
    },
    meta: seedMeta(now),
    sms: [],
    webhooks: { target: "", log: [] },
    requests: [],
    activity: [],
    faults: {},
  };
}

/** The state file used when none is given. In the OS temp directory, so it can never be committed or shipped in an image. */
export function defaultStateFile(): string {
  return path.join(tmpdir(), `session-automation-mock-providers-${userTag()}`, "state.json");
}

/** Who the temp directory belongs to, for its name: the user id where there is one, else the (sanitised) user name. */
export function userTag(): string {
  if (typeof process.getuid === "function") return String(process.getuid());
  try {
    return userInfo().username.replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 64) || "user";
  } catch {
    return "user";
  }
}

/**
 * Makes sure `dir` exists, is a plain directory (not a symlink planted by someone else) and, where the OS has owners, is OURS and
 * closed to others (0700). The state file holds the demo's customer names, emails, phone numbers and messages, and /tmp is shared
 * on Linux and macOS. Throws (refuses) for a directory owned by another user. On Windows the temp directory is already per user.
 */
export function ensurePrivateDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const st = lstatSync(dir);
  if (st.isSymbolicLink() || !st.isDirectory()) throw new Error(`Refusing to use ${dir} for the mock's state: it is not a plain directory.`);
  if (typeof process.getuid === "function") {
    if (st.uid !== process.getuid()) throw new Error(`Refusing to use ${dir} for the mock's state: it belongs to another user.`);
    if ((st.mode & 0o077) !== 0) chmodSync(dir, 0o700);
  }
}

/** True when `file` is inside the OS temp directory (the only place the mock writes). */
export function isInsideTmpdir(file: string): boolean {
  const rel = path.relative(path.resolve(tmpdir()), path.resolve(file));
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/** Loads the saved state, or a fresh one when there is none, it cannot be read, or it is from another version. */
export function loadState(file: string, now = Date.now()): MockState {
  try {
    if (!existsSync(file)) return emptyState(now);
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<MockState>;
    if (parsed.version !== 1 || !parsed.google || !parsed.meta || !parsed.webhooks) return emptyState(now);
    return { ...emptyState(now), ...parsed } as MockState;
  } catch {
    return emptyState(now);
  }
}

export function deleteStateFile(file: string): void {
  rmSync(file, { force: true });
}

/** Writes the state atomically (temp file, then rename), at most once per 200 ms. */
export class Persister {
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly file: string,
    private readonly state: () => MockState,
  ) {}

  schedule(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.write();
    }, 200);
    this.timer.unref();
  }

  write(): void {
    const tmp = `${this.file}.${process.pid}.tmp`;
    try {
      ensurePrivateDir(path.dirname(this.file));
      writeFileSync(tmp, JSON.stringify(this.state()), { mode: 0o600 });
      renameSync(tmp, this.file);
    } catch (e) {
      rmSync(tmp, { force: true });
      console.warn(`[mock] could not save the state file: ${e instanceof Error ? e.message : e}`);
    }
  }

  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.write();
  }
}
