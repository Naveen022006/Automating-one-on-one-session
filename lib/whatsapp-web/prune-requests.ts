import { prisma } from "@/lib/db";
import { readQrConfig } from "./config";
import { getKv, kvKeys, type EphemeralKv } from "./kv";
import { digitsOf } from "./prune";

/**
 * "Forget this customer" requests for the linked WhatsApp of an influencer (see lib/whatsapp-web/prune.ts for why). The web process
 * only PUBLISHES a request into a short-lived list in the shared store; the worker, which is the one writer of the stored login,
 * takes the requests and removes the keys inside its own coalesced write. Nothing here touches the login.
 *
 * A request holds the number being forgotten for at most `PRUNE_REQUEST_TTL_MS` (it is taken within seconds while the number is
 * connected, and when the number is not connected the periodic clean-up at the next start does the same). Best effort: it never throws.
 */

export const PRUNE_REQUEST_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface PruneRequest {
  phone: string;
}

/**
 * Publishes one request per number that has NO non-erased booking left with this influencer. Does nothing when the QR mode is off or
 * the influencer has no stored login. Call it after the erasure committed.
 */
export async function requestContactPrune(
  influencerId: string,
  phones: Iterable<string | null | undefined>,
  deps: { kv?: EphemeralKv; enabled?: boolean } = {},
): Promise<number> {
  try {
    if (!(deps.enabled ?? readQrConfig().enabled)) return 0;
    const numbers = [...new Set([...phones].map((p) => digitsOf(p ?? "")).filter((d) => d.length >= 6))];
    if (numbers.length === 0) return 0;
    const stored = await prisma.whatsAppWebSession.count({ where: { influencerId, authStateEnc: { not: null } } });
    if (stored === 0) return 0;
    // A customer with another live booking is still a contact; the periodic clean-up decides later.
    const stillBooked = await prisma.booking.findMany({
      where: { redactedAt: null, whatsappE164: { in: numbers.map((d) => `+${d}`) }, session: { service: { influencerId } } },
      select: { whatsappE164: true },
    });
    const keep = new Set(stillBooked.map((b) => digitsOf(b.whatsappE164)));
    const kv = deps.kv ?? getKv();
    let published = 0;
    for (const phone of numbers) {
      if (keep.has(phone)) continue;
      await kv.rpush(kvKeys.prune(influencerId), JSON.stringify({ phone } satisfies PruneRequest), PRUNE_REQUEST_TTL_MS);
      published += 1;
    }
    return published;
  } catch (e) {
    console.warn(`[whatsapp-web] could not publish a contact clean-up request (${e instanceof Error ? e.name : "error"})`);
    return 0;
  }
}

/** Reads what the worker took from the list. Entries that are not well-formed are ignored. */
export function parsePruneRequests(raw: string[]): string[] {
  const out: string[] = [];
  for (const item of raw) {
    try {
      const phone = (JSON.parse(item) as Partial<PruneRequest>).phone;
      if (typeof phone === "string" && /^\d{6,16}$/.test(phone)) out.push(phone);
    } catch {
      /* ignore */
    }
  }
  return out;
}
