/**
 * The path as written to logs. The pay and manage tokens are bearer secrets (a pay token can mint a manage link, a manage
 * token can cancel a booking) and travel in /api paths that the browser calls on every page load, so a rate-limited
 * request must not log them. The customer portal access token (/api/customer/portal/<token>[/export|/erase]) is a bearer secret too.
 */
export function loggablePath(pathname: string): string {
  return pathname.replace(/^(\/api\/(?:pay|manage|customer\/portal)\/)[^/]+/, "$1:token");
}
