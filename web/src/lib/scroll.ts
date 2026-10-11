/**
 * The key React Router's <ScrollRestoration> saves a scroll position under (sessionStorage, per tab).
 *
 * The default key is `location.key`, and EVERY document the browser loads fresh (typing a URL, `window.location.assign` after login,
 * the absolute links in e-mails and on the confirmation page, a bookmark) starts a history entry whose key is the literal string
 * "default". So all fresh loads in a tab share one saved position: after a full page load the new page opened scrolled to wherever
 * the previous page had been scrolled (the manage page, reached from the confirmation page, or the dashboard after the login form,
 * opened half way down), and `/#faq` typed in a tab that had loaded the landing page before ignored the hash (a saved position, even
 * 0, wins over the hash). Keying those entries by their own URL keeps what a reload needs (the same page comes back to where it
 * was) and gives a different page its top, or its #hash. Entries made by in-app navigation keep their unique key.
 */
export function scrollRestorationKey(location: { key: string; pathname: string; search: string; hash: string }): string {
  return location.key === "default" ? `initial:${location.pathname}${location.search}${location.hash}` : location.key;
}
