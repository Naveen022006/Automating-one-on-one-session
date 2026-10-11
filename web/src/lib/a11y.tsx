import { useEffect, useRef, useState } from "react";
import { useLocation, useNavigationType } from "react-router";
import { focusWaitMs, realMain } from "./focus-main";

/**
 * The accessibility behaviour Next's App Router gave for free on route changes (doc/10-react-migration-plan.md, F7). All
 * three are mounted once, in RootLayout.
 */

/**
 * Tells screen readers that the page changed: a visually hidden live region announces the new document title after a
 * client-side navigation (Next's "route announcer"). Not on the first load (the browser announces a real page load).
 * The title is read once the new page has set it: right away if it already differs from the previous one, otherwise
 * after the next change of <title>, or after at most 500 ms.
 */
export function RouteAnnouncer() {
  const { pathname } = useLocation();
  const [message, setMessage] = useState("");
  const previousTitle = useRef<string | null>(null);
  const first = useRef(true);

  useEffect(() => {
    if (first.current) {
      first.current = false;
      previousTitle.current = document.title;
      return;
    }
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      observer.disconnect();
      window.clearTimeout(timer);
      previousTitle.current = document.title;
      setMessage(document.title || pathname);
    };
    const observer = new MutationObserver(finish);
    observer.observe(document.head, { childList: true, subtree: true, characterData: true });
    const timer = window.setTimeout(finish, 500);
    const frame = window.requestAnimationFrame(() => {
      if (document.title !== previousTitle.current) finish();
    });
    return () => {
      finished = true;
      observer.disconnect();
      window.clearTimeout(timer);
      window.cancelAnimationFrame(frame);
    };
  }, [pathname]);

  return (
    <div className="sr-only" aria-live="assertive" aria-atomic="true">
      {message}
    </div>
  );
}

/**
 * After a client-side navigation to another PATH, moves keyboard and screen reader focus to the new page's `<main id="main">`
 * (made programmatically focusable with tabIndex=-1; spa.css hides the focus ring on it), so the next Tab starts at the
 * new content and not in the old page's sidebar. Not on the first load, not for back/forward (the browser restores
 * position), not for search-only changes (tabs, filters, pagination keep the user where they are), and not when the URL has
 * a #hash (HashScroller owns that). `#main` is looked up for up to 3 s because data-driven pages render it late (10 s while a
 * loading placeholder's `main` is on screen; a placeholder never gets the focus, see ./focus-main.ts).
 */
export function FocusOnNavigate() {
  const { pathname, hash } = useLocation();
  const navigationType = useNavigationType();
  const previousPath = useRef<string | null>(null);

  useEffect(() => {
    const changed = previousPath.current !== null && previousPath.current !== pathname;
    previousPath.current = pathname;
    if (!changed || navigationType === "POP" || hash) return;

    let done = false;
    // A loading placeholder's `main` (data-placeholder) is skipped: it is replaced when the data arrives, which would drop the focus
    // to <body>. Keep watching for the real one (longer while a placeholder is on screen, see focusWaitMs).
    const focusMain = (): boolean => {
      const main = realMain(document.getElementById("main"));
      if (!main) return false;
      if (!main.hasAttribute("tabindex")) main.setAttribute("tabindex", "-1");
      main.focus({ preventScroll: true });
      return true;
    };
    let observer: MutationObserver | undefined;
    let timer: number | undefined;
    const started = performance.now();
    let waitMs = 0;
    const schedule = () => {
      const wanted = focusWaitMs(document.getElementById("main"));
      if (wanted <= waitMs) return;
      waitMs = wanted;
      if (timer !== undefined) window.clearTimeout(timer);
      timer = window.setTimeout(stop, Math.max(0, wanted - (performance.now() - started)));
    };
    const frame = window.requestAnimationFrame(() => {
      if (focusMain()) return;
      observer = new MutationObserver(() => {
        if (done) return;
        if (focusMain()) stop();
        else schedule();
      });
      observer.observe(document.body, { childList: true, subtree: true });
      schedule();
    });
    function stop() {
      done = true;
      observer?.disconnect();
      if (timer !== undefined) window.clearTimeout(timer);
    }
    return () => {
      window.cancelAnimationFrame(frame);
      stop();
    };
  }, [pathname, hash, navigationType]);

  return null;
}

/**
 * Scrolls to the element a URL's #hash names, also when that element appears late (data-driven pages render their
 * sections after the query resolves, for example `/dashboard/settings#google`). React Router's ScrollRestoration handles
 * a target that already exists; this retries with a MutationObserver for up to 3 s for the rest.
 */
export function HashScroller() {
  const { hash, key } = useLocation();

  useEffect(() => {
    if (!hash) return;
    let id: string;
    try {
      id = decodeURIComponent(hash.slice(1));
    } catch {
      return;
    }
    if (!id) return;
    let done = false;
    const scroll = (): boolean => {
      const el = document.getElementById(id);
      if (!el) return false;
      el.scrollIntoView();
      return true;
    };
    if (scroll()) return;
    const observer = new MutationObserver(() => {
      if (!done && scroll()) stop();
    });
    observer.observe(document.body, { childList: true, subtree: true });
    const timer = window.setTimeout(stop, 3000);
    function stop() {
      done = true;
      observer.disconnect();
      window.clearTimeout(timer);
    }
    return stop;
  }, [hash, key]);

  return null;
}
