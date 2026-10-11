/**
 * Pure helpers for the Google connect / callback routes (app/api/google), kept apart from the routes so they can be
 * tested without a request or a database.
 */

/** Shown on the page the influencer started from, through ?google=<outcome>. Texts live in components/app/GoogleConnect.tsx. */
export type GoogleOutcome =
  | "connected"
  | "connected-no-gmail"
  | "denied"
  | "missing-permission"
  | "failed"
  | "expired"
  | "not-configured"
  | "confirm-switch"
  | "switch-unconfirmed";

/**
 * `returnTo` (a same-site path, possibly with a query such as onboarding's ?step=3 and a #fragment such as Settings' #google)
 * with ?google=<outcome> set on it. The fragment is returned as `hash` (only when there is one), so the callback can put the
 * influencer back at the Google card: the outcome banner is inside that card, far below the fold of the Settings page.
 */
export function outcomeTarget(returnTo: string, outcome: GoogleOutcome): { pathname: string; search: string; hash?: string } {
  const hashAt = returnTo.indexOf("#");
  const path = hashAt === -1 ? returnTo : returnTo.slice(0, hashAt);
  const hash = hashAt === -1 ? "" : returnTo.slice(hashAt);
  const [pathname, query = ""] = path.split("?");
  const params = new URLSearchParams(query);
  params.set("google", outcome);
  return hash.length > 1 ? { pathname, search: `?${params}`, hash } : { pathname, search: `?${params}` };
}

/** Whether connecting `next` instead of `current` moves the calendar to a different Google account. Unknown emails never count. */
export function isAccountSwitch(current: string | null | undefined, next: string | null | undefined): boolean {
  return !!current && !!next && current.trim().toLowerCase() !== next.trim().toLowerCase();
}

/**
 * Switching accounts replaces the connection, but Calendar events that already exist (and customers' invites for them)
 * stay on the old account: later reschedules 404, cancels leave the old invite behind, and a later booking of a group
 * session cannot join the first one's event, so it starts a second Meet on the new calendar. So a switch (or a
 * disconnect, which strands the same events) with such bookings needs the influencer's explicit confirmation, which the
 * server checks itself.
 */
export function switchNeedsConfirmation(opts: { liveEvents: number; confirmed: boolean }): boolean {
  return opts.liveEvents > 0 && !opts.confirmed;
}
