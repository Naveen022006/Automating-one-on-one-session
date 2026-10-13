/**
 * Recovery from a stale deploy (`vite:preloadError`, QA-12). Pure on purpose: the window pieces are passed in so a test can
 * drive it. The event does not name a page, but while a click is being navigated React Router's state holds the target
 * (`router.state.navigation.location`), so the reload can go there instead of back to where the user was.
 */

export interface PreloadRecoveryDeps {
  storage: Pick<Storage, "getItem" | "setItem">;
  now: () => number;
  /** The location a navigation in flight is heading to, or null when none is. */
  pendingTarget: () => { pathname: string; search: string; hash: string } | null;
  reload: () => void;
  assign: (url: string) => void;
}

/** True when the event was handled (the page is about to reload) and the default error screen must be skipped. */
export function recoverFromPreloadError(deps: PreloadRecoveryDeps): boolean {
  try {
    const last = Number(deps.storage.getItem("spa-reloaded-at") ?? 0);
    if (deps.now() - last <= 60_000) return false;
    deps.storage.setItem("spa-reloaded-at", String(deps.now()));
  } catch {
    // Storage unavailable: let the error reach the route's error screen instead of risking a loop.
    return false;
  }
  const t = deps.pendingTarget();
  // Same-origin path only: the router state only ever holds app locations, and "//host" would be a different origin.
  if (t && t.pathname.startsWith("/") && !t.pathname.startsWith("//")) deps.assign(`${t.pathname}${t.search}${t.hash}`);
  else deps.reload();
  return true;
}
