import { NextResponse } from "next/server";

/**
 * Response helper for every JSON "view" endpoint the SPA reads (doc/10-react-migration-plan.md, sections 1.7 and 2.8).
 *
 * Rules it enforces, so the endpoints cannot each get them wrong:
 *   - `Cache-Control: private, no-store`: the bodies contain personal data and are different per viewer; no browser
 *     cache, shared cache or CDN may keep them.
 *   - the body is a JSON OBJECT, never a top-level array (an array body is the classic JSON-hijacking shape and cannot
 *     grow a field without breaking every client);
 *   - no CORS header is ever set (the SPA is same-origin; the proxy's Origin check protects state-changing methods).
 *
 * What goes into `data` is the caller's responsibility and the biggest risk of the migration: server components only
 * ever sent rendered markup, a JSON endpoint sends whatever it is given. Build the object field by field from what the
 * page renders (never spread a Prisma row), and call assertNoSecretKeys() from tests/helpers in the endpoint's test.
 */
export function jsonView<T extends object>(data: T, init: { status?: number } = {}): NextResponse {
  if (Array.isArray(data)) throw new Error("jsonView: the response body must be an object, not an array");
  return NextResponse.json(data, { status: init.status ?? 200, headers: { "Cache-Control": "private, no-store" } });
}
