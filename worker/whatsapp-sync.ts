import { reportError } from "../lib/observability";
import { WhatsAppConnectError, connectionsAwaitingTemplates, refreshTemplates } from "../lib/whatsapp-connection";
import { singleFlight } from "./monitoring";

/**
 * Backup for Meta's template status webhook. Every 30 minutes, ask Meta about every influencer whose WhatsApp
 * connection still has a template that is not approved (and submit any that are missing), so an approval shows up, and
 * messages start going out over WhatsApp, even when the webhook is not set up or a callback was lost. A connection
 * whose templates are all approved is left alone. Idempotent, so running it on several workers is harmless.
 */

export const SYNC_EVERY_MS = 30 * 60_000;
/** Influencers checked at the same time: Meta rate-limits per app, and each check is two or three calls. */
export const SYNC_CONCURRENCY = 3;

export interface SyncDeps {
  candidates: () => Promise<string[]>;
  refresh: (influencerId: string) => Promise<unknown>;
  concurrency?: number;
}

const defaultDeps: SyncDeps = { candidates: connectionsAwaitingTemplates, refresh: (id) => refreshTemplates(id) };

/** One pass. A failure for one influencer (a dead token, Meta being down) never stops the others. Exported for tests. */
export async function syncWhatsAppTemplates(deps: SyncDeps = defaultDeps): Promise<{ checked: number; failed: number }> {
  const ids = await deps.candidates();
  let next = 0;
  let failed = 0;
  async function lane() {
    while (next < ids.length) {
      const id = ids[next++];
      try {
        await deps.refresh(id);
      } catch (e) {
        failed++;
        // Meta refusing or being unreachable is expected (the influencer is alerted when a token is dead); anything else is a bug.
        if (e instanceof WhatsAppConnectError) console.warn(`[worker] whatsapp template sync: influencer ${id}: ${e.message}`);
        else reportError(e, { where: "worker:whatsapp-template-sync", influencerId: id });
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(deps.concurrency ?? SYNC_CONCURRENCY, ids.length) }, lane));
  return { checked: ids.length, failed };
}

/** Starts the 30-minute template sync. Returns a function that stops it. */
export function startWhatsAppSync(): () => void {
  const run = singleFlight(
    async () => {
      const { checked, failed } = await syncWhatsAppTemplates();
      if (checked > 0) console.log(`[worker] whatsapp template sync: checked ${checked} connection(s), ${failed} failed`);
    },
    { name: "whatsapp-template-sync", onSkip: () => console.warn("[worker] whatsapp template sync is still running; skipping this tick") },
  );
  const first = setTimeout(() => void run(), 2 * 60_000); // let start-up settle (and the database pool free up) first
  const every = setInterval(() => void run(), SYNC_EVERY_MS);
  first.unref(); // the BullMQ workers keep the process alive; this must not
  every.unref();
  console.log(`[worker] whatsapp template sync running every ${SYNC_EVERY_MS / 60_000} min`);
  return () => {
    clearTimeout(first);
    clearInterval(every);
  };
}
