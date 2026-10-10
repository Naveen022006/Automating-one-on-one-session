/**
 * Only same-site relative paths are allowed as post-login redirects (no open redirect). Control characters and
 * backslashes are rejected outright (browsers strip tabs/newlines and treat "\\" as "/", which turns "/\t/evil.com"
 * or "/\\evil.com" into a protocol-relative URL), and the result must resolve to this app's own origin.
 *
 * Pure and client-safe (no imports): the server (lib/http.ts re-exports it, so route handlers keep their import) and
 * the SPA's route guards (web/src/lib/guards.tsx) use this one implementation, so the open-redirect rules live in one
 * place.
 */
export function safeNextPath(next: unknown, fallback = "/dashboard"): string {
  if (typeof next !== "string" || next.length > 500) return fallback;
  if (!next.startsWith("/") || /[\u0000-\u001f\u007f\\]/.test(next)) return fallback;
  const base = "https://app.invalid";
  try {
    const url = new URL(next, base);
    if (url.origin !== base) return fallback;
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return fallback;
  }
}
