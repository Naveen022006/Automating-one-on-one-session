/**
 * The path as written to logs. The pay and manage tokens are bearer secrets (a pay token can mint a manage link, a manage
 * token can cancel a booking) and travel in /api paths that the browser calls on every page load, so a rate-limited
 * request must not log them.
 */
export function loggablePath(pathname: string): string {
  return pathname.replace(/^(\/api\/(?:pay|manage)\/)[^/]+/, "$1:token");
}
