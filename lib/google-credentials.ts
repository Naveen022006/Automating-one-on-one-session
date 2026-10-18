import { decryptSecret, encryptSecret } from "@/lib/crypto";
import { prisma } from "@/lib/db";

/**
 * Which Google OAuth client an influencer's Google calls use (doc/15-influencer-google-credentials.md).
 *
 * There are two kinds of client:
 *   "own"       the influencer's own Google Cloud OAuth client, pasted on their Settings page (influencer_google_clients). The
 *               secret is AES-256-GCM encrypted with AAD `google-client:<influencerId>` and never leaves the server.
 *   "platform"  the platform-wide GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET pair, only when GOOGLE_CLIENT_MODE allows it.
 *
 * ONE function decides (`getGoogleCredentials`). A grant remembers the kind it was issued with (google_tokens.client_kind) and every
 * refresh, health check and token exchange for it uses exactly that client. Nothing here ever falls back from one influencer's
 * client to another's, or from an influencer's client to the platform pair: a missing client is a result the caller turns into
 * "reconnect needed", not a different client.
 */

export type GoogleClientKind = "own" | "platform";
export type GoogleClientMode = "own" | "platform" | "either";
type EnvRecord = Record<string, string | undefined>;

export interface GoogleCredentials {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

/** The grant a Google call is made for: whose it is and which client issued it. */
export interface GoogleGrantRef {
  influencerId: string;
  clientKind: GoogleClientKind;
}

/** Narrows a stored or untrusted value to a client kind. Unknown values are "platform", the kind rows had before this existed. */
export function toClientKind(value: string | null | undefined): GoogleClientKind {
  return value === "own" ? "own" : "platform";
}

/** The AAD the client secret is encrypted with (also used by the key-rotation tool, lib/key-rotation-db.ts). */
export const googleClientAad = (influencerId: string) => `google-client:${influencerId}`;

/**
 * GOOGLE_CLIENT_MODE: "own" (the default: every influencer brings their own client), "platform" (the env pair only) or "either"
 * (the influencer's own client when saved, else the env pair). Empty or unrecognised means the default; lib/env.ts reports a bad value.
 */
export function googleClientMode(env: EnvRecord = process.env): GoogleClientMode {
  const v = (env.GOOGLE_CLIENT_MODE ?? "").trim().toLowerCase();
  return v === "platform" || v === "either" ? v : "own";
}

/** The one callback URL every influencer adds to their own client. GOOGLE_REDIRECT_URI when set, else `${APP_URL}/api/google/callback`. */
export function googleRedirectUri(env: EnvRecord = process.env): string {
  const explicit = env.GOOGLE_REDIRECT_URI;
  if (explicit) return explicit;
  return `${(env.APP_URL || "http://localhost:3000").replace(/\/$/, "")}/api/google/callback`;
}

/** The platform-wide client from the environment, or null when either half is missing. */
export function platformGoogleCredentials(env: EnvRecord = process.env): GoogleCredentials | null {
  const clientId = env.GOOGLE_CLIENT_ID;
  const clientSecret = env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret, redirectUri: googleRedirectUri(env) };
}

export type CredentialFailure = "no-own-client" | "no-platform-client" | "no-client" | "unreadable";

export type CredentialResult =
  | { ok: true; kind: GoogleClientKind; credentials: GoogleCredentials }
  | { ok: false; reason: CredentialFailure; message: string };

/** Plain-English reasons, stored as the "reconnect needed" reason and shown to the influencer. */
export const CREDENTIAL_FAILURE_MESSAGES: Record<CredentialFailure, string> = {
  "no-own-client": "Your Google client was removed or is no longer valid. Save your Google client again, then reconnect.",
  "no-platform-client": "This site no longer has a shared Google app. Create your own Google client in Settings, then connect.",
  "no-client": "No Google client is set up yet. Create your own Google client in Settings, then connect.",
  unreadable: "Your saved Google client could not be read. Save your Google client again, then reconnect.",
};

const fail = (reason: CredentialFailure): CredentialResult => ({ ok: false, reason, message: CREDENTIAL_FAILURE_MESSAGES[reason] });

export interface CredentialDeps {
  env: EnvRecord;
  loadOwn(influencerId: string): Promise<{ clientId: string; clientSecretEnc: string } | null>;
  decrypt(payload: string, aad: string): string;
}

const defaultDeps: CredentialDeps = {
  get env() {
    return process.env;
  },
  loadOwn: (influencerId) =>
    prisma.influencerGoogleClient.findUnique({ where: { influencerId }, select: { clientId: true, clientSecretEnc: true } }),
  decrypt: (payload, aad) => decryptSecret(payload, aad),
};

async function ownCredentials(influencerId: string, deps: CredentialDeps): Promise<CredentialResult | null> {
  const row = await deps.loadOwn(influencerId);
  if (!row) return null;
  try {
    return {
      ok: true,
      kind: "own",
      credentials: { clientId: row.clientId, clientSecret: deps.decrypt(row.clientSecretEnc, googleClientAad(influencerId)), redirectUri: googleRedirectUri(deps.env) },
    };
  } catch {
    return fail("unreadable");
  }
}

/**
 * The credentials to use for `influencerId`.
 *
 * `kind` given: the client an existing grant was issued with. "own" needs that influencer's saved client (whatever the mode is: a grant
 * made with it must be refreshed with it), "platform" needs the env pair.
 * `kind` omitted: a NEW connection. The mode decides: "own" the influencer's client only, "platform" the env pair only, "either" the
 * influencer's client when saved, else the env pair.
 */
export async function getGoogleCredentials(influencerId: string, kind?: GoogleClientKind, deps: CredentialDeps = defaultDeps): Promise<CredentialResult> {
  const platform = (): CredentialResult => {
    const c = platformGoogleCredentials(deps.env);
    return c ? { ok: true, kind: "platform", credentials: c } : fail(kind ? "no-platform-client" : "no-client");
  };
  if (kind === "own") return (await ownCredentials(influencerId, deps)) ?? fail("no-own-client");
  if (kind === "platform") return platform();
  const mode = googleClientMode(deps.env);
  if (mode === "platform") return platform();
  const own = await ownCredentials(influencerId, deps);
  if (own) return own;
  return mode === "either" ? platform() : fail("no-own-client");
}

/* ---------- the saved client (what the Settings card shows and edits) ---------- */

/** What may be shown: the client ID (not secret) and when Google last accepted the pair. Never the secret. */
export interface SavedGoogleClient {
  clientId: string;
  checkedAt: Date;
}

export async function getSavedGoogleClient(influencerId: string): Promise<SavedGoogleClient | null> {
  return prisma.influencerGoogleClient.findUnique({ where: { influencerId }, select: { clientId: true, checkedAt: true } });
}

/** Stores (or replaces) the influencer's client. Only call it after `verifyGoogleClient` accepted the pair. */
export async function saveGoogleClient(influencerId: string, clientId: string, clientSecret: string, checkedAt: Date = new Date()): Promise<void> {
  const clientSecretEnc = encryptSecret(clientSecret, googleClientAad(influencerId));
  await prisma.influencerGoogleClient.upsert({
    where: { influencerId },
    create: { influencerId, clientId, clientSecretEnc, checkedAt },
    update: { clientId, clientSecretEnc, checkedAt },
  });
}

/** True when a client was deleted. */
export async function deleteGoogleClient(influencerId: string): Promise<boolean> {
  const { count } = await prisma.influencerGoogleClient.deleteMany({ where: { influencerId } });
  return count > 0;
}

/** "123456-abcdwxyz.apps.googleusercontent.com" -> "…wxyz": the activity log keeps a masked tail, never the whole ID or the secret. */
export function maskClientId(clientId: string): string {
  const stem = clientId.replace(/\.apps\.googleusercontent\.com$/i, "");
  return stem.length > 4 ? `…${stem.slice(-4)}` : "…";
}
