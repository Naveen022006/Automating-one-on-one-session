import { alertInfluencer } from "../lib/alerts";
import { prisma } from "../lib/db";
import { GoogleReconnectError, google } from "../lib/google";
import type { GoogleClientKind, GoogleGrantRef } from "../lib/google-credentials";
import { getActiveGrant, markReconnectNeeded } from "../lib/google-tokens";
import { reportError, reportNotice } from "../lib/observability";

/**
 * Daily check of every influencer's Google connection. Until now a revoked or expired grant was only noticed when a
 * paid booking's create-meeting job ran, so the booking page kept taking money in the meantime. Refresh tokens of an
 * OAuth app in Testing mode expire after 7 days, which makes this routine rather than rare.
 *
 * Each ACTIVE token is exchanged for an access token (the cheapest call that proves the grant is alive). Only Google
 * answering invalid_grant (GoogleReconnectError) marks a connection RECONNECT_NEEDED, with the same helper and alert
 * lib/meeting.ts uses, so the page goes offline and the influencer is told once. The flag only lands if the grant is still
 * the one that was read (an influencer who reconnected while Google was being asked keeps the new connection). Anything else (network down, Google 5xx,
 * a wrong client secret of ours, an unreadable stored token) is "unknown": logged, never held against the influencer.
 */

export const GOOGLE_HEALTH_EVERY_MS = 24 * 60 * 60_000;
/** First run shortly after start-up, once the database pool has settled, so a worker restart does not wait a day. */
export const GOOGLE_HEALTH_FIRST_RUN_MS = 2 * 60_000;
/** Refreshes in flight at once: a few, so a big influencer list neither takes forever nor hammers Google or the pool. */
export const GOOGLE_HEALTH_CONCURRENCY = 4;

export type RefreshVerdict = "dead" | "unknown";

/** What a failed refresh means. Pure. Only "Google says the grant is gone" kills a connection; a transient error never does. */
export function verdictForRefreshError(e: unknown): RefreshVerdict {
  return e instanceof GoogleReconnectError ? "dead" : "unknown";
}

/** The grant being checked and the version of it that was read (its `connectedAt`, which changes when it is renewed). */
export interface Grant {
  refreshToken: string;
  connectedAt: Date;
  /** Which OAuth client issued the grant: the refresh must use that one (doc/15). */
  clientKind: GoogleClientKind;
}

export interface GoogleHealthDeps {
  /** Influencers whose connection is currently ACTIVE. */
  listActive(): Promise<string[]>;
  /** The grant to check, or null when it is gone or already flagged since the list was read. */
  load(influencerId: string): Promise<Grant | null>;
  /** Resolves when Google accepts the refresh token, throws what the Google client throws otherwise. */
  refresh(refreshToken: string, grant: GoogleGrantRef): Promise<void>;
  /**
   * Flags the connection for reconnect, but only if it is still the grant that was checked (`connectedAt` unchanged): an
   * influencer who reconnected while Google was being asked keeps their new connection. True only for the call that
   * flipped ACTIVE -> RECONNECT_NEEDED (dedupes the alert).
   */
  markDead(influencerId: string, reason: string, connectedAt: Date): Promise<boolean>;
  alert(influencerId: string, reason: string): Promise<void>;
  concurrency?: number;
}

export interface GoogleHealthSummary {
  checked: number;
  ok: number;
  /** Connections that were gone or already flagged by the time they were looked at. */
  skipped: number;
  dead: number;
  unknown: number;
  alerted: number;
  /** First message of an "unknown" failure, for the log. */
  lastError: string | null;
}

/** One pass over every ACTIVE connection with bounded concurrency. Exported for tests and for a manual one-off run. */
export async function checkGoogleConnections(deps: GoogleHealthDeps): Promise<GoogleHealthSummary> {
  const ids = await deps.listActive();
  const summary: GoogleHealthSummary = { checked: ids.length, ok: 0, skipped: 0, dead: 0, unknown: 0, alerted: 0, lastError: null };
  const unknown = (e: unknown) => {
    summary.unknown++;
    summary.lastError ??= e instanceof Error ? e.message : String(e);
  };

  let next = 0;
  const lane = async () => {
    for (let i = next++; i < ids.length; i = next++) {
      const id = ids[i];
      let grant: Grant | null;
      try {
        grant = await deps.load(id);
      } catch (e) {
        unknown(e); // e.g. the stored token cannot be decrypted: ours to fix, not the influencer's
        continue;
      }
      if (!grant) {
        summary.skipped++;
        continue;
      }
      try {
        await deps.refresh(grant.refreshToken, { influencerId: id, clientKind: grant.clientKind });
        summary.ok++;
      } catch (e) {
        if (verdictForRefreshError(e) === "unknown") {
          unknown(e);
          continue;
        }
        const reason = e instanceof Error ? e.message : String(e);
        try {
          const flipped = await deps.markDead(id, reason, grant.connectedAt);
          summary.dead++;
          if (flipped) {
            await deps.alert(id, reason);
            summary.alerted++;
          }
        } catch (markError) {
          // Could not record it (database hiccup): the next daily run, or a paid booking's job, finds it again.
          unknown(markError);
        }
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(deps.concurrency ?? GOOGLE_HEALTH_CONCURRENCY, ids.length)) }, lane));
  return summary;
}

const defaultDeps: GoogleHealthDeps = {
  listActive: async () => {
    const rows = await prisma.googleToken.findMany({ where: { status: "ACTIVE" }, select: { influencerId: true }, orderBy: { updatedAt: "asc" } });
    return rows.map((r) => r.influencerId);
  },
  load: getActiveGrant,
  refresh: async (refreshToken, grant) => {
    await google.refreshAccessToken(refreshToken, grant);
  },
  markDead: markReconnectNeeded,
  alert: (influencerId, reason) =>
    alertInfluencer(influencerId, {
      kind: "google-reconnect-needed",
      detail: `Google stopped accepting the connection (${reason}). Reconnect it: your booking page stays offline and paid bookings wait for their Meet link until you do.`,
    }),
};

/** The scheduled job: run the check, log the outcome, never throw. */
export async function googleHealthTick(deps: GoogleHealthDeps = defaultDeps): Promise<GoogleHealthSummary> {
  const s = await checkGoogleConnections(deps);
  if (s.dead > 0) console.log(`[worker] google health: ${s.dead} of ${s.checked} connection(s) need to reconnect, ${s.alerted} influencer(s) alerted`);
  if (s.unknown > 0) {
    console.warn(`[worker] google health: could not check ${s.unknown} of ${s.checked} connection(s): ${s.lastError}`);
    // Every single check failing without a verdict points at us (client secret, network, Google outage), not at the influencers.
    if (s.ok === 0 && s.dead === 0) {
      reportNotice("warn", `Google connection check could not verify any of ${s.checked} connection(s): ${s.lastError}`, { where: "google-health" });
    }
  }
  return s;
}

/** Starts the daily check (and one shortly after start-up). Returns a function that stops it. */
export function startGoogleHealth(check: () => Promise<unknown> = googleHealthTick): () => void {
  // Runs whatever the environment says: each grant is checked with the client that issued it (an influencer's own client lives in the
  // database, doc/15), so there is no platform pair to wait for. A grant whose client cannot be found is a "dead" verdict for an own
  // client and an "unknown" one for the platform pair, which is how the pair being unset still shows up in the log below.
  let running = false;
  const run = async () => {
    if (running) return; // the previous pass is still going; never overlap
    running = true;
    try {
      await check();
    } catch (e) {
      reportError(e, { where: "worker:google-health" });
    } finally {
      running = false;
    }
  };
  const first = setTimeout(() => void run(), GOOGLE_HEALTH_FIRST_RUN_MS);
  const daily = setInterval(() => void run(), GOOGLE_HEALTH_EVERY_MS);
  first.unref(); // the BullMQ workers keep the process alive; these must not
  daily.unref();
  console.log(`[worker] Google connection check running every ${GOOGLE_HEALTH_EVERY_MS / 3_600_000} h`);
  return () => {
    clearTimeout(first);
    clearInterval(daily);
  };
}
