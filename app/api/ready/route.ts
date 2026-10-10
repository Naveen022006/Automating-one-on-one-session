import { defaultReadinessDeps, readinessResponse } from "@/lib/health";

export const dynamic = "force-dynamic";

/** Readiness probe: 200 when Postgres (and Redis, if configured) answer quickly, otherwise 503 naming the failed check. */
export function GET() {
  return readinessResponse(defaultReadinessDeps());
}
