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

/** `returnTo` (a same-site path, possibly with a query such as onboarding's ?step=3) with ?google=<outcome> set on it. */
export function outcomeTarget(returnTo: string, outcome: GoogleOutcome): { pathname: string; search: string } {
  const [pathname, query = ""] = returnTo.split("?");
  const params = new URLSearchParams(query);
  params.set("google", outcome);
  return { pathname, search: `?${params}` };
}

/** Whether connecting `next` instead of `current` moves the calendar to a different Google account. Unknown emails never count. */
export function isAccountSwitch(current: string | null | undefined, next: string | null | undefined): boolean {
  return !!current && !!next && current.trim().toLowerCase() !== next.trim().toLowerCase();
}

/**
 * Switching accounts replaces the connection, but Calendar events that already exist (and customers' invites for them)
 * stay on the old account: later reschedules 404, cancels leave the old invite behind and new group attendees cannot be
 * added. So a switch with such bookings needs the influencer's explicit confirmation, which the server checks itself.
 */
export function switchNeedsConfirmation(opts: { liveEvents: number; confirmed: boolean }): boolean {
  return opts.liveEvents > 0 && !opts.confirmed;
}
