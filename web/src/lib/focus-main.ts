/**
 * The decisions behind "move focus to the new page's `main` after a navigation" (FocusOnNavigate in a11y.tsx), as pure functions so they
 * can be tested without a browser.
 *
 * A `main` that stands in for a page that is still loading (PublicPageFrame, drawn while a profile, a booking or a pay link is being
 * fetched) carries `data-placeholder`. It must never receive the focus: when the data arrives it is replaced by the real page's `main`,
 * the focused element disappears, and the focus falls back to <body>. FocusOnNavigate therefore keeps waiting for a `main` that is not
 * a placeholder.
 */

export const PLACEHOLDER_ATTR = "data-placeholder";

interface HasAttribute {
  hasAttribute(name: string): boolean;
}

export function isPlaceholder(el: HasAttribute | null): boolean {
  return el !== null && el.hasAttribute(PLACEHOLDER_ATTR);
}

/** The element focus may move to: a `main` that is the real page's, or null (nothing yet, or only a loading placeholder). */
export function realMain<T extends HasAttribute>(el: T | null): T | null {
  return el !== null && !isPlaceholder(el) ? el : null;
}

/** How long FocusOnNavigate watches for the real `main`: longer while a loading placeholder is on screen, because data is on its way. */
export const FOCUS_WAIT_MS = 3_000;
export const FOCUS_WAIT_PLACEHOLDER_MS = 10_000;
export function focusWaitMs(current: HasAttribute | null): number {
  return isPlaceholder(current) ? FOCUS_WAIT_PLACEHOLDER_MS : FOCUS_WAIT_MS;
}
