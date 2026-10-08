import "dotenv/config";
import { expireStaleHolds } from "../lib/holds";

const INTERVAL_MS = 30_000;

async function tick() {
  try {
    const n = await expireStaleHolds();
    if (n > 0) console.log(`[worker] expired ${n} stale hold(s)`);
  } catch (e) {
    console.error("[worker] expire-holds failed", e);
  }
}

console.log("[worker] hold expiry running every", INTERVAL_MS / 1000, "s");
void tick();
setInterval(tick, INTERVAL_MS);
