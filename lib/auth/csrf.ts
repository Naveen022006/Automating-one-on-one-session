/**
 * Cross-site request protection for state-changing requests (Phase 7 B2). The session cookie is SameSite=Lax,
 * which already blocks most cross-site POSTs; this adds an explicit origin check so a forged form or fetch from
 * another site is rejected even in older browsers and for non-cookie-authenticated routes (self-service links).
 *
 * A request is accepted when its `Origin` matches the app's own origin (APP_URL or the request host). Browsers
 * always send Origin on cross-origin POST/PUT/PATCH/DELETE; when it is missing we fall back to
 * `Sec-Fetch-Site`. Provider webhooks are server-to-server and authenticated by signature, so they are exempt.
 */

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const EXEMPT_PREFIXES = ["/api/webhooks/"];

export function isCsrfExempt(method: string, pathname: string): boolean {
  return SAFE_METHODS.has(method) || EXEMPT_PREFIXES.some((p) => pathname.startsWith(p));
}

export function allowedOrigins(requestUrl: string, appUrl = process.env.APP_URL): Set<string> {
  const origins = new Set<string>();
  try {
    origins.add(new URL(requestUrl).origin);
  } catch {
    /* ignore */
  }
  if (appUrl) {
    try {
      origins.add(new URL(appUrl).origin);
    } catch {
      /* ignore */
    }
  }
  return origins;
}

/** True when a state-changing request comes from our own pages. */
export function isSameOriginRequest(headers: Headers, requestUrl: string, appUrl = process.env.APP_URL): boolean {
  const origin = headers.get("origin");
  if (origin && origin !== "null") return allowedOrigins(requestUrl, appUrl).has(origin);
  const site = headers.get("sec-fetch-site");
  if (site) return site === "same-origin" || site === "none";
  // No Origin and no Fetch Metadata: not a modern browser cross-site request (curl, server-side tooling).
  // Cookies are SameSite=Lax, so a browser could not attach the session here anyway.
  return true;
}
