/**
 * Pure helpers for the Google connect / callback routes (app/api/google), kept apart from the routes so they can be
 * tested without a request or a database.
 */

/** Shown on the page the influencer started from, through ?google=<outcome>. Texts live in web/src/components/app/GoogleConnect.tsx. */
export type GoogleOutcome =
  | "connected"
  | "connected-no-gmail"
  | "denied"
  | "missing-permission"
  | "failed"
  | "expired"
  | "not-configured"
  /** The influencer has not saved a Google client of their own (and the site has no shared one for them). */
  | "no-client"
  /** Google rejected the influencer's saved client during the code exchange (deleted in Google Cloud, or its secret changed). */
  | "client-rejected"
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

/** A Google account as far as we know it: the address (can change) and the OpenID `sub` (cannot). Either may be unknown. */
export interface GoogleAccountRef {
  email?: string | null;
  sub?: string | null;
}

/**
 * Whether `next` is another Google account than `current`, and how sure that is.
 *
 * With a `sub` on both sides the answer is exact (`certain`): a renamed address on the same account is NOT a switch, and
 * two accounts are different even if one took over the other's old address. Otherwise it falls back to the address
 * (`isAccountSwitch`), which cannot tell a rename from a switch, so it is not `certain`.
 *
 * `certain` is what a REVOKE must wait for. Google's revoke ends the app's access for the whole Google account, so
 * revoking a token of what turns out to be the same account kills the connection that was just made or is working.
 * `different` alone is enough to ask the influencer to confirm a switch, which is only a question.
 */
export function compareAccounts(current: GoogleAccountRef, next: GoogleAccountRef): { different: boolean; certain: boolean } {
  if (current.sub && next.sub) return { different: current.sub !== next.sub, certain: true };
  return { different: isAccountSwitch(current.email, next.email), certain: false };
}

/**
 * Whether a token of the account `other` that we do not keep may be revoked without hurting the connection on record:
 * nothing is connected at all, or the two are known by `sub` to be different accounts.
 */
export function mayRevokeOther(record: { connected: boolean } & GoogleAccountRef, other: GoogleAccountRef): boolean {
  if (!record.connected) return true;
  const { different, certain } = compareAccounts(record, other);
  return different && certain;
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
