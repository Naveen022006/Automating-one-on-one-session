/**
 * The decision behind the small "Couldn't refresh" notice of QueryGate (./states.tsx), kept pure so it can be tested without
 * a DOM.
 *
 * A page keeps showing the data it already has when a background refetch fails (plan deviation D21: the cache is never thrown
 * away, and nothing unmounts, so a half-typed form or an open drawer survives). That is right, but silent: after "Saved" the
 * screen could show the old values with nothing saying so (finding C7 of doc/10-react-migration-qa-console.md: a 500 from a
 * busy database after a mutation). This says so, without taking anything away. It changes none of the loading and error rules
 * (no data yet: skeleton, 404 screen, error alert) and none of the guard decisions (./guard-decisions.ts).
 *
 *   none      nothing to say: no data yet (the other states handle that), the last fetch worked, or a public customer page
 *             (`framed`), where a failed poll is not something to show a customer
 *   failed    data is on screen, the last refetch failed and nothing is retrying: offer Retry
 *   retrying  the same, and a refetch is under way (Retry was pressed): say so, no second button
 */
export type RefreshNotice = "none" | "failed" | "retrying";

export function refreshNotice(query: { data: unknown; isError: boolean; isFetching: boolean }, opts: { framed?: boolean } = {}): RefreshNotice {
  if (opts.framed || query.data === undefined || !query.isError) return "none";
  return query.isFetching ? "retrying" : "failed";
}

export const REFRESH_FAILED_TEXT = "Couldn't refresh. What you see may be out of date.";
export const REFRESH_RETRYING_TEXT = "Refreshing…";
