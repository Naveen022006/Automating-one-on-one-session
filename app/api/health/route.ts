import { livenessResponse } from "@/lib/readiness-checks";

// Never prerendered or cached: a stale "ok" would defeat the purpose.
export const dynamic = "force-dynamic";

/** Liveness probe: the process is up. No database, no Redis, nothing that can fail for another reason. */
export function GET() {
  return livenessResponse();
}
